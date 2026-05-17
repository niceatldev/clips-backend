import path from 'path';
import { copyFile, mkdir, symlink } from 'fs/promises';
import { pool } from '../index.js';
import {
  assertBuiltinFontAvailable,
  BUILTIN_BUNDLED_FONTS,
  buildClipWords,
  cleanupDir,
  createFontsDir,
  ensureDir,
  execFileAsync,
  hookPathForClip,
  localHookPath,
  localOutputPath,
  outputPathForClip,
  pushFileToVps,
  resolveBuiltinFontFamily,
  resolveSourcePath,
  tempWorkspace,
  writeJson,
  type ClipRow,
  type FontRow,
  type SourceRow,
  type TemplateConfig,
  type Word
} from './shared.js';
import { generateAss } from './ass.js';
import { renderHookPng } from './hook.js';

const getVideoFilter = (aspect: TemplateConfig['output']['aspect']) => {
  if (aspect === '1:1') {
    return 'crop=ih:ih,scale=1080:1080';
  }
  if (aspect === '16:9') {
    return 'scale=1920:1080';
  }
  return 'crop=ih*9/16:ih,scale=1080:1920';
};

const escapeFfmpegFilterValue = (value: string) =>
  `'${value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "'\\''")
    .replaceAll(':', '\\:')}'`;

const resolveFontContext = async (template: TemplateConfig): Promise<{
  captionFamily: string;
  captionFont: FontRow | null;
  hookFamily: string;
  hookFont: FontRow | null;
  fontRows: FontRow[];
}> => {
  const fontIds = [template.caption.font_id, template.hook.font_id].filter((fontId) => !fontId.startsWith('builtin:'));
  if (fontIds.length === 0) {
    return {
      captionFamily: resolveBuiltinFontFamily(template.caption.font_id),
      captionFont: null,
      hookFamily: resolveBuiltinFontFamily(template.hook.font_id),
      hookFont: null,
      fontRows: []
    };
  }

  const result = await pool.query<FontRow>('SELECT * FROM fonts WHERE id = ANY($1::int[])', [fontIds.map((value) => Number(value))]);
  const byId = new Map<string, FontRow>(result.rows.map((row: FontRow) => [String(row.id), row]));
  const captionFont = byId.get(template.caption.font_id) ?? null;
  const hookFont = byId.get(template.hook.font_id) ?? null;

  if (!template.caption.font_id.startsWith('builtin:') && !captionFont) {
    throw new Error(`Caption font ${template.caption.font_id} is missing from the fonts table`);
  }

  if (!template.hook.font_id.startsWith('builtin:') && !hookFont) {
    throw new Error(`Hook font ${template.hook.font_id} is missing from the fonts table`);
  }

  return {
    captionFamily: captionFont?.name ?? resolveBuiltinFontFamily(template.caption.font_id),
    captionFont,
    hookFamily: hookFont?.name ?? resolveBuiltinFontFamily(template.hook.font_id),
    hookFont,
    fontRows: result.rows
  };
};

const failClip = async (clipId: number, error: unknown) => {
  await pool.query(`UPDATE clips SET status = 'failed', error = $1, updated_at = NOW() WHERE id = $2`, [
    error instanceof Error ? error.message : String(error),
    clipId
  ]);
};

