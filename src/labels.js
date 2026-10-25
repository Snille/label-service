// Layout engine: a template plus field values become positioned text rows and shapes on the readable label.
// Text is measured with the real font metrics, so "fits" here means fits on paper.
import { InputError } from './validation.js';
import { labelMediaPresets, naturalOrientation, mmToPt } from './label-media.js';
import { fontFor, measure, assertGlyphs, defaultFamily } from './fonts.js';
import { builtInTemplates, builtInDescriptions, validateFields, fill } from './template.js';
export { labelMediaPresets, defaultLabelStyles } from './label-media.js';

export const labelMedia = labelMediaPresets[0];
export const labelKinds = builtInTemplates.map(t => t.id);
export const testLabel = { title: 'Storage System TEST', description: 'ÅÄÖ åäö - en testetikett', location: 'TEST - 57 x 32 mm' };
export const testLines = [{ text: 'Label service TEST', bold: true, size: 12 }, { text: 'ÅÄÖ åäö - fri text' }, { text: 'rad 3', size: 8 }];
export const labelTemplates = builtInTemplates.map(t => ({ id: t.id, kind: t.id, name: t.name, builtIn: true, fields: builtInDescriptions[t.id] }));

// Greedy word wrap. Location codes such as IVAR-A-H2-P1-A have no spaces, so they may also break after hyphens,
// but only in a word too wide for a row of its own.
function wrap(font, value, size, availableWidth, breakHyphens) {
  const rows = [];
  for (const paragraph of value.split('\n')) {
    let row = '';
    for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
      const pieces = breakHyphens && measure(font, word, size) > availableWidth ? word.match(/[^-]+-*|-+/g) : [word];
      for (const [index, piece] of pieces.entries()) {
        const joined = row ? `${row}${index ? '' : ' '}${piece}` : piece;
        if (row && measure(font, joined, size) > availableWidth) { rows.push(row); row = piece; }
        else row = joined;
      }
    }
    if (row) rows.push(row);
  }
  return rows;
}

const resolveLength = (value, side) => typeof value === 'string' ? side * parseFloat(value) / 100 : mmToPt(value);
function box(item, canvas) {
  const axis = (start, end, size, side) => {
    const s = item[start] === undefined ? undefined : resolveLength(item[start], side);
    const e = item[end] === undefined ? undefined : resolveLength(item[end], side);
    const z = item[size] === undefined ? undefined : resolveLength(item[size], side);
    return s !== undefined && z !== undefined ? [s, z] : s !== undefined ? [s, side - e - s] : [side - e - z, z];
  };
  const [x, w] = axis('x', 'right', 'w', canvas.widthPt), [y, h] = axis('y', 'bottom', 'h', canvas.heightPt);
  return { x, y, w, h };
}
const fontSize = (value, style, fallback) => typeof value === 'string' ? style[value.slice(1)] : value ?? fallback;
const round = value => Math.round(value * 1000) / 1000;

// Places rows inside a box and records them both as render rows and as the original preview lines.
function placeRows(rows, area, valign, align, layout) {
  const height = rows.reduce((sum, r) => sum + r.size * r.lineHeight, 0);
  let y = area.y + (valign === 'middle' ? (area.h - height) / 2 : valign === 'bottom' ? area.h - height : 0);
  const placed = [];
  for (const row of rows) {
    if (row.text) {
      const width = measure(row.font, row.text, row.size);
      const x = align === 'left' ? area.x : align === 'right' ? area.x + area.w - width : area.x + (area.w - width) / 2;
      const baseline = y + row.size;
      placed.push({ text: row.text, x: round(x), baseline: round(baseline), size: row.size, width: round(width), family: row.family, bold: row.bold, italic: row.italic });
      layout.lines.push({ text: row.text, x: round(x + width / 2), y: round(baseline), size: row.size, bold: row.bold, width: round(Math.min(width, area.w)) });
    }
    y += row.size * row.lineHeight;
  }
  return placed;
}

function layoutText(item, id, values, style, canvas, layout) {
  const area = box(item, canvas), family = item.font || defaultFamily, bold = Boolean(item.bold), italic = Boolean(item.italic);
  const font = fontFor(family, { bold, italic }), text = fill(item.text, values), lineHeight = item.lineHeight || 1.2;
  assertGlyphs(font, text, family);
  const max = fontSize(item.size, style, 10), min = Math.min(max, fontSize(item.minSize, style, max));
  if (!text.trim()) return { type: 'text', id, color: item.color || 'black', rows: [] };
  const attempt = size => {
    const rows = item.wrap === false ? text.split('\n') : wrap(font, text, size, area.w, Boolean(item.breakHyphens));
    return { size, rows, fits: rows.length * size * lineHeight <= area.h + 0.01 && rows.every(r => measure(font, r, size) <= area.w + 0.01) };
  };
  let result = attempt(max);
  for (let size = Math.ceil(max) - 1; !result.fits && size >= min; size--) result = attempt(size);
  if (!result.fits && min % 1) result = attempt(min);
  const capacity = Math.max(0, Math.floor((area.h + 0.01) / (result.size * lineHeight)));
  if (!result.fits) {
    const wide = result.rows.some(r => measure(font, r, result.size) > area.w + 0.01);
    layout.problems.push({ object: id, message: wide && result.rows.length <= capacity
      ? `"${id}" is wider than its box at ${result.size} pt. Shorten the text or reduce the font size.`
      : `"${id}" needs ${result.rows.length} rows, but ${capacity} fit at ${result.size} pt. Shorten the text or reduce the font size.` });
  }
  const rows = result.rows.slice(0, capacity).map(r => ({ text: r, size: result.size, lineHeight, font, family, bold, italic }));
  return { type: 'text', id, color: item.color || 'black', rows: placeRows(rows, area, item.valign || 'top', item.align || 'center', layout) };
}

