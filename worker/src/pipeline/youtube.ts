import path from 'path';
import { writeFile } from 'fs/promises';
import { pool } from '../index.js';
import {
  cleanupDir,
  ensureDir,
  execFileAsync,
  localOutputPath,
  outputPathForClip,
  pushFileToVps,
  resolveSourcePath,
  tempWorkspace,
  type ClipRow,
  type SourceRow,
  type Word,
} from './shared.js';

const SCRIPTS_DIR = path.resolve(import.meta.dirname, '../../scripts/youtube');
const PYTHON = process.env.PYTHON_BIN || 'python3';

const failClip = async (clipId: number, error: unknown) => {
  await pool.query(`UPDATE clips SET status = 'failed', error = $1, updated_at = NOW() WHERE id = $2`, [
    error instanceof Error ? error.message : String(error),
    clipId,
  ]);
};

const wordsToSrt = async (words: Word[], srtPath: string): Promise<void> => {
  const wordsJsonPath = srtPath.replace(/\.srt$/, '.words.json');
  await writeFile(wordsJsonPath, JSON.stringify(words));
  await execFileAsync(PYTHON, [
    path.join(SCRIPTS_DIR, 'words_to_srt.py'),
    wordsJsonPath,
    srtPath,
  ]);
};

const locateMoment = async (
  srtPath: string,
  signalCaption: string,
  targetMinSec = 360,
  targetMaxSec = 600,
): Promise<{ in_sec: number; out_sec: number; confidence: number; match_phrase: string }> => {
  const { stdout } = await execFileAsync(PYTHON, [
    path.join(SCRIPTS_DIR, 'locate_moment.py'),
    '--srt', srtPath,
    '--caption', signalCaption,
    '--min-sec', String(targetMinSec),
    '--max-sec', String(targetMaxSec),
  ]);
  const result = JSON.parse(stdout.trim());
  if (result.error) throw new Error(`Locator error: ${result.error}`);
  return {
    in_sec: result.in_sec,
    out_sec: result.out_sec,
    confidence: result.confidence,
    match_phrase: result.match_phrase,
  };
};

export const renderYoutubeLongClip = async (clip: ClipRow) => {
  const [sourceResult] = await Promise.all([
    pool.query<SourceRow>('SELECT * FROM sources WHERE id = $1', [clip.source_id]),
  ]);
  const source = sourceResult.rows[0];
  if (!source) {
    await failClip(clip.id, `Source ${clip.source_id} not found`);
    throw new Error(`Source ${clip.source_id} not found`);
  }
  if (!source.words?.length) {
    await failClip(clip.id, `Source ${clip.source_id} has no transcript — transcribe first`);
    throw new Error(`Source ${clip.source_id} has no transcript`);
  }

  const workspace = await tempWorkspace(`yt-${clip.id}`);
  const localOut = localOutputPath(clip.id);
  const canonicalOutputPath = outputPathForClip(clip.id);

  try {
    const sourcePath = await resolveSourcePath(source, workspace);
    const srtPath = path.join(workspace, 'transcript.srt');

    let inSec = Number(clip.in_seconds);
    let outSec = Number(clip.out_seconds);

    // If a signal caption is provided and in/out aren't pre-set by user, run the locator.
    // Pre-set means the clip was created with explicit in_seconds/out_seconds (0/0 = not set).
    if (clip.signal_caption && inSec === 0 && outSec === 0) {
      await wordsToSrt(source.words, srtPath);
      const located = await locateMoment(srtPath, clip.signal_caption);
      inSec = located.in_sec;
      outSec = located.out_sec;
      await pool.query(
        'UPDATE clips SET in_seconds = $1, out_seconds = $2 WHERE id = $3',
        [inSec, outSec, clip.id],
      );
    }

    if (outSec <= inSec) {
      throw new Error(`Invalid in/out: ${inSec} → ${outSec}`);
    }

    await ensureDir(path.dirname(localOut));

    await execFileAsync('ffmpeg', [
      '-y',
      '-loglevel', 'error',
      '-ss', String(inSec),
      '-to', String(outSec),
      '-i', sourcePath,
      '-vf', 'scale=1920:1080',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      localOut,
    ]);

    await pushFileToVps(clip.id, localOut, 'output');

    await pool.query(
      `UPDATE clips SET status = 'done', output_path = $1, error = NULL, updated_at = NOW() WHERE id = $2`,
      [canonicalOutputPath, clip.id],
    );
  } catch (error) {
    await failClip(clip.id, error);
    throw error;
  } finally {
    await cleanupDir(workspace);
  }
};
