import path from 'path';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { createWriteStream, existsSync } from 'fs';
import { pipeline } from 'stream/promises';

const DATA_DIR = process.env.DATA_DIR || '/data';
const CANONICAL_DATA_DIR = '/data';

export const paths = {
  dataDir: DATA_DIR,
  sources: path.join(DATA_DIR, 'sources'),
  transcripts: path.join(DATA_DIR, 'transcripts'),
  outputs: path.join(DATA_DIR, 'outputs'),
  hooks: path.join(DATA_DIR, 'hooks'),
  fonts: path.join(DATA_DIR, 'fonts'),
  tmp: path.join(DATA_DIR, 'tmp')
};

export const ensureStorageLayout = async () => {
  await Promise.all(Object.values(paths).map((target) => mkdir(target, { recursive: true })));
};

export const resolveStoragePath = (target: string) => {
  if (DATA_DIR === CANONICAL_DATA_DIR) return target;
  if (target === CANONICAL_DATA_DIR) return DATA_DIR;
  if (target.startsWith(`${CANONICAL_DATA_DIR}/`)) {
    return path.join(DATA_DIR, target.slice(CANONICAL_DATA_DIR.length + 1));
  }
  return target;
};

export const sanitizeFilename = (filename: string) => filename.replace(/[^a-zA-Z0-9._-]+/g, '-');

export const sourceMasterPath = (sourceId: number, filename: string) =>
  path.join(paths.sources, String(sourceId), `master${path.extname(filename) || '.mp4'}`);

export const transcriptWordsPath = (sourceId: number) =>
  path.join(paths.transcripts, String(sourceId), 'words.json');

export const outputVideoPath = (clipId: number) =>
  path.join(paths.outputs, String(clipId), 'output.mp4');

export const hookPngPath = (clipId: number) =>
  path.join(paths.hooks, String(clipId), 'hook.png');

export const fontFilePath = (fontId: number, filename: string) =>
  path.join(paths.fonts, String(fontId), sanitizeFilename(filename));

export const tempJobDir = async (prefix: string, id: number) => {
  const target = path.join(paths.tmp, `${prefix}-${id}-${Date.now()}`);
  await mkdir(target, { recursive: true });
  return target;
};

export const writeJson = async (target: string, value: unknown) => {
  target = resolveStoragePath(target);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2), 'utf8');
};

export const readJson = async <T>(target: string) => JSON.parse(await readFile(resolveStoragePath(target), 'utf8')) as T;

export const saveBuffer = async (target: string, data: Buffer) => {
  target = resolveStoragePath(target);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
};

export const saveRequestStream = async (target: string, input: NodeJS.ReadableStream) => {
  target = resolveStoragePath(target);
  await mkdir(path.dirname(target), { recursive: true });
  await pipeline(input, createWriteStream(target));
};

export const removePath = async (target: string) => {
  await rm(resolveStoragePath(target), { recursive: true, force: true });
};

export const fileExists = (target: string) => existsSync(resolveStoragePath(target));

export const publicOutputUrl = (clipId: number) => `/files/outputs/${clipId}/output.mp4`;
