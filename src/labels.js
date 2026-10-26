// Layout engine: a template plus field values become positioned text rows and shapes on the readable label.
// Text is measured with the real font metrics, so "fits" here means fits on paper.
import { InputError } from './validation.js';
import { labelMediaPresets, naturalOrientation, mmToPt } from './label-media.js';
import { fontFor, measure, assertGlyphs, defaultFamily } from './fonts.js';
import { builtInTemplates, builtInDescriptions, validateFields, fill } from './template.js';
import { encode, dot, symbologyName } from './barcode.js';
export { labelMediaPresets, defaultLabelStyles } from './label-media.js';

export const labelMedia = labelMediaPresets[0];
export const labelKinds = builtInTemplates.map(t => t.id);
export const testLabel = { title: 'Storage System TEST', description: 'ÅÄÖ åäö - en testetikett', location: 'TEST - 57 x 32 mm' };
export const testLines = [{ text: 'Label service TEST', bold: true, size: 12 }, { text: 'ÅÄÖ åäö - fri text' }, { text: 'rad 3', size: 8 }];
export const labelTemplates = builtInTemplates.map(t => ({ id: t.id, kind: t.id, name: t.name, builtIn: true, fields: builtInDescriptions[t.id] }));

// Greedy word wrap. Location codes such as IVAR-A-H2-P1-A have no spaces, so they may also break after hyphens,
// but only in a word too wide for a row of its own.
// An empty line between paragraphs stays an empty row; empty lines before the first or after the last paragraph are dropped.
function wrap(font, value, size, availableWidth, breakHyphens) {
  const rows = [], paragraphs = value.split('\n');
  const first = paragraphs.findIndex(p => p.trim()), last = paragraphs.findLastIndex(p => p.trim());
  for (const paragraph of paragraphs.slice(first, last + 1)) {
    if (!paragraph.trim()) { rows.push(''); continue; }
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

// A barcode fills its box with whole-dot modules: linear codes use the width (and leave room for the text below),
// 2D codes are square in the box. Too small a box is a problem, not a blurred code.
const offset = (free, where, start, end) => where === start ? 0 : where === end ? free : free / 2;
const snap = value => round(Math.round(value / dot) * dot);
const mm = points => (points * 25.4 / 72).toFixed(1);
function layoutBarcode(item, id, values, style, canvas, layout) {
  const area = box(item, canvas), data = fill(item.data, values).trim(), name = symbologyName(item.symbology);
  const result = { type: 'barcode', id, color: 'black', rects: [], rows: [] };
  if (!data) { layout.problems.push({ object: id, message: `"${id}" has no data for its ${name}.` }); return result; }
  let code;
  try { code = encode(item.symbology, data, { ecLevel: item.ecLevel }); }
  catch (error) { layout.problems.push({ object: id, message: `"${id}" is not a valid ${name}: ${error.message}` }); return result; }
  if (code.kind === 'matrix') {
    const minimum = 3, size = Math.floor(Math.min(area.w / code.columns, area.h / code.rows) / dot);
    if (size < minimum) {
      layout.problems.push({ object: id, message: `"${id}" is too small for its ${name}: it needs a square of at least ${mm(Math.max(code.columns, code.rows) * minimum * dot)} mm.` });
      return result;
    }
    const cell = size * dot, x0 = snap(area.x + offset(area.w - code.columns * cell, item.align || 'center', 'left', 'right'));
    const y0 = snap(area.y + offset(area.h - code.rows * cell, item.valign || 'middle', 'top', 'bottom'));
    // One rectangle per run of dark cells in a row keeps the drawing small.
    for (let r = 0; r < code.rows; r++) {
      for (let c = 0; c < code.columns; c++) {
        if (!code.cells[r * code.columns + c]) continue;
        let end = c; while (end + 1 < code.columns && code.cells[r * code.columns + end + 1]) end++;
        result.rects.push({ x: round(x0 + c * cell), y: round(y0 + r * cell), w: round((end - c + 1) * cell), h: round(cell) });
        c = end;
      }
    }
    return result;
  }
  const minimum = 2, size = Math.floor(area.w / code.modules / dot);
  const textSize = fontSize(item.size, style, 8), readable = item.humanReadable !== 'none', textHeight = readable ? textSize * 1.2 : 0;
  if (size < minimum) {
    layout.problems.push({ object: id, message: `"${id}" is too narrow for its ${name}: it needs at least ${mm(code.modules * minimum * dot)} mm. Make the box wider or the data shorter.` });
    return result;
  }
  const barsHeight = area.h - textHeight;
  if (barsHeight < mmToPt(3)) { layout.problems.push({ object: id, message: `"${id}" is too low for its ${name}: the bars need at least 3 mm.` }); return result; }
  const module = size * dot, width = code.modules * module, x0 = snap(area.x + offset(area.w - width, item.align || 'center', 'left', 'right')), y0 = snap(area.y);
  result.rects = code.bars.map(bar => ({ x: round(x0 + bar.start * module), y: y0, w: round(bar.width * module), h: round(barsHeight - (y0 - area.y)) }));
  if (readable) {
    const family = item.font || defaultFamily, font = fontFor(family);
    assertGlyphs(font, code.text, family);
    if (measure(font, code.text, textSize) > area.w + 0.01) layout.problems.push({ object: id, message: `"${id}": the text under the ${name} is wider than its box at ${textSize} pt. Reduce the size or choose none.` });
    else result.rows = placeRows([{ text: code.text, size: textSize, lineHeight: 1.2, font, family, bold: false, italic: false }],
      { x: area.x, y: area.y + barsHeight, w: area.w, h: textHeight }, 'top', 'center', layout);
  }
  return result;
}

// The date and time when the label is previewed (the print uses that preview). Tokens: yyyy, yy, MM, dd, HH, mm.
export function formatDate(date, format = 'yyyy-MM-dd') {
  const two = n => String(n).padStart(2, '0');
  const parts = { yyyy: String(date.getFullYear()), yy: two(date.getFullYear() % 100), MM: two(date.getMonth() + 1), dd: two(date.getDate()), HH: two(date.getHours()), mm: two(date.getMinutes()) };
  return format.replace(/yyyy|yy|MM|dd|HH|mm/g, token => parts[token]);
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

export function layoutTemplate(definition, input, { media, style, orientation, now = new Date() }) {
  const values = validateFields(definition, input);
  const layout = { ...labelPage(media, orientation || definition.orientation || style.orientation), kind: definition.id, lines: [], items: [], problems: [] };
  for (const [index, item] of definition.objects.entries()) {
    const id = item.id || `${item.type}${index + 1}`;
    // A date is a text object whose text is the formatted time; field placeholders do not apply to it.
    const date = () => layoutText({ ...item, type: 'text', text: `${item.prefix || ''}${formatDate(now, item.format)}${item.suffix || ''}`.replace(/\{\{|\}\}/g, '') }, id, {}, style, layout, layout);
    layout.items.push(item.type === 'text' ? layoutText(item, id, values, style, layout, layout)
      : item.type === 'stack' ? layoutStack(item, id, values, style, layout, layout)
      : item.type === 'barcode' ? layoutBarcode(item, id, values, style, layout, layout)
      : item.type === 'date' ? date() : layoutShape(item, id, layout));
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
