// Label template format v1. A template places objects on the readable label in millimetres or percentages of the
// label and fills their text from named fields ({{name}}). The three original label kinds are built-in templates.
import { InputError, object } from './validation.js';
import { labelMediaPresets, labelSizeKeys, labelOrientations } from './label-media.js';
import { fontFamilies } from './fonts.js';

export const templateId = /^[a-z0-9][a-z0-9-]{1,63}$/;
const fieldName = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const objectTypes = ['text', 'stack', 'line', 'rect', 'ellipse', 'barcode', 'date', 'image'];
export const assetId = /^[a-f0-9]{12}$/;
export const symbologies = ['code128', 'ean13', 'qrcode', 'datamatrix'];
export const twoDimensional = symbology => ['qrcode', 'datamatrix'].includes(symbology);
// Date formats use yyyy, yy, MM, dd, HH and mm; anything else is printed as it is.
const dateFormat = /^[\p{L}\p{N}\p{P}\p{Zs}]{1,40}$/u;
const fail = message => new InputError(`Invalid template: ${message}`);
const only = (value, keys, name) => {
  object(value, name);
  const extra = Object.keys(value).find(k => !keys.includes(k));
  if (extra) throw fail(`${name} has an unsupported property "${extra}".`);
};
const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const short = (value, max = 200) => typeof value === 'string' && value.length <= max;

