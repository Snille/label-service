import { InputError, object, text } from './validation.js';
import { labelMediaPresets, naturalOrientation } from './label-media.js';
export { labelMediaPresets, defaultLabelStyles } from './label-media.js';

export const labelMedia = labelMediaPresets[0];
export const labelKinds = ['box', 'location', 'lines'];
export const testLabel = { title: 'Storage System TEST', description: 'ÅÄÖ åäö - en testetikett', location: 'TEST - 57 x 32 mm' };
export const testLines = [{ text: 'Label service TEST', bold: true, size: 12 }, { text: 'ÅÄÖ åäö - fri text' }, { text: 'rad 3', size: 8 }];
const kindFields = { box: ['title', 'description', 'location'], location: ['location'], lines: ['lines'] };
// Built-in templates. A later designer adds saved templates with their own fields.
export const labelTemplates = [
  { kind: 'box', name: 'Box label', fields: { title: 'text, max 240', description: 'text, max 2000, may be empty', location: 'text, max 240' } },
  { kind: 'location', name: 'Location label', fields: { location: 'text, max 240; printed large' } },
  { kind: 'lines', name: 'Free lines', fields: { lines: 'array of 1-12 { text (max 240, may be empty), bold?: boolean, size?: 6-16 points, default 10 }; shrunk together until they fit' } }
];
const latin1 = value => !/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/u.test(value);
const unsupported = () => new InputError('Label text supports Latin-1, including Swedish letters. Shorten text or replace unsupported characters.');
const width = (text, size) => [...text.normalize('NFD').replace(/[̀-ͯ]/g, '')].reduce((sum, c) =>
  sum + (/^[ilI.,'!:;| ]$/.test(c) ? .26 : /^[MWmw@]$/.test(c) ? .85 : /^[A-Z0-9]$/.test(c) ? .62 : .51) * size, 0);

// Greedy word wrap. Location codes such as IVAR-A-H2-P1-A have no spaces, so location labels
// may also break after hyphens, but only in a word too wide for a row of its own.
function wrap(value, size, availableWidth, breakHyphens) {
  const rows = [];
  for (const paragraph of value.replace(/\r\n?/g, '\n').split('\n')) {
    let row = '';
    for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
      const pieces = breakHyphens && width(word, size) > availableWidth ? word.match(/[^-]+-*|-+/g) : [word];
      for (const [index, piece] of pieces.entries()) {
        const joined = row ? `${row}${index ? '' : ' '}${piece}` : piece;
        if (row && width(joined, size) > availableWidth) { rows.push(row); row = piece; }
        else row = joined;
      }
    }
    if (row) rows.push(row);
  }
  return rows;
}

export function labelLayout(input, style, mediaKey = labelMedia.key, kind = 'box') {
  const media = labelMediaPresets.find(preset => preset.key === mediaKey);
  if (!media) throw new InputError('Unsupported label format.');
  if (!labelKinds.includes(kind)) throw new InputError('Unsupported label type.');
  style ||= media.style;
  // Lay text out on the readable canvas; a rotated canvas swaps the page sides and PostScript turns it onto the page.
  const rotated = (style.orientation || naturalOrientation(media)) !== naturalOrientation(media);
  const canvas = rotated ? { widthPt: media.heightPt, heightPt: media.widthPt } : { widthPt: media.widthPt, heightPt: media.heightPt };
  const page = { ...media, ...canvas, pageWidthPt: media.widthPt, pageHeightPt: media.heightPt, rotated, orientation: rotated ? style.orientation : naturalOrientation(media) };
  const availableWidth = canvas.widthPt - 17, heightScale = canvas.heightPt / 90, fields = kindFields[kind];
  object(input);
  for (const name of Object.keys(input)) if (!fields.includes(name)) throw new InputError('Unsupported label field.');
  if (kind === 'lines') {
    if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 12) throw new InputError('lines must be an array of 1-12 lines.');
    for (const line of input.lines) {
      object(line, 'line');
      if (Object.keys(line).some(k => !['text', 'bold', 'size'].includes(k)) || typeof line.text !== 'string' || line.text.length > 240
        || (line.bold !== undefined && typeof line.bold !== 'boolean') || (line.size !== undefined && (!Number.isInteger(line.size) || line.size < 6 || line.size > 16))) {
        throw new InputError('Each line is { text, bold?, size? } with text up to 240 characters and size 6-16 points.');
      }
      if (/[\r\n]/.test(line.text) || !latin1(line.text)) throw unsupported();
    }
  } else for (const name of fields) {
    text(input[name], name, { empty: name === 'description' });
    if (input[name].length > (name === 'description' ? 2000 : 240) || !latin1(input[name])) throw unsupported();
  }
  const lines = [], warnings = [];
  const place = (rows, size, bold, top) => {
    for (const [index, row] of rows.entries()) lines.push({ text: row, x: canvas.widthPt / 2, y: top + size + index * size * 1.2,
      size, bold, width: Math.min(availableWidth, width(row, size)) });
  };
  if (kind === 'lines') {
    // Shrink every line by the same factor (never below 6 points) until the whole block fits, then centre it vertically.
    const top = 6 * heightScale, height = 78 * heightScale;
    const fit = factor => {
      const blocks = input.lines.map(line => {
        const size = Math.max(6, Math.floor((line.size || 10) * factor));
        return { size, bold: Boolean(line.bold), rows: line.text.trim() ? wrap(line.text, size, availableWidth, true) : [''] };
      });
      const total = blocks.reduce((sum, b) => sum + b.rows.length * b.size * 1.2, 0);
      return { blocks, total, fits: total <= height && blocks.every(b => b.rows.every(row => width(row, b.size) <= availableWidth)) };
    };
    let result = fit(1);
    for (let factor = 0.95; !result.fits && factor > 0.3; factor -= 0.05) result = fit(factor);
    if (!result.fits) warnings.push('lines');
    let y = top + Math.max(0, (height - result.total) / 2);
    for (const block of result.blocks) {
      const capacity = Math.max(0, Math.floor((top + height - y) / (block.size * 1.2)));
      place(block.rows.slice(0, capacity).filter(row => row), block.size, block.bold, y);
      // Blank spacer rows take their height without drawing anything.
      y += block.rows.length * block.size * 1.2;
    }
    return { ...page, kind, lines, warnings };
  }
  if (kind === 'location') {
    // One large centered block: use the largest size up to the format's setting that fits the whole label.
    const top = 6 * heightScale, height = 78 * heightScale;
    let size = style.locationLabelSize, rows;
    for (; ; size--) {
      rows = wrap(input.location, size, availableWidth, true);
      if ((rows.length * size * 1.2 <= height && rows.every(row => width(row, size) <= availableWidth)) || size <= 6) break;
    }
    if (rows.length * size * 1.2 > height || rows.some(row => width(row, size) > availableWidth)) warnings.push('location');
    const capacity = Math.floor(height / (size * 1.2)), shown = rows.slice(0, capacity);
    place(shown, size, true, top + (height - shown.length * size * 1.2) / 2);
    return { ...page, kind, lines, warnings };
  }
  for (const [field, top, height, configuredSize, bold] of [
    ['title', 6, 20, style.titleSize, true], ['description', 28.5, 39.5, style.descriptionSize, false], ['location', 71, 14, style.locationSize, true]
  ]) {
    let size = configuredSize;
    if (field !== 'description') while (size > 6 && width(input[field], size) > availableWidth) size--;
    const rows = wrap(input[field], size, availableWidth, false);
    const capacity = Math.floor(height * heightScale / (size * 1.2));
    if (rows.length > capacity || rows.some(row => width(row, size) > availableWidth)) warnings.push(field);
    place(rows.slice(0, capacity), size, bold, top * heightScale);
  }
  return { ...page, kind, lines, warnings };
}

function literal(value) {
  return [...Buffer.from(value, 'latin1')].map(byte => [40, 41, 92].includes(byte) ? `\\${String.fromCharCode(byte)}`
    : byte < 32 || byte > 126 ? `\\${byte.toString(8).padStart(3, '0')}` : String.fromCharCode(byte)).join('');
}

export function labelPostScript(layout) {
  const pageWidth = layout.pageWidthPt ?? layout.widthPt, pageHeight = layout.pageHeightPt ?? layout.heightPt;
  // DSC bounding boxes are integers; a fractional page (102 x 210 mm) also gets a high-resolution box.
  const out = ['%!PS-Adobe-3.0', '%%Pages: 1', `%%BoundingBox: 0 0 ${Math.ceil(pageWidth)} ${Math.ceil(pageHeight)}`,
    ...(Number.isInteger(pageWidth) && Number.isInteger(pageHeight) ? [] : [`%%HiResBoundingBox: 0 0 ${pageWidth} ${pageHeight}`]),
    `<< /PageSize [${pageWidth} ${pageHeight}] /NumCopies 1 >> setpagedevice`];
  for (const [name, font] of [['Regular', 'Helvetica'], ['Bold', 'Helvetica-Bold']]) out.push(`/${name} /${font} findfont dup length dict begin {1 index /FID ne {def} {pop pop} ifelse} forall /Encoding ISOLatin1Encoding def currentdict end definefont pop`);
  // Rotated canvas: canvas (u, v) lands on page (pageWidth - v, u), a quarter turn counterclockwise.
  if (layout.rotated) out.push(`${pageWidth} 0 translate 90 rotate`);
  for (const line of layout.lines) out.push(`gsave /${line.bold ? 'Bold' : 'Regular'} findfont ${line.size} scalefont setfont`,
    `${line.x - line.width / 2} ${layout.heightPt - line.y} translate (${literal(line.text)}) dup stringwidth pop dup 0 gt { ${line.width} exch div 1 scale } { pop } ifelse 0 0 moveto show grestore`);
  out.push('showpage', '%%EOF');
  return Buffer.from(out.join('\n') + '\n', 'ascii');
}