export const renderClip = async (clip: ClipRow) => {
  // Validate before claiming workspace so we always land in 'failed' on bad input.
  if (!clip.spec) {
    await failClip(clip.id, `Clip ${clip.id} is missing a spec snapshot`);
    throw new Error(`Clip ${clip.id} is missing a spec snapshot`);
  }

  const [sourceResult] = await Promise.all([
    pool.query<SourceRow>('SELECT * FROM sources WHERE id = $1', [clip.source_id])
  ]);
  const source = sourceResult.rows[0];
  if (!source) {
    await failClip(clip.id, `Source ${clip.source_id} not found`);
    throw new Error(`Source ${clip.source_id} not found`);
  }
  if (!source.words?.length) {
    await failClip(clip.id, `Source ${clip.source_id} has no transcript words`);
    throw new Error(`Source ${clip.source_id} has no transcript words`);
  }

  const workspace = await tempWorkspace(`clip-${clip.id}`);
  // localOutputPath / localHookPath: where this worker physically writes files.
  // On VPS these equal the canonical paths. On Mac they point to LOCAL_DATA_DIR
  // so the Docker volume isn't needed, then files are pushed to the VPS server.
  const localOut = localOutputPath(clip.id);
  const localHook = localHookPath(clip.id);
  const canonicalOutputPath = outputPathForClip(clip.id);
  const canonicalHookPath = hookPathForClip(clip.id);
  const template = clip.spec;

  try {
    const trimmedPath = path.join(workspace, 'trimmed.mp4');
    const wordsJsonPath = path.join(workspace, 'words.json');
    const assPath = path.join(workspace, 'clip.ass');
    const hookPngPath = path.join(workspace, 'hook.png');
    const sourcePath = await resolveSourcePath(source, workspace);
    const clipWords = buildClipWords(source.words, clip);
    const fontContext = await resolveFontContext(template);
    const fontsDir = await createFontsDir(workspace, fontContext.fontRows);

    // For bundled builtin fonts, skip fc-match and symlink the TTF into fontsdir
    // so libass can find them without a system-wide fontconfig install.
    const builtinFontsDir = path.resolve(process.cwd(), 'templates/fonts');
    for (const [fontId, filename] of Object.entries(BUILTIN_BUNDLED_FONTS)) {
      if (template.caption.font_id === fontId || template.hook.font_id === fontId) {
        const src = path.join(builtinFontsDir, filename);
        const dst = path.join(fontsDir, filename);
        try { await symlink(src, dst); } catch { /* already exists */ }
      }
    }

    await Promise.all([
      (fontContext.captionFont || template.caption.font_id in BUILTIN_BUNDLED_FONTS)
        ? Promise.resolve()
        : assertBuiltinFontAvailable(fontContext.captionFamily),
      (fontContext.hookFont || template.hook.font_id in BUILTIN_BUNDLED_FONTS)
        ? Promise.resolve()
        : assertBuiltinFontAvailable(fontContext.hookFamily)
    ]);

    await writeJson(wordsJsonPath, { words: clipWords });
    await generateAss({
      wordsJsonPath,
      outputAssPath: assPath,
      template,
      fontFamily: fontContext.captionFamily
    });

    await renderHookPng({
      template,
      hookText: clip.hook_text ?? '',
      outputPngPath: hookPngPath,
      workspace,
      fontFamily: fontContext.hookFamily,
      fontRow: fontContext.hookFont
    });

    await execFileAsync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-ss',
      String(clip.in_seconds),
      '-to',
      String(clip.out_seconds),
      '-i',
      sourcePath,
      '-vf',
      getVideoFilter(template.output.aspect),
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      String(template.output.crf),
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      trimmedPath
    ]);

    await ensureDir(path.dirname(localOut));
    await ensureDir(path.dirname(localHook));

    const clipDuration = Math.max(0, clip.out_seconds - clip.in_seconds);
    const hookStart = clip.hook_visible?.start ?? 0;
    const hookEnd = clip.hook_visible?.end ?? clipDuration;

    await execFileAsync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      trimmedPath,
      '-i',
      hookPngPath,
      '-filter_complex',
      `[0:v]subtitles=filename=${escapeFfmpegFilterValue(assPath)}:fontsdir=${escapeFfmpegFilterValue(fontsDir)}[v];[v][1:v]overlay=0:0:enable='between(t,${hookStart},${hookEnd})'`,
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      String(template.output.crf),
      '-c:a',
      'copy',
      '-movflags',
      '+faststart',
      localOut
    ]);

    await copyFile(hookPngPath, localHook);

    // Push rendered files to VPS server if running remotely (Mac worker).
    // On VPS, pushFileToVps is a no-op (VPS_CLIPS_URL not set).
    await Promise.all([
      pushFileToVps(clip.id, localOut, 'output'),
      pushFileToVps(clip.id, localHook, 'hook')
    ]);

    await pool.query(
      `UPDATE clips
       SET status = 'done', output_path = $1, error = NULL, updated_at = NOW()
       WHERE id = $2`,
      [canonicalOutputPath, clip.id]
    );
  } catch (error) {
    await failClip(clip.id, error);
    throw error;
  } finally {
    await cleanupDir(workspace);
  }
};
