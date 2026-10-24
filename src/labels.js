import { InputError, object, text } from './validation.js';
import { labelMediaPresets, naturalOrientation } from './label-media.js';
export { labelMediaPresets, defaultLabelStyles } from './label-media.js';

export const labelMedia = labelMediaPresets[0];
export const labelKinds = ['box', 'location'];
export const testLabel = { title: 'Storage System TEST', description: 'ÅÄÖ åäö - en testetikett', location: 'TEST - 57 x 32 mm' };
const kindFields = { box: ['title', 'description', 'location'], location: ['location'] };
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
  for (const name of fields) {
    text(input[name], name, { empty: name === 'description' });
    if (input[name].length > (name === 'description' ? 2000 : 240) || /[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/u.test(input[name])) {
      throw new InputError('Label text supports Latin-1, including Swedish letters. Shorten text or replace unsupported characters.');
    }
  }
  const lines = [], warnings = [];
  const place = (rows, size, bold, top) => {
    for (const [index, row] of rows.entries()) lines.push({ text: row, x: canvas.widthPt / 2, y: top + size + index * size * 1.2,
      size, bold, width: Math.min(availableWidth, width(row, size)) });
  };
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
  const out = ['%!PS-Adobe-3.0', '%%Pages: 1', `%%BoundingBox: 0 0 ${pageWidth} ${pageHeight}`, `<< /PageSize [${pageWidth} ${pageHeight}] /NumCopies 1 >> setpagedevice`];
  for (const [name, font] of [['Regular', 'Helvetica'], ['Bold', 'Helvetica-Bold']]) out.push(`/${name} /${font} findfont dup length dict begin {1 index /FID ne {def} {pop pop} ifelse} forall /Encoding ISOLatin1Encoding def currentdict end definefont pop`);
  // Rotated canvas: canvas (u, v) lands on page (pageWidth - v, u), a quarter turn counterclockwise.
  if (layout.rotated) out.push(`${pageWidth} 0 translate 90 rotate`);
  for (const line of layout.lines) out.push(`gsave /${line.bold ? 'Bold' : 'Regular'} findfont ${line.size} scalefont setfont`,
    `${line.x - line.width / 2} ${layout.heightPt - line.y} translate (${literal(line.text)}) dup stringwidth pop dup 0 gt { ${line.width} exch div 1 scale } { pop } ifelse 0 0 moveto show grestore`);
  out.push('showpage', '%%EOF');
  return Buffer.from(out.join('\n') + '\n', 'ascii');
}
