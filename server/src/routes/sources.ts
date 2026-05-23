import { Router } from 'express';
import path from 'path';
import multer from 'multer';
import { copyFile, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { query } from '../db.js';
import {
  hookPngPath,
  outputVideoPath,
  removePath,
  resolveStoragePath,
  saveBuffer,
  saveRequestStream,
  sourceMasterPath,
  transcriptWordsPath
} from '../storage.js';
import type { ClipRow, Source, SourceRow } from '../types.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const router = Router();
const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      const target = path.join(tmpdir(), 'clips-upload-staging');
      await mkdir(target, { recursive: true });
      cb(null, target);
    }
  })
});
const execFileAsync = promisify(execFile);

const mapSource = (row: SourceRow): Source => ({
  id: String(row.id),
  filename: row.filename,
  duration: row.duration,
  status: row.status,
  words: row.words ?? undefined,
  error: row.error,
  created_at: row.created_at
});

const probeDuration = async (filePath: string) => {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    const parsed = Number.parseFloat(stdout.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// Register a video that lives on the Mac worker's local disk (not on the VPS).
// Returns canonical storage_path so the caller can:
//   1. symlink ~/clips-data/<canonical_path relative to /data> → actual file
//   2. POST /api/sources/:id/transcribe to queue transcription
// Status starts as 'awaiting-link' so the worker does not pick it up prematurely.
router.post('/register-prelinked', async (req, res) => {
  const { filename } = req.body as { filename?: string };
  const fname = filename || 'episode.mp4';
  const ext = path.extname(fname) || '.mp4';

  const inserted = await query<SourceRow>(
    `INSERT INTO sources (filename, storage_path, status) VALUES ($1, '', 'awaiting-link') RETURNING id`,
    [fname]
  );
  const id = inserted.rows[0].id;
  const canonicalPath = `/data/sources/${id}/master${ext}`;
  await query('UPDATE sources SET storage_path = $1 WHERE id = $2', [canonicalPath, id]);

  res.json({ source_id: String(id), canonical_path: canonicalPath });
});

// Register a video file that already exists on disk — no upload needed.
// The worker will transcribe it automatically.
router.post('/register', async (req, res) => {
  const { file_path, filename } = req.body as { file_path: string; filename?: string };

  if (!file_path) {
    return res.status(400).json({ error: 'file_path is required' });
  }
  if (!existsSync(resolveStoragePath(file_path))) {
    return res.status(400).json({ error: `File not found at path: ${file_path}` });
  }

  const fname = filename || path.basename(file_path);
  const duration = await probeDuration(resolveStoragePath(file_path));

  const result = await query<SourceRow>(
    `INSERT INTO sources (filename, storage_path, duration, status)
     VALUES ($1, $2, $3, 'transcribing-pending')
     RETURNING *`,
    [fname, file_path, duration]
  );

  res.json({ source_id: String(result.rows[0].id) });
});

router.post('/', async (req, res) => {
  const filename = String(req.body.filename || 'master.mp4');
  const inserted = await query<SourceRow>(
    `INSERT INTO sources (filename, storage_path, status)
     VALUES ($1, $2, 'uploading')
     RETURNING *`,
    [filename, 'pending']
  );

  const storagePath = sourceMasterPath(inserted.rows[0].id, filename);
  await query('UPDATE sources SET storage_path = $1 WHERE id = $2', [storagePath, inserted.rows[0].id]);

  res.json({
    upload_url: `/api/uploads/sources/${inserted.rows[0].id}`,
    source_id: String(inserted.rows[0].id)
  });
});

router.put('/:id', async (req, res) => {
  const sourceId = Number(req.params.id);
  const result = await query<SourceRow>('SELECT * FROM sources WHERE id = $1', [sourceId]);
  const source = result.rows[0];
  if (!source) {
    return res.status(404).json({ error: 'Source not found' });
  }

  await saveRequestStream(source.storage_path, req);
  const duration = await probeDuration(resolveStoragePath(source.storage_path));
  await query('UPDATE sources SET duration = $1 WHERE id = $2', [duration, sourceId]);
  res.status(204).end();
});

router.post('/upload', upload.single('file'), async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Direct multipart source upload is disabled in production. Use the signed upload flow.' });
  }

  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'Video file is required' });
  }

  const inserted = await query<SourceRow>(
    `INSERT INTO sources (filename, storage_path, status)
     VALUES ($1, $2, 'uploading')
     RETURNING *`,
    [file.originalname, 'pending']
  );

  const storagePath = sourceMasterPath(inserted.rows[0].id, file.originalname);
  await copyFile(file.path, storagePath);
  await unlink(file.path);
  const duration = await probeDuration(storagePath);
  await query('UPDATE sources SET storage_path = $1, duration = $2 WHERE id = $3', [
    storagePath,
    duration,
    inserted.rows[0].id
  ]);

  res.json({ source_id: String(inserted.rows[0].id) });
});