// A length is millimetres (a number) or a share of the label side ("25%").
function length(value, name) {
  if (number(value, -50, 1000)) return;
  if (typeof value === 'string' && /^-?\d{1,3}(\.\d{1,4})?%$/.test(value) && Math.abs(parseFloat(value)) <= 200) return;
  throw fail(`${name} must be millimetres or a percentage such as "25%".`);
}
// Each axis takes two of start, end and size: x/left, right, w (and y/top, bottom, h).
function geometry(item, name) {
  for (const [start, end, size] of [['x', 'right', 'w'], ['y', 'bottom', 'h']]) {
    const given = [start, end, size].filter(k => item[k] !== undefined);
    if (given.length !== 2) throw fail(`${name} needs exactly two of ${start}, ${end} and ${size}.`);
    for (const k of given) length(item[k], `${name}.${k}`);
  }
}
// A font size is points, or a reference to a size saved for the loaded format ("$titleSize").
function size(value, name, { optional = true } = {}) {
  if (value === undefined && optional) return;
  if (number(value, 4, 200) || (typeof value === 'string' && labelSizeKeys.includes(value.slice(1)) && value[0] === '$')) return;
  throw fail(`${name} must be 4-200 points or a format size such as "$titleSize".`);
}
function font(item, name) {
  if (item.font === undefined) return;
  const family = fontFamilies.find(f => f.family === item.font);
  if (!family) throw fail(`${name}.font must be one of ${fontFamilies.map(f => f.family).join(', ')}.`);
  if (item.italic && !family.italic) throw fail(`${item.font} has no italic style.`);
}
const placeholders = text => [...text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map(m => m[1]);

export function validateTemplate(definition) {
  only(definition, ['id', 'name', 'description', 'media', 'orientation', 'fields', 'objects'], 'template');
  if (!templateId.test(definition.id || '') || builtInTemplates.some(t => t.id === definition.id)) throw fail('id must be 2-64 lower-case letters, digits or hyphens and not a built-in name.');
  if (!short(definition.name, 120) || !definition.name.trim()) throw fail('name is required (at most 120 characters).');
  if (definition.description !== undefined && !short(definition.description, 1000)) throw fail('description is at most 1000 characters.');
  if (!Array.isArray(definition.media) || !definition.media.length || definition.media.some(k => k !== '*' && !labelMediaPresets.some(p => p.key === k))
    || new Set(definition.media).size !== definition.media.length) throw fail(`media lists label formats (${labelMediaPresets.map(p => p.key).join(', ')}) or "*".`);
  if (definition.orientation !== undefined && !labelOrientations.includes(definition.orientation)) throw fail('orientation is portrait or landscape.');
  only(definition.fields, Object.keys(definition.fields || {}), 'fields');
  const fields = Object.entries(definition.fields);
  if (fields.length > 40) throw fail('at most 40 fields.');
  for (const [key, field] of fields) {
    if (!fieldName.test(key)) throw fail(`field name "${key}" must start with a letter and use letters, digits or _.`);
    if (field?.type === 'lines') {
      only(field, ['type', 'label', 'maxItems', 'sample'], `fields.${key}`);
      if (field.maxItems !== undefined && !(Number.isInteger(field.maxItems) && field.maxItems >= 1 && field.maxItems <= 50)) throw fail(`fields.${key}.maxItems is 1-50.`);
    } else if (field?.type === 'text') {
      only(field, ['type', 'label', 'required', 'maxLength', 'multiline', 'pattern', 'sample'], `fields.${key}`);
      if (field.maxLength !== undefined && !(Number.isInteger(field.maxLength) && field.maxLength >= 1 && field.maxLength <= 2000)) throw fail(`fields.${key}.maxLength is 1-2000.`);
      for (const flag of ['required', 'multiline']) if (field[flag] !== undefined && typeof field[flag] !== 'boolean') throw fail(`fields.${key}.${flag} is true or false.`);
      if (field.pattern !== undefined) { if (!short(field.pattern, 200)) throw fail(`fields.${key}.pattern is too long.`); try { new RegExp(field.pattern, 'u'); } catch { throw fail(`fields.${key}.pattern is not a valid regular expression.`); } }
      if (field.sample !== undefined && !short(field.sample, 2000)) throw fail(`fields.${key}.sample is text.`);
    } else throw fail(`fields.${key}.type is "text" or "lines".`);
    if (field.label !== undefined && !short(field.label, 120)) throw fail(`fields.${key}.label is at most 120 characters.`);
  }
  if (!Array.isArray(definition.objects) || !definition.objects.length || definition.objects.length > 200) throw fail('objects lists 1-200 objects.');
  const ids = new Set();
  for (const [index, item] of definition.objects.entries()) {
    const name = `objects[${index}]`;
    object(item, name);
    if (!objectTypes.includes(item.type)) throw fail(`${name}.type is one of ${objectTypes.join(', ')}.`);
    const common = ['id', 'type', 'x', 'y', 'w', 'h', 'right', 'bottom'];
    if (item.id !== undefined && (!fieldName.test(item.id) || ids.has(item.id))) throw fail(`${name}.id must be unique, start with a letter and use letters, digits or _.`);
    if (item.id) ids.add(item.id);
    geometry(item, name);
    if (item.type === 'text') {
      only(item, [...common, 'text', 'font', 'size', 'minSize', 'bold', 'italic', 'wrap', 'breakHyphens', 'align', 'valign', 'lineHeight', 'color'], name);
      if (!short(item.text, 4000)) throw fail(`${name}.text is required (at most 4000 characters).`);
      for (const ref of placeholders(item.text)) if (definition.fields[ref]?.type !== 'text') throw fail(`${name}.text uses {{${ref}}}, which is not a text field.`);
      size(item.size, `${name}.size`); size(item.minSize, `${name}.minSize`); font(item, name);
    } else if (item.type === 'stack') {
      only(item, [...common, 'items', 'font', 'size', 'minSize', 'align', 'valign', 'lineHeight', 'color'], name);
      const ref = placeholders(item.items || '')[0];
      if (typeof item.items !== 'string' || definition.fields[ref]?.type !== 'lines') throw fail(`${name}.items must be "{{field}}" naming a lines field.`);
      size(item.size, `${name}.size`); size(item.minSize, `${name}.minSize`); font(item, name);
    } else if (item.type === 'barcode') {
      only(item, [...common, 'symbology', 'data', 'humanReadable', 'font', 'size', 'align', 'valign', 'ecLevel'], name);
      if (!symbologies.includes(item.symbology)) throw fail(`${name}.symbology is one of ${symbologies.join(', ')}.`);
      if (!short(item.data, 2000) || !item.data) throw fail(`${name}.data is required (at most 2000 characters).`);
      for (const ref of placeholders(item.data)) if (definition.fields[ref]?.type !== 'text') throw fail(`${name}.data uses {{${ref}}}, which is not a text field.`);
      if (item.humanReadable !== undefined && (twoDimensional(item.symbology) || !['below', 'none'].includes(item.humanReadable))) throw fail(`${name}.humanReadable is below or none (linear barcodes only).`);
      if (item.ecLevel !== undefined && (item.symbology !== 'qrcode' || !['L', 'M', 'Q', 'H'].includes(item.ecLevel))) throw fail(`${name}.ecLevel is L, M, Q or H (QR codes only).`);
      size(item.size, `${name}.size`); font(item, name);
    } else if (item.type === 'image') {
      only(item, [...common, 'asset', 'fit', 'mode', 'threshold', 'invert', 'align', 'valign'], name);
      if (typeof item.asset !== 'string' || !assetId.test(item.asset)) throw fail(`${name}.asset is the id of an uploaded picture.`);
      if (item.fit !== undefined && !['contain', 'stretch'].includes(item.fit)) throw fail(`${name}.fit is contain or stretch.`);
      if (item.mode !== undefined && !['threshold', 'dither'].includes(item.mode)) throw fail(`${name}.mode is threshold or dither.`);
      if (item.threshold !== undefined && !(Number.isInteger(item.threshold) && item.threshold >= 1 && item.threshold <= 254)) throw fail(`${name}.threshold is 1-254.`);
      if (item.invert !== undefined && typeof item.invert !== 'boolean') throw fail(`${name}.invert is true or false.`);
    } else if (item.type === 'date') {
      only(item, [...common, 'format', 'prefix', 'suffix', 'font', 'size', 'minSize', 'bold', 'italic', 'align', 'valign', 'color'], name);
      if (item.format !== undefined && !dateFormat.test(item.format)) throw fail(`${name}.format is 1-40 characters such as "yyyy-MM-dd HH:mm".`);
      for (const key of ['prefix', 'suffix']) if (item[key] !== undefined && !short(item[key], 200)) throw fail(`${name}.${key} is at most 200 characters.`);
      size(item.size, `${name}.size`); size(item.minSize, `${name}.minSize`); font(item, name);
    } else {
      only(item, [...common, 'stroke', 'fill', 'radius', 'dash'], name);
      if (item.stroke !== undefined && !number(item.stroke, 0, 20)) throw fail(`${name}.stroke is 0-20 mm.`);
      if (item.fill !== undefined && (item.type === 'line' || !['none', 'black', 'white'].includes(item.fill))) throw fail(`${name}.fill is none, black or white (not on lines).`);
      if (item.radius !== undefined && (item.type !== 'rect' || !number(item.radius, 0, 100))) throw fail(`${name}.radius is 0-100 mm, on rectangles only.`);
      if (item.dash !== undefined && (!Array.isArray(item.dash) || item.dash.length > 8 || item.dash.some(d => !number(d, 0.1, 50)))) throw fail(`${name}.dash lists up to 8 lengths of 0.1-50 mm.`);
    }
    for (const flag of ['bold', 'italic', 'wrap', 'breakHyphens']) if (item[flag] !== undefined && typeof item[flag] !== 'boolean') throw fail(`${name}.${flag} is true or false.`);
    if (item.align !== undefined && !['left', 'center', 'right'].includes(item.align)) throw fail(`${name}.align is left, center or right.`);
    if (item.valign !== undefined && !['top', 'middle', 'bottom'].includes(item.valign)) throw fail(`${name}.valign is top, middle or bottom.`);
    if (item.lineHeight !== undefined && !number(item.lineHeight, 0.8, 3)) throw fail(`${name}.lineHeight is 0.8-3.`);
    if (item.color !== undefined && !['black', 'white'].includes(item.color)) throw fail(`${name}.color is black or white.`);
  }
  return definition;
}

const printable = /^[^\p{Cc}]*$/u;
// Field values for one label: every field is checked against its definition before layout.
export function validateFields(definition, input) {
  object(input, 'fields');
  for (const key of Object.keys(input)) if (!definition.fields[key]) throw new InputError('Unsupported label field.');
  const values = {};
  for (const [key, field] of Object.entries(definition.fields)) {
    const value = input[key];
    if (field.type === 'lines') {
      const max = field.maxItems || 12;
      if (!Array.isArray(value) || value.length < 1 || value.length > max) throw new InputError(`${key} must be an array of 1-${max} lines.`);
      for (const line of value) {
        object(line, 'line');
        if (Object.keys(line).some(k => !['text', 'bold', 'size'].includes(k)) || typeof line.text !== 'string' || line.text.length > 240
          || (line.bold !== undefined && typeof line.bold !== 'boolean') || (line.size !== undefined && (!Number.isInteger(line.size) || line.size < 6 || line.size > 16))) {
          throw new InputError('Each line is { text, bold?, size? } with text up to 240 characters and size 6-16 points.');
        }
        if (!printable.test(line.text)) throw new InputError('Line text cannot contain line breaks or control characters.');
      }
      values[key] = value;
    } else {
      const required = field.required !== false, max = field.maxLength || 240;
      if (value === undefined && !required) { values[key] = ''; continue; }
      if (typeof value !== 'string' || (required && !value.trim())) throw new InputError(`${key} must be a ${required ? 'non-empty ' : ''}string.`);
      if (value.length > max) throw new InputError(`${key} is longer than ${max} characters. Shorten the text.`);
      const text = field.multiline ? value.replace(/\r\n?/g, '\n') : value;
      if (!(field.multiline ? /^[^\p{Cc}]*$/u.test(text.replace(/[\n\t]/g, ' ')) : printable.test(text))) throw new InputError(`${key} contains line breaks or control characters that this field does not accept.`);
      if (field.pattern && value && !new RegExp(field.pattern, 'u').test(value)) throw new InputError(`${key} does not have the expected format.`);
      values[key] = text;
    }
  }
  return values;
}

export const fill = (text, values) => text.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_, key) => values[key] ?? '');

