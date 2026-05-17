import path from 'path';
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

export const execFileAsync = promisify(execFile);

export type Word = {
  start: number;
  end: number;
  text: string;
};

export type TemplateConfig = {
  name: string;
  caption: {
    font_id: string;
    font_size: number;
    color: string;
    highlight_color: string;
    italic: boolean;
    max_chars_per_line: number;
    max_lines: number;
    position: 'upper-third' | 'center' | 'lower-third';
    margin_v: number;
    outline_px: number;
    shadow_px: number;
    spacing?: number;
    line_spacing?: number;
  };
  hook: {
    font_id: string;
    font_size: number;
    text_color: string;
    pill_color: string;
    position_y_pct: number;
  };
  output: {
    aspect: '9:16' | '1:1' | '16:9';
    crf: number;
    width: number;
    height: number;
  };
};

export type SourceRow = {
  id: number;
  filename: string;
  storage_path: string;
  duration: number | null;
  status: string;
  words: Word[] | null;
  error: string | null;
  created_at: string;
};

export type ClipRow = {
  id: number;
  source_id: number;
  template_id: number | null;
  in_seconds: number;
  out_seconds: number;
  hook_text: string | null;
  hook_visible: { start: number; end: number } | null;
  spec: TemplateConfig | null;
  clip_type: 'short' | 'youtube_long';
  signal_caption: string | null;
  suggested_titles: string[] | null;
  status: 'pending' | 'rendering' | 'done' | 'failed';
  output_path: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type FontRow = {
  id: number;
  template_id: number;
  name: string;
  filename: string;
  storage_path: string;
  created_at: string;
};

export const DATA_DIR = process.env.DATA_DIR || '/data';
// LOCAL_DATA_DIR is where this worker actually writes files.
// On VPS this equals DATA_DIR. On Mac it's ~/clips-data while DATA_DIR=/data
// so paths stored in DB always match the VPS server's canonical layout.
export const LOCAL_DATA_DIR = process.env.LOCAL_DATA_DIR || DATA_DIR;
export const WHISPER_MODEL = process.env.WHISPER_MODEL || 'medium.en';
export const VPS_CLIPS_URL = process.env.VPS_CLIPS_URL || '';
export const WORKER_SECRET = process.env.WORKER_SECRET || '';
export const FONT_ROOT = path.join(LOCAL_DATA_DIR, 'fonts');

export const tempWorkspace = async (name: string) => mkdtemp(path.join(tmpdir(), `${name}-`));

export const ensureDir = (target: string) => mkdir(target, { recursive: true });
export const cleanupDir = (target: string) => rm(target, { recursive: true, force: true });
export const fileExists = (target: string) => existsSync(target);
export const writeJson = (target: string, value: unknown) => writeFile(target, JSON.stringify(value, null, 2), 'utf8');
export const readTemplate = (target: string) => readFile(target, 'utf8');

// Canonical paths — stored in DB, served by VPS server (always DATA_DIR based)
export const outputPathForClip = (clipId: number) => path.join(DATA_DIR, 'outputs', String(clipId), 'output.mp4');
export const hookPathForClip = (clipId: number) => path.join(DATA_DIR, 'hooks', String(clipId), 'hook.png');
export const transcriptPathForSource = (sourceId: number) => path.join(DATA_DIR, 'transcripts', String(sourceId), 'words.json');

// Local paths — where this worker physically writes files (differs on Mac)
export const localOutputPath = (clipId: number) => path.join(LOCAL_DATA_DIR, 'outputs', String(clipId), 'output.mp4');
export const localHookPath = (clipId: number) => path.join(LOCAL_DATA_DIR, 'hooks', String(clipId), 'hook.png');
export const localTranscriptPath = (sourceId: number) => path.join(LOCAL_DATA_DIR, 'transcripts', String(sourceId), 'words.json');

// Translate a canonical DATA_DIR path to the LOCAL_DATA_DIR equivalent.
const toLocalPath = (p: string): string => {
  if (LOCAL_DATA_DIR === DATA_DIR) return p;
  if (p.startsWith(DATA_DIR + '/') || p === DATA_DIR) {
    return LOCAL_DATA_DIR + p.slice(DATA_DIR.length);
  }
  return p;
};

// Fetch a source file from VPS if it doesn't exist locally.
export const resolveSourcePath = async (source: SourceRow, workspace: string): Promise<string> => {
  if (fileExists(source.storage_path)) return source.storage_path;
  // Check LOCAL_DATA_DIR equivalent (Mac worker: ~/clips-data/sources/… vs canonical /data/sources/…)
  const localEquivalent = toLocalPath(source.storage_path);
  if (localEquivalent !== source.storage_path && fileExists(localEquivalent)) return localEquivalent;
  if (!VPS_CLIPS_URL) throw new Error(`Source file not found locally and VPS_CLIPS_URL not set: ${source.storage_path}`);
  const ext = path.extname(source.filename) || '.mp4';
  const localPath = path.join(workspace, `source${ext}`);
  const url = `${VPS_CLIPS_URL}/files/sources/${source.id}/master${ext}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch source from VPS (${resp.status}): ${url}`);
  const { writeFile: wf } = await import('node:fs/promises');
  await wf(localPath, Buffer.from(await resp.arrayBuffer()));
  return localPath;
};

