// Fonts shipped with the service (fonts/, open licences). Text is measured with the real glyph metrics and drawn
// as outlines, so the preview, the PNG and the printed label use exactly the same shapes.
import { readFileSync } from 'node:fs';
import opentype from 'opentype.js';
import { InputError } from './validation.js';

const files = {
  'Liberation Sans': { regular: 'LiberationSans-Regular.ttf', bold: 'LiberationSans-Bold.ttf', italic: 'LiberationSans-Italic.ttf', boldItalic: 'LiberationSans-BoldItalic.ttf' },
  'Liberation Serif': { regular: 'LiberationSerif-Regular.ttf', bold: 'LiberationSerif-Bold.ttf' },
  'Liberation Mono': { regular: 'LiberationMono-Regular.ttf', bold: 'LiberationMono-Bold.ttf' },
  'DejaVu Sans Condensed': { regular: 'DejaVuSansCondensed.ttf', bold: 'DejaVuSansCondensed-Bold.ttf' }
};
export const defaultFamily = 'Liberation Sans';
export const fontFamilies = Object.entries(files).map(([family, styles]) => ({ family, bold: Boolean(styles.bold), italic: Boolean(styles.italic) }));

const loaded = new Map();
const styleOf = (bold, italic) => bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular';

export function fontFor(family = defaultFamily, { bold = false, italic = false } = {}) {
  const file = files[family]?.[styleOf(bold, italic)];
  if (!file) throw new InputError(`Font "${family}"${bold || italic ? ` in ${styleOf(bold, italic)}` : ''} is not available.`);
  if (!loaded.has(file)) {
    const bytes = readFileSync(new URL(`../fonts/${file}`, import.meta.url));
    loaded.set(file, opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  }
  return loaded.get(file);
}

export const measure = (font, text, size) => font.getAdvanceWidth(text, size, { kerning: true });

// Every visible character must exist in the font; a missing glyph would print as an empty box.
export function assertGlyphs(font, text, family) {
  for (const c of new Set(text)) {
    if (/\s/u.test(c)) continue;
    if (font.charToGlyph(c).index === 0) throw new InputError(`The character "${c}" is not available in the font ${family}. Replace it or choose another font.`);
  }
}

export const outline = (font, text, x, baseline, size) => font.getPath(text, x, baseline, size, { kerning: true }).toPathData(2);
