import { Router } from 'express';
import { query } from '../db.js';
import type { FontRow, Template, TemplateRow } from '../types.js';

const router = Router();

const defaultTemplateConfig = {
  name: 'Default',
  caption: {
    font_id: 'builtin:anton',
    font_size: 96,
    color: '#FFFFFF',
    highlight_color: '#58604f',
    italic: true,
    max_chars_per_line: 18,
    max_lines: 2,
    position: 'lower-third',
    margin_v: 240,
    outline_px: 4,
    shadow_px: 0
  },
  hook: {
    font_id: 'builtin:anton',
    font_size: 110,
    text_color: '#FFFFFF',
    pill_color: '#7d8a72d9',
    position_y_pct: 46
  },
  output: {
    aspect: '9:16' as const,
    crf: 20,
    width: 1080,
    height: 1920
  }
};

const attachFonts = (template: TemplateRow, fonts: FontRow[]): Template => ({
  id: String(template.id),
  ...template.config,
  name: template.name,
  fonts: fonts
    .filter((font) => font.template_id === template.id)
    .map((font) => ({
      font_id: String(font.id),
      name: font.name
    }))
});

router.get('/', async (_req, res) => {
  const [templateResult, fontResult] = await Promise.all([
    query<TemplateRow>('SELECT * FROM templates ORDER BY created_at DESC'),
    query<FontRow>('SELECT * FROM fonts ORDER BY created_at ASC')
  ]);

  res.json(templateResult.rows.map((row: TemplateRow) => attachFonts(row, fontResult.rows)));
});

router.post('/', async (req, res) => {
  const config = {
    ...defaultTemplateConfig,
    ...(req.body ?? {}),
    name: req.body?.name ?? `Template ${Date.now()}`
  };

  const result = await query<TemplateRow>(
    `INSERT INTO templates (name, config, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     RETURNING *`,
    [config.name, JSON.stringify({ ...config, name: config.name })]
  );

  res.json({
    id: String(result.rows[0].id),
    ...result.rows[0].config,
    name: result.rows[0].name,
    fonts: []
  });
});

router.get('/:id', async (req, res) => {
  const templateId = Number(req.params.id);
  const [templateResult, fontResult] = await Promise.all([
    query<TemplateRow>('SELECT * FROM templates WHERE id = $1', [templateId]),
    query<FontRow>('SELECT * FROM fonts WHERE template_id = $1 ORDER BY created_at ASC', [templateId])
  ]);

  const template = templateResult.rows[0];
  if (!template) {
    return res.status(404).json({ error: 'Template not found' });
  }

  res.json(attachFonts(template, fontResult.rows));
});

router.put('/:id', async (req, res) => {
  const templateId = Number(req.params.id);
  const payload = req.body as Template;
  const result = await query<TemplateRow>(
    `UPDATE templates
     SET name = $1, config = $2::jsonb, updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [payload.name, JSON.stringify({ ...payload, id: undefined, fonts: undefined }), templateId]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Template not found' });
  }

  const fonts = await query<FontRow>('SELECT * FROM fonts WHERE template_id = $1 ORDER BY created_at ASC', [templateId]);
  res.json(attachFonts(result.rows[0], fonts.rows));
});

router.delete('/:id', async (req, res) => {
  const templateId = Number(req.params.id);
  const result = await query('DELETE FROM templates WHERE id = $1', [templateId]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Template not found' });
  }
  res.json({ ok: true });
});

export default router;