// Upload a rendered file to the VPS clips server so it can serve it.
export const pushFileToVps = async (clipId: number, localPath: string, type: 'output' | 'hook'): Promise<void> => {
  if (!VPS_CLIPS_URL) return;
  const { readFile } = await import('node:fs/promises');
  const data = await readFile(localPath);
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
  if (WORKER_SECRET) headers['x-worker-secret'] = WORKER_SECRET;
  const resp = await fetch(`${VPS_CLIPS_URL}/api/clips/${clipId}/${type}`, {
    method: 'PUT',
    headers,
    body: data
  });
  if (!resp.ok) throw new Error(`Failed to push ${type} to VPS (${resp.status})`);
};

export const hexToAssBgr = (hex: string) => {
  const h = hex.replace('#', '').padStart(6, '0');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H00${b}${g}${r}&`.toUpperCase();
};

// Builtin fonts that are bundled in templates/fonts/ — skip fc-match for these;
// they are loaded directly from disk by Chromium (hook) or symlinked into fontsdir (captions).
export const BUILTIN_BUNDLED_FONTS: Record<string, string> = {
  'builtin:highest': 'Highest.ttf',
  'builtin:verdana-bold-italic': 'VerdanaBoldItalic.ttf',
};

export const resolveBuiltinFontFamily = (fontId: string) => {
  switch (fontId) {
    case 'builtin:anton':
      return 'Anton';
    case 'builtin:black-ops-one':
      return 'Black Ops One';
    case 'builtin:bebas-neue':
      return 'Bebas Neue';
    case 'builtin:oswald':
      return 'Oswald';
    case 'builtin:open-sans-extrabold':
      return 'OpenSansEB';
    case 'builtin:highest':
      return 'Highest';
    case 'builtin:verdana-bold-italic':
      return 'Verdana';
    case 'builtin:system-ui':
      return 'system-ui';
    default:
      return fontId;
  }
};

const normalizeFontName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

export const assertBuiltinFontAvailable = async (fontFamily: string) => {
  if (fontFamily === 'system-ui') {
    return;
  }

  const { stdout } = await execFileAsync('fc-match', ['-f', '%{family[0]}', '--', fontFamily]);
  const matchedFamily = stdout.trim();

  if (!matchedFamily || normalizeFontName(matchedFamily) !== normalizeFontName(fontFamily)) {
    throw new Error(`Required builtin font "${fontFamily}" is not installed in the worker image`);
  }
};

export const buildClipWords = (sourceWords: Word[], clip: ClipRow) =>
  sourceWords
    .filter((word) => word.end >= clip.in_seconds && word.start <= clip.out_seconds)
    .map((word) => ({
      start: Math.max(0, Number((word.start - clip.in_seconds).toFixed(3))),
      end: Math.min(Number((clip.out_seconds - clip.in_seconds).toFixed(3)), Number((word.end - clip.in_seconds).toFixed(3))),
      text: word.text
    }));

export const createFontsDir = async (workspace: string, fonts: FontRow[]) => {
  const target = path.join(workspace, 'fonts');
  await ensureDir(target);

  for (const font of fonts) {
    const linkPath = path.join(target, path.basename(font.storage_path));
    if (!fileExists(linkPath)) {
      await symlink(font.storage_path, linkPath);
    }
  }

  return target;
};
