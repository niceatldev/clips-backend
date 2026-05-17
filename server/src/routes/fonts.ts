import { Router } from 'express';
import multer from 'multer';
import { query } from '../db.js';
import { fontFilePath, removePath, saveBuffer } from '../storage.js';
import type { FontRow } from '../types.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/:id/fonts', upload.single('font'), async (req, res) => {
  const templateId = Number(req.params.id);
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'Font file is required' });
  }

  const templateCheck = await query('SELECT id FROM templates WHERE id = $1', [templateId]);
  if (templateCheck.rowCount === 0) {
    return res.status(404).json({ error: 'Template not found' });
  }

  const inserted = await query<FontRow>(
    `INSERT INTO fonts (template_id, name, filename, storage_path)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [templateId, file.originalname.replace(/\.[^.]+$/, ''), file.originalname, 'pending']
  );

  const storagePath = fontFilePath(inserted.rows[0].id, file.originalname);
  await saveBuffer(storagePath, file.buffer);

  const updated = await query<FontRow>(
    `UPDATE fonts SET storage_path = $1 WHERE id = $2 RETURNING *`,
    [storagePath, inserted.rows[0].id]
  );

  res.json({
    font_id: String(updated.rows[0].id),
    name: updated.rows[0].name
  });
});

router.delete('/:id/fonts/:fid', async (req, res) => {
  const fontId = Number(req.params.fid);
  const result = await query<FontRow>('DELETE FROM fonts WHERE id = $1 RETURNING *', [fontId]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Font not found' });
  }

  await removePath(result.rows[0].storage_path);
  res.json({ ok: true });
});

export default router;
