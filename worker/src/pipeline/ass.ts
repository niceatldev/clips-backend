import path from 'path';
import { execFileAsync, hexToAssBgr, type TemplateConfig } from './shared.js';

export const CAPTION_FONT_SCALE = 0.8;
export const CAPTION_LINE_SPACING_SCALE = 0.85;
export const CAPTION_MIN_CHARS_PER_LINE = 24;
export const CAPTION_MAX_LINES = 1;
export const CAPTION_EFFECTIVE_MARGIN_V = 200;

export const generateAss = async ({
  wordsJsonPath,
  outputAssPath,
  template,
  fontFamily
}: {
  wordsJsonPath: string;
  outputAssPath: string;
  template: TemplateConfig;
  fontFamily: string;
}) => {
  await execFileAsync('python3', [
    path.resolve(process.cwd(), 'scripts/words_to_ass.py'),
    wordsJsonPath,
    outputAssPath,
    String(Math.max(template.caption.max_chars_per_line, CAPTION_MIN_CHARS_PER_LINE)),
    String(Math.min(template.caption.max_lines, CAPTION_MAX_LINES)),
    fontFamily,
    String(Math.max(1, Math.round(template.caption.font_size * CAPTION_FONT_SCALE))),
    hexToAssBgr(template.caption.color),
    hexToAssBgr(template.caption.highlight_color),
    template.caption.italic ? '1' : '0',
    String(Math.min(template.caption.margin_v, CAPTION_EFFECTIVE_MARGIN_V)),
    String(template.caption.spacing ?? 0),
    String((template.caption.line_spacing ?? 1.3) * CAPTION_LINE_SPACING_SCALE)
  ]);
};
