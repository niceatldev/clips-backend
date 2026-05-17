import { Router } from 'express';
import path from 'path';
import type { Request, Response, NextFunction } from 'express';
import { query } from '../db.js';
import { hookPngPath, outputVideoPath, publicOutputUrl, removePath, saveRequestStream } from '../storage.js';
import { mkdir } from 'node:fs/promises';
import type { Clip, ClipRow, CreateClipPayload, SourceRow, TemplateRow } from '../types.js';

const WORKER_SECRET = process.env.WORKER_SECRET || '';

const requireWorkerSecret = (req: Request, res: Response, next: NextFunction) => {
  if (!WORKER_SECRET) return next();
  if (req.headers['x-worker-secret'] !== WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

const router = Router();

const mapClip = (row: ClipRow): Clip => ({
  id: String(row.id),
  source_id: String(row.source_id),
  template_id: row.template_id ? String(row.template_id) : null,
  in: row.in_seconds,
  out: row.out_seconds,
  hook_text: row.hook_text ?? '',
  hook_visible: row.hook_visible,
  clip_type: row.clip_type,
  signal_caption: row.signal_caption,
  suggested_titles: row.suggested_titles,
  status: row.status,
  output_url: row.output_path ? `/api/clips/${row.id}/output` : undefined,
  error: row.error,
  created_at: row.created_at,
  updated_at: row.updated_at,
  spec: row.spec ? { id: row.template_id ? String(row.template_id) : '', ...row.spec } : undefined
});

router.post('/', async (req, res) => {
  const payload = req.body as CreateClipPayload;
  const sourceId = Number(payload.source_id);
  const templateId = Number(payload.template_id);

  if (!Number.isFinite(payload.in) || !Number.isFinite(payload.out) || payload.out <= payload.in) {
    return res.status(400).json({ error: 'Clip in/out timestamps are invalid' });
  }

  const [sourceResult, templateResult] = await Promise.all([
    query<SourceRow>('SELECT * FROM sources WHERE id = $1', [sourceId]),
    query<TemplateRow>('SELECT * FROM templates WHERE id = $1', [templateId])
  ]);

  if (!sourceResult.rows[0]) {
    return res.status(404).json({ error: 'Source not found' });
  }
  if (!templateResult.rows[0]) {
    return res.status(404).json({ error: 'Template not found' });
  }

  const template = templateResult.rows[0];
  const spec = {
    ...template.config,
    name: template.name,
    output: {
      ...template.config.output,
      aspect: payload.aspect ?? template.config.output.aspect
    }
  };

  const result = await query<ClipRow>(
    `INSERT INTO clips (source_id, template_id, in_seconds, out_seconds, hook_text, hook_visible, spec, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'pending', NOW())
     RETURNING *`,
    [
      sourceId,
      templateId,
      payload.in,
      payload.out,
      payload.hook_text,
      JSON.stringify(payload.hook_visible ?? { start: 0, end: Math.max(payload.out - payload.in, 0) }),
      JSON.stringify(spec)
    ]
  );

  res.json({ id: String(result.rows[0].id), status: result.rows[0].status });
});

// Create a YouTube long-form clip (16:9, no captions, 6-10 min).
// in/out can be pre-set (from /locate preview) or left at 0 to auto-locate at render time.
router.post('/youtube', async (req, res) => {
  const { source_id, signal_caption, in: inSec, out: outSec, suggested_titles } = req.body as {
    source_id: string;
    signal_caption?: string;
    in?: number;
    out?: number;
    suggested_titles?: string[];
  };

  const sourceId = Number(source_id);
  if (!Number.isFinite(sourceId)) return res.status(400).json({ error: 'source_id is required' });

  const sourceResult = await query<SourceRow>('SELECT id FROM sources WHERE id = $1', [sourceId]);
  if (!sourceResult.rows[0]) return res.status(404).json({ error: 'Source not found' });

  const resolvedIn = Number(inSec) || 0;
  const resolvedOut = Number(outSec) || 0;

  const result = await query<ClipRow>(
    `INSERT INTO clips
       (source_id, clip_type, signal_caption, in_seconds, out_seconds, suggested_titles, status, updated_at)
     VALUES ($1, 'youtube_long', $2, $3, $4, $5::jsonb, 'pending', NOW())
     RETURNING *`,
    [
      sourceId,
      signal_caption ?? null,
      resolvedIn,
      resolvedOut,
      suggested_titles ? JSON.stringify(suggested_titles) : null,
    ],
  );

  res.json({ id: String(result.rows[0].id), status: result.rows[0].status });
});

router.get('/', async (_req, res) => {
  const result = await query<ClipRow>('SELECT * FROM clips ORDER BY created_at DESC');
  res.json(result.rows.map(mapClip));
});

router.get('/:id', async (req, res) => {
  const result = await query<ClipRow>('SELECT * FROM clips WHERE id = $1', [Number(req.params.id)]);
  const clip = result.rows[0];
  if (!clip) {
    return res.status(404).json({ error: 'Clip not found' });
  }
  res.json(mapClip(clip));
});

router.get('/:id/output', async (req, res) => {
  const result = await query<ClipRow>('SELECT * FROM clips WHERE id = $1', [Number(req.params.id)]);
  const clip = result.rows[0];
  if (!clip || !clip.output_path) {
    return res.status(404).json({ error: 'Output not found' });
  }

  res.redirect(302, publicOutputUrl(clip.id));
});

// Receive rendered output from Mac worker and save to the Docker volume.
router.put('/:id/output', requireWorkerSecret, async (req, res) => {
  const clipId = Number(req.params.id);
  const result = await query<ClipRow>('SELECT id FROM clips WHERE id = $1', [clipId]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Clip not found' });
  const dest = outputVideoPath(clipId);
  await mkdir(path.dirname(dest), { recursive: true });
  await saveRequestStream(dest, req);
  res.status(204).end();
});

router.put('/:id/hook', requireWorkerSecret, async (req, res) => {
  const clipId = Number(req.params.id);
  const result = await query<ClipRow>('SELECT id FROM clips WHERE id = $1', [clipId]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Clip not found' });
  const dest = hookPngPath(clipId);
  await mkdir(path.dirname(dest), { recursive: true });
  await saveRequestStream(dest, req);
  res.status(204).end();
});

router.post('/:id/render', async (req, res) => {
  const result = await query<ClipRow>(
    `UPDATE clips
     SET status = 'pending', error = NULL, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [Number(req.params.id)]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Clip not found' });
  }

  res.json({ ok: true, status: 'rendering' });
});

router.delete('/:id', async (req, res) => {
  const result = await query<ClipRow>('DELETE FROM clips WHERE id = $1 RETURNING *', [Number(req.params.id)]);
  const clip = result.rows[0];
  if (!clip) {
    return res.status(404).json({ error: 'Clip not found' });
  }

  if (clip.output_path) {
    await removePath(path.dirname(clip.output_path));
  }
  await removePath(path.dirname(hookPngPath(clip.id)));
  res.json({ ok: true });
});

export default router;