// Free lines: every line shrinks by the same factor (never below the minimum) until the whole block fits.
function layoutStack(item, id, values, style, canvas, layout) {
  const area = box(item, canvas), family = item.font || defaultFamily, lineHeight = item.lineHeight || 1.2;
  const lines = values[item.items.replace(/[{}\s]/g, '')], base = fontSize(item.size, style, 10), min = fontSize(item.minSize, style, 6);
  for (const line of lines) assertGlyphs(fontFor(family, { bold: Boolean(line.bold) }), line.text, family);
  const attempt = factor => {
    const blocks = lines.map(line => {
      const bold = Boolean(line.bold), font = fontFor(family, { bold }), size = Math.max(min, Math.floor((line.size || base) * factor));
      return { size, bold, font, rows: line.text.trim() ? wrap(font, line.text, size, area.w, true) : [''] };
    });
    const total = blocks.reduce((sum, b) => sum + b.rows.length * b.size * lineHeight, 0);
    return { blocks, fits: total <= area.h + 0.01 && blocks.every(b => b.rows.every(r => measure(b.font, r, b.size) <= area.w + 0.01)) };
  };
  let result = attempt(1);
  for (let factor = 0.95; !result.fits && factor > 0.3; factor -= 0.05) result = attempt(factor);
  if (!result.fits) layout.problems.push({ object: id, message: `"${id}" does not fit even at ${min} pt. Remove lines or shorten them.` });
  const rows = []; let used = 0;
  for (const block of result.blocks) for (const text of block.rows) {
    if (used + block.size * lineHeight > area.h + 0.01) break;
    rows.push({ text, size: block.size, lineHeight, font: block.font, family, bold: block.bold, italic: false }); used += block.size * lineHeight;
  }
  return { type: 'text', id, color: item.color || 'black', rows: placeRows(rows, area, item.valign || 'middle', item.align || 'center', layout) };
}

function layoutShape(item, id, canvas) {
  const { x, y, w, h } = box(item, canvas);
  return { type: item.type, id, x: round(x), y: round(y), w: round(w), h: round(h), stroke: round(mmToPt(item.stroke ?? 0.3)),
    fill: item.fill || 'none', radius: round(mmToPt(item.radius || 0)), dash: item.dash?.map(d => round(mmToPt(d))) };
}

// The page: a chosen direction other than the format's natural one turns the readable canvas a quarter turn on the label.
export function labelPage(media, orientation) {
  const rotated = (orientation || naturalOrientation(media)) !== naturalOrientation(media);
  const canvas = rotated ? { widthPt: media.heightPt, heightPt: media.widthPt } : { widthPt: media.widthPt, heightPt: media.heightPt };
  return { key: media.key, sku: media.sku, name: media.name, widthMm: media.widthMm, heightMm: media.heightMm, ...canvas,
    pageWidthPt: media.widthPt, pageHeightPt: media.heightPt, rotated, orientation: rotated ? orientation : naturalOrientation(media) };
}

export function layoutTemplate(definition, input, { media, style, orientation }) {
  const values = validateFields(definition, input);
  const layout = { ...labelPage(media, orientation || definition.orientation || style.orientation), kind: definition.id, lines: [], items: [], problems: [] };
  for (const [index, item] of definition.objects.entries()) {
    const id = item.id || `${item.type}${index + 1}`;
    layout.items.push(item.type === 'text' ? layoutText(item, id, values, style, layout, layout)
      : item.type === 'stack' ? layoutStack(item, id, values, style, layout, layout) : layoutShape(item, id, layout));
  }
  layout.warnings = [...new Set(layout.problems.map(p => p.object))];
  return layout;
}

// The original entry point for the built-in kinds, kept for callers and tests.
export function labelLayout(input, style, mediaKey = labelMedia.key, kind = 'box') {
  const media = labelMediaPresets.find(preset => preset.key === mediaKey);
  if (!media) throw new InputError('Unsupported label format.');
  const definition = builtInTemplates.find(t => t.id === kind);
  if (!definition) throw new InputError('Unsupported label type.');
  style ||= media.style;
  return layoutTemplate(definition, input, { media, style, orientation: style.orientation });
}
