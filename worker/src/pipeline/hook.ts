import path from 'path';
import { readFile, symlink, writeFile } from 'fs/promises';
import { execFileAsync, type FontRow, type TemplateConfig } from './shared.js';

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const splitToTwoLines = (text: string): string => {
  const words = text.split(/\s+/);
  if (words.length <= 1) return escapeHtml(text);

  // Find split point that balances char counts across 2 lines
  const totalChars = words.reduce((s, w) => s + w.length, 0);
  const target = totalChars / 2;
  let best = 1;
  let bestDiff = Infinity;
  let running = 0;
  for (let i = 0; i < words.length - 1; i++) {
    running += words[i].length;
    const diff = Math.abs(running - target);
    if (diff < bestDiff) { bestDiff = diff; best = i + 1; }
  }

  const line1 = escapeHtml(words.slice(0, best).join(' '));
  const line2 = escapeHtml(words.slice(best).join(' '));
  return line1 + '<br>' + line2;
};



const createFontFaceCss = async (font: FontRow | null, family: string, workspace: string) => {
  if (!font) {
    return '';
  }

  const localFilename = path.basename(font.storage_path);
  const localFontPath = path.join(workspace, localFilename);
  await symlink(font.storage_path, localFontPath);

  return `@font-face {
  font-family: '${family}';
  src: url('./${localFilename}') format('truetype');
  font-display: swap;
}`;
};

export const renderHookPng = async ({
  template,
  hookText,
  outputPngPath,
  workspace,
  fontFamily,
  fontRow
}: {
  template: TemplateConfig;
  hookText: string;
  outputPngPath: string;
  workspace: string;
  fontFamily: string;
  fontRow: FontRow | null;
}) => {
  const templatePath = path.resolve(process.cwd(), 'templates/hook.html');
  const htmlPath = path.join(workspace, 'hook.html');
  const baseTemplate = await readFile(templatePath, 'utf8');
  const fontFaceCss = await createFontFaceCss(fontRow, fontFamily, workspace);

  // Symlink bundled fonts so Chromium can load them via file://
  const templatesDir = path.resolve(process.cwd(), 'templates');
  const builtinFontsDir = path.join(templatesDir, 'fonts');
  for (const fname of ['OpenSans-ExtraBold.woff2', 'OpenSans-ExtraBold.ttf', 'Highest.ttf']) {
    const src = path.join(builtinFontsDir, fname);
    const dst = path.join(workspace, fname);
    try { await symlink(src, dst); } catch { /* already exists */ }
  }

  // Symlink logo so Chromium can load it via file://
  const logoSrc = path.join(templatesDir, 'logo.png');
  const logoDst = path.join(workspace, 'logo.png');
  try { await symlink(logoSrc, logoDst); } catch { /* already exists */ }
  // Derive bottom anchor from caption settings so pill always sits just above captions
  // regardless of how many lines the hook text wraps to
  const captionBottom = 1920 - (template.caption?.margin_v ?? 250);
  const captionBlockHeight = (template.caption?.max_lines ?? 3) * (template.caption?.font_size ?? 64) * (template.caption?.line_spacing ?? 1.3);
  const captionTop = Math.round(captionBottom - captionBlockHeight);
  const positionBottomPx = 1920 - captionTop + 10; // 10px gap above captions

  const html = baseTemplate
    .replace('{{FONT_FACE_CSS}}', fontFaceCss)
    .replaceAll('{{POSITION_BOTTOM_PX}}', String(positionBottomPx))
    .replaceAll('{{PILL_COLOR}}', template.hook.pill_color)
    .replaceAll('{{FONT_FAMILY}}', fontFamily)
    .replaceAll('{{FONT_SIZE}}', String(template.hook.font_size))
    .replaceAll('{{HOOK_TEXT}}', escapeHtml(hookText))
    .replaceAll('{{TEXT_COLOR}}', template.hook.text_color);

  await writeFile(htmlPath, html, 'utf8');

  const chromeBin = process.env.CHROME_BIN || 'chromium';
  await execFileAsync(chromeBin, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--allow-file-access-from-files',
    '--hide-scrollbars',
    '--window-size=1080,1920',
    '--default-background-color=00000000',
    `--screenshot=${outputPngPath}`,
    `file://${htmlPath}`
  ]);
};
