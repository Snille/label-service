// Fonts shipped with the service (fonts/, open licences) and fonts uploaded by designers. Text is measured with the
// real glyph metrics and drawn as outlines, so the preview, the PNG and the printed label use exactly the same shapes.
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
export const fontStyles = ['regular', 'bold', 'italic', 'boldItalic'];
export const builtInFamilies = Object.keys(files);

const loaded = new Map();
// Uploaded fonts by id: { id, family, style, font }, set by the print service from its store.
let uploaded = new Map();
const parse = bytes => opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
export const styleOf = (bold, italic) => bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular';

// The font families a template may use, with the styles each one has. Uploaded families name the font id of each style.
export function fontFamilies() {
  const families = Object.entries(files).map(([family, styles]) => ({ family, regular: true, bold: Boolean(styles.bold), italic: Boolean(styles.italic), boldItalic: Boolean(styles.boldItalic) }));
  const added = new Map();
  for (const f of uploaded.values()) {
    if (!added.has(f.family)) added.set(f.family, { family: f.family, uploaded: true, regular: false, bold: false, italic: false, boldItalic: false, files: {} });
    const entry = added.get(f.family); entry[f.style] = true; entry.files[f.style] = f.id;
  }
  return [...families, ...[...added.values()].sort((a, b) => a.family.localeCompare(b.family))];
}

// fonts: [{ id, family, style, data }] from the store. Parsed fonts are kept by id.
export function setUploadedFonts(fonts) {
  const next = new Map();
  for (const f of fonts) next.set(f.id, uploaded.get(f.id) || { id: f.id, family: f.family, style: f.style, font: parse(f.data) });
  uploaded = next;
}

export function fontFor(family = defaultFamily, { bold = false, italic = false } = {}) {
  const style = styleOf(bold, italic), file = files[family]?.[style];
  if (!file) {
    const added = [...uploaded.values()].find(f => f.family === family && f.style === style);
    if (added) return added.font;
    throw new InputError(`Font "${family}"${bold || italic ? ` in ${style}` : ''} is not available.`);
  }
  if (!loaded.has(file)) loaded.set(file, parse(readFileSync(new URL(`../fonts/${file}`, import.meta.url))));
  return loaded.get(file);
}

const fontName = /^[\p{L}\p{N}][\p{L}\p{N} ._&+()-]{0,59}$/u;
// Reads an uploaded font file: TrueType or OpenType (.ttf, .otf) or WOFF. The family and style come from the font's own
// names (name IDs 1 and 2, the family a program lists with regular, bold, italic and bold italic) and its style bits.
export function readFont(bytes) {
  const head = bytes.subarray(0, 4).toString('latin1');
  if (head === 'wOF2') throw new InputError('WOFF2 fonts are not supported. Upload the .ttf or .otf file.', 415);
  if (!['\0\x01\0\0', 'OTTO', 'true', 'wOFF'].includes(head)) throw new InputError('This is not a TrueType, OpenType or WOFF font.', 415);
  let font;
  try { font = parse(bytes); } catch { throw new InputError('The font file is damaged or of an unsupported kind.', 415); }
  const names = font.names.windows || font.names.macintosh || font.names;
  const pick = entry => entry && (entry.en || Object.values(entry)[0]);
  const family = String(pick(names.fontFamily) || '').trim(), subfamily = String(pick(names.fontSubfamily) || '').trim();
  if (!fontName.test(family)) throw new InputError(`The font's family name "${family.slice(0, 60)}" cannot be used: it needs letters or digits and no quotes.`);
  if (builtInFamilies.some(f => f.toLowerCase() === family.toLowerCase())) throw new InputError(`${family} is built in already.`, 409);
  if (font.numGlyphs < 2) throw new InputError('The font has no characters.');
  const os2 = font.tables.os2 || {}, macStyle = font.tables.head?.macStyle || 0;
  const bold = Boolean(os2.fsSelection & 32 || macStyle & 1 || /\bbold\b/i.test(subfamily));
  const italic = Boolean(os2.fsSelection & 1 || macStyle & 2 || /italic|oblique/i.test(subfamily));
  // fsType 2: the maker allows no embedding. The label prints the outlines, but the file is still shared with Studio.
  return { family, style: styleOf(bold, italic), subfamily, format: head === 'wOFF' ? 'woff' : head === 'OTTO' ? 'otf' : 'ttf', glyphs: font.numGlyphs,
    restricted: (os2.fsType & 15) === 2, font };
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
