// Readable preview of a label layout. It shows the text as it reads, not turned onto the roll.
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function layoutSvg(layout) {
  const lines = layout.lines.map(line => `<text x="${line.x}" y="${line.y}" font-size="${line.size}" font-family="Arial, sans-serif"`
    + ` font-weight="${line.bold ? 'bold' : 'normal'}" fill="black" text-anchor="middle" textLength="${line.width}" lengthAdjust="spacingAndGlyphs">${escape(line.text)}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.widthPt} ${layout.heightPt}" width="${layout.widthPt}pt" height="${layout.heightPt}pt">`
    + `<rect width="100%" height="100%" fill="white"/>${lines.join('')}</svg>`;
}
