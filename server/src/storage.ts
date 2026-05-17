import path from 'path';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { createWriteStream, existsSync } from 'fs';
import { pipeline } from 'stream/promises';

const DATA_DIR = process.env.DATA_DIR || '/data';

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
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2), 'utf8');
};

export const readJson = async <T>(target: string) => JSON.parse(await readFile(target, 'utf8')) as T;

export const saveBuffer = async (target: string, data: Buffer) => {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
};

export const saveRequestStream = async (target: string, input: NodeJS.ReadableStream) => {
  await mkdir(path.dirname(target), { recursive: true });
  await pipeline(input, createWriteStream(target));
};

export const removePath = async (target: string) => {
  await rm(target, { recursive: true, force: true });
};

export const fileExists = (target: string) => existsSync(target);

export const publicOutputUrl = (clipId: number) => `/files/outputs/${clipId}/output.mp4`;
