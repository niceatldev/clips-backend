import path from 'path';
import { execFileAsync, hexToAssBgr, type TemplateConfig } from './shared.js';

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
    String(template.caption.max_chars_per_line),
    String(template.caption.max_lines),
    fontFamily,
    String(template.caption.font_size),
    hexToAssBgr(template.caption.color),
    hexToAssBgr(template.caption.highlight_color),
    template.caption.italic ? '1' : '0',
    String(template.caption.margin_v),
    String(template.caption.spacing ?? 0),
    String(template.caption.line_spacing ?? 1.3)
  ]);
};