router.get('/', async (_req, res) => {
  const result = await query<SourceRow>(
    'SELECT id, filename, storage_path, duration, status, NULL AS words, error, created_at FROM sources ORDER BY created_at DESC'
  );
  res.json(result.rows.map(mapSource));
});

router.get('/:id', async (req, res) => {
  const result = await query<SourceRow>(
    'SELECT id, filename, storage_path, duration, status, words, error, created_at FROM sources WHERE id = $1',
    [Number(req.params.id)]
  );
  const source = result.rows[0];
  if (!source) {
    return res.status(404).json({ error: 'Source not found' });
  }
  res.json(mapSource(source));
});

router.get('/:id/file', async (req, res) => {
  const result = await query<SourceRow>('SELECT * FROM sources WHERE id = $1', [Number(req.params.id)]);
  const source = result.rows[0];
  if (!source) {
    return res.status(404).json({ error: 'Source not found' });
  }
  res.sendFile(resolveStoragePath(source.storage_path));
});

router.get('/dev/:id/video', async (req, res) => {
  const result = await query<SourceRow>('SELECT * FROM sources WHERE id = $1', [Number(req.params.id)]);
  const source = result.rows[0];
  if (!source) {
    return res.status(404).json({ error: 'Source not found' });
  }
  res.sendFile(resolveStoragePath(source.storage_path));
});

router.post('/:id/purge-file', async (req, res) => {
  const sourceId = Number(req.params.id);
  const result = await query<SourceRow>('SELECT * FROM sources WHERE id = $1', [sourceId]);
  const source = result.rows[0];
  if (!source) {
    return res.status(404).json({ error: 'Source not found' });
  }

  await removePath(path.dirname(source.storage_path));
  res.json({ ok: true, source_id: String(source.id) });
});

router.delete('/:id', async (req, res) => {
  const sourceId = Number(req.params.id);
  const clipResult = await query<ClipRow>('SELECT * FROM clips WHERE source_id = $1', [sourceId]);
  const result = await query<SourceRow>('DELETE FROM sources WHERE id = $1 RETURNING *', [sourceId]);
  const source = result.rows[0];
  if (!source) {
    return res.status(404).json({ error: 'Source not found' });
  }

  await Promise.all([
    removePath(path.dirname(source.storage_path)),
    removePath(path.dirname(transcriptWordsPath(source.id))),
    ...clipResult.rows.flatMap((clip) => [
      removePath(path.dirname(outputVideoPath(clip.id))),
      removePath(path.dirname(hookPngPath(clip.id)))
    ])
  ]);
  res.json({ ok: true });
});

router.post('/:id/transcribe', async (req, res) => {
  const result = await query<SourceRow>(
    `UPDATE sources
     SET status = 'transcribing-pending', error = NULL
     WHERE id = $1
     RETURNING *`,
    [Number(req.params.id)]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Source not found' });
  }

  res.json({ ok: true, status: 'transcribing' });
});

// Locate a viral moment — returns source words so the BCE server can
// forward them to the Mac Mini worker which runs the Python locator.
// BCE server handles the actual locate call (POST /api/sources/:id/locate
// in bce/server/index.js → Mac Mini /locate endpoint).
router.get('/:id/words', async (req, res) => {
  const result = await query<SourceRow>('SELECT id, words FROM sources WHERE id = $1', [Number(req.params.id)]);
  const source = result.rows[0];
  if (!source) return res.status(404).json({ error: 'Source not found' });
  if (!source.words?.length) return res.status(400).json({ error: 'Source has no transcript yet' });
  res.json({ words: source.words });
});

export default router;