// Built-in templates: the original layouts, now in the template format. Horizontal margins are 3 mm (8.5 pt);
// vertical positions are the original shares of a 90-point label height.
const pct = points => `${+(points / 90 * 100).toFixed(4)}%`;
const band = (top, height) => ({ x: 3, right: 3, y: pct(top), h: pct(height) });
export const builtInTemplates = [
  { id: 'box', name: 'Box label', media: ['*'],
    fields: { title: { type: 'text', maxLength: 240, multiline: true, sample: 'Storage System TEST' }, description: { type: 'text', required: false, maxLength: 2000, multiline: true, sample: 'ÅÄÖ åäö - en testetikett' },
      location: { type: 'text', maxLength: 240, multiline: true } },
    objects: [
      { id: 'title', type: 'text', ...band(6, 20), text: '{{title}}', size: '$titleSize', minSize: 6, bold: true },
      { id: 'description', type: 'text', ...band(28.5, 39.5), text: '{{description}}', size: '$descriptionSize' },
      { id: 'location', type: 'text', ...band(71, 14), text: '{{location}}', size: '$locationSize', minSize: 6, bold: true }
    ] },
  { id: 'location', name: 'Location label', media: ['*'],
    fields: { location: { type: 'text', maxLength: 240, multiline: true } },
    objects: [{ id: 'location', type: 'text', ...band(6, 78), text: '{{location}}', size: '$locationLabelSize', minSize: 6, bold: true, breakHyphens: true, valign: 'middle' }] },
  { id: 'lines', name: 'Free lines', media: ['*'],
    fields: { lines: { type: 'lines', maxItems: 12 } },
    objects: [{ id: 'lines', type: 'stack', ...band(6, 78), items: '{{lines}}', size: 10, minSize: 6, valign: 'middle' }] }
];
export const builtInDescriptions = {
  box: { title: 'text, max 240', description: 'text, max 2000, may be empty', location: 'text, max 240' },
  location: { location: 'text, max 240; printed large' },
  lines: { lines: 'array of 1-12 { text (max 240, may be empty), bold?: boolean, size?: 6-16 points, default 10 }; shrunk together until they fit' }
};
