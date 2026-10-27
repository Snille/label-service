// One drawing for preview and print: text as glyph outlines, shapes as SVG elements, all in points.
// The preview shows the label as it reads; the print page turns a rotated canvas a quarter turn onto the label.
import { fontFor, outline } from './fonts.js';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ink = color => color === 'white' ? 'white' : 'black';

function shape(item) {
  const stroke = item.stroke > 0 ? ` stroke="black" stroke-width="${item.stroke}"${item.dash?.length ? ` stroke-dasharray="${item.dash.join(' ')}"` : ''}` : '';
  const fill = ` fill="${item.fill === 'none' ? 'none' : ink(item.fill)}"`;
  if (item.type === 'line') return `<line x1="${item.x}" y1="${item.y}" x2="${item.x + item.w}" y2="${item.y + item.h}"${stroke || ' stroke="black" stroke-width="0.85"'}/>`;
  if (item.type === 'ellipse') return `<ellipse cx="${item.x + item.w / 2}" cy="${item.y + item.h / 2}" rx="${item.w / 2}" ry="${item.h / 2}"${fill}${stroke}/>`;
  return `<rect x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}"${item.radius ? ` rx="${item.radius}"` : ''}${fill}${stroke}/>`;
}

const rows = item => item.rows.map(row =>
  `<path aria-label="${escape(row.text)}" fill="${ink(item.color)}" d="${outline(fontFor(row.family, row), row.text, row.x, row.baseline, row.size)}"/>`).join('');
// Bars and 2D modules: one path of whole-dot rectangles, then the human-readable text.
const bars = item => (item.rects.length ? `<path aria-label="${escape(item.id)}" fill="black" d="${item.rects.map(r => `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}z`).join('')}"/>` : '') + rows(item);

// A picture is already black and white in printer dots; it is drawn 1:1 without smoothing.
const picture = item => item.href ? `<image aria-label="${escape(item.id)}" x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" preserveAspectRatio="none" style="image-rendering:pixelated" xlink:href="${item.href}"/>` : '';

// A rotated object is drawn in its own frame and turned about the centre of its box.
const turned = (item, body) => item.rotate && body ? `<g transform="rotate(${item.rotate.angle} ${item.rotate.cx} ${item.rotate.cy})">${body}</g>` : body;
function content(layout) {
  return layout.items.map(item => turned(item, item.type === 'text' ? rows(item) : item.type === 'barcode' ? bars(item) : item.type === 'image' ? picture(item) : shape(item))).join('');
}

// Readable preview of a label layout. It shows the text as it reads, not turned onto the roll.
export function layoutSvg(layout) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${layout.widthPt} ${layout.heightPt}" width="${layout.widthPt}pt" height="${layout.heightPt}pt">`
    + `<rect width="100%" height="100%" fill="white"/>${content(layout)}</svg>`;
}

// The page as it is printed. Rotated canvas point (u, v) lands on page point (v, pageHeight - u): the same quarter turn
// counterclockwise that the accepted PostScript pages used.
export function pageSvg(layout) {
  const w = layout.pageWidthPt, h = layout.pageHeightPt;
  const body = layout.rotated ? `<g transform="matrix(0 -1 1 0 0 ${h})">${content(layout)}</g>` : content(layout);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${w} ${h}" width="${w}pt" height="${h}pt">`
    + `<rect width="100%" height="100%" fill="white"/>${body}</svg>`;
}
