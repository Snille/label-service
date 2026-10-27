import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import opentype from 'opentype.js';
import { setup } from './service.test.js';
import { readZip } from '../src/zip.js';

const designer = { name: 'studio', role: 'designer' }, drafter = { name: 'mcp', role: 'drafter' };

// A made-up font with the letters A, B and space; the style comes from its subfamily name.
export function makeFont(familyName, styleName = 'Regular') {
  const glyph = (name, unicode, advanceWidth, draw) => { const path = new opentype.Path(); draw?.(path); return new opentype.Glyph({ name, unicode, advanceWidth, path }); };
  const box = (x0, x1) => p => { p.moveTo(x0, 0); p.lineTo(x1, 0); p.lineTo(x1, 700); p.lineTo(x0, 700); p.close(); };
  const font = new opentype.Font({ familyName, styleName, unitsPerEm: 1000, ascender: 800, descender: -200,
    glyphs: [glyph('.notdef', 0, 500), glyph('space', 32, 250), glyph('A', 65, 600, box(50, 550)), glyph('B', 66, 600, box(80, 520))] });
  return Buffer.from(font.toArrayBuffer());
}
// A zip archive with stored or deflated entries (the reader does not check CRCs).
export function makeZip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const { name, data, store = false } of entries) {
    const packed = store ? data : deflateRawSync(data), n = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(store ? 0 : 8, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(store ? 0 : 8, 10); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, packed); centrals.push(central, n); offset += 30 + n.length + packed.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const upload = (service, data, name = 'font.otf', client = designer) => service.uploadFont({ name, data: data.toString('base64') }, client);
const definition = (font, extra = {}) => ({ id: 'own-font', name: 'Own font', media: ['*'], fields: {}, objects: [{ id: 'title', type: 'text', x: 2, y: 2, w: 40, h: 10, text: 'AB BA', size: 12, font, ...extra }] });

test('the zip reader inflates stored and deflated entries and refuses damage', () => {
  const zip = makeZip([{ name: 'a/One.ttf', data: Buffer.from('one') }, { name: 'Two.otf', data: Buffer.from('two'.repeat(100)), store: true }]);
  assert.deepEqual(readZip(zip).map(e => [e.name, e.data.length]), [['a/One.ttf', 3], ['Two.otf', 300]]);
  assert.throws(() => readZip(zip.subarray(0, zip.length - 30)), /damaged/);
  assert.throws(() => readZip(zip, { maxEntryBytes: 100 }), /too large/);
});

test('an uploaded font family is used, previewed and drawn like a built-in one', async t => {
  const { service } = setup(t);
  const { fonts } = upload(service, makeFont('Test Sans'), 'TestSans-Regular.otf');
  assert.deepEqual([fonts[0].family, fonts[0].style, fonts[0].format, fonts[0].createdBy], ['Test Sans', 'regular', 'otf', 'studio']);
  const family = service.formats().fonts.find(f => f.family === 'Test Sans');
  assert.deepEqual([family.uploaded, family.regular, family.bold, family.files.regular], [true, true, false, fonts[0].id]);
  const p = await service.preview({ template: definition('Test Sans'), test: true }, designer);
  assert.equal(p.printable, true); assert.match(p.svg, /aria-label="AB BA"/);
  // A style the family lacks, and a character the font lacks.
  assert.throws(() => service.saveTemplate({ definition: definition('Test Sans', { bold: true }) }, designer), /has no bold style/);
  await assert.rejects(service.preview({ template: { ...definition('Test Sans'), objects: [{ ...definition('Test Sans').objects[0], text: 'ABC' }] }, test: true }, designer), /"C" is not available in the font Test Sans/);
  assert.equal(service.fontContent(fonts[0].id, drafter).data.length, fonts[0].bytes);
});

test('a zip adds each style once and names what it skipped', t => {
  const { service } = setup(t);
  upload(service, makeFont('Test Serif', 'Bold'), 'TestSerif-Bold.otf');
  const zip = makeZip([{ name: 'Test Serif/TestSerif-Regular.otf', data: makeFont('Test Serif') }, { name: 'Test Serif/TestSerif-Bold.otf', data: makeFont('Test Serif', 'Bold') },
    { name: 'Test Serif/TestSerif-Italic.otf', data: makeFont('Test Serif', 'Italic') }, { name: '__MACOSX/._TestSerif-Regular.otf', data: Buffer.from('junk') },
    { name: 'readme.txt', data: Buffer.from('hello') }, { name: 'Broken.ttf', data: Buffer.from('not a font') }]);
  const result = upload(service, zip, 'Test Serif.zip');
  assert.deepEqual(result.fonts.map(f => f.style), ['regular', 'italic']);
  assert.deepEqual(result.skipped.map(s => s.name), ['TestSerif-Bold.otf', 'Broken.ttf']);
  const family = service.formats().fonts.find(f => f.family === 'Test Serif');
  assert.deepEqual([family.regular, family.bold, family.italic, family.boldItalic], [true, true, true, false]);
});

test('fonts are checked: kind, names, built-in families, roles and size', t => {
  const { service } = setup(t);
  assert.throws(() => upload(service, Buffer.from('wOF2rest of file')), /WOFF2/);
  assert.throws(() => upload(service, Buffer.from('plain text')), /not a TrueType/);
  const liberation = readFileSync(new URL('../fonts/LiberationSans-Regular.ttf', import.meta.url));
  assert.throws(() => upload(service, liberation), /built in already/);
  assert.throws(() => upload(service, makeFont('Bad "Name"')), /cannot be used/);
  assert.throws(() => upload(service, makeFont('Test Sans'), 'x.otf', drafter), { status: 403 });
  assert.throws(() => upload(service, Buffer.alloc(8 * 1024 * 1024 + 1)), { status: 413 });
  upload(service, makeFont('Test Sans'));
  assert.throws(() => upload(service, makeFont('Test Sans')), /uploaded already/);
  assert.throws(() => upload(service, makeFont('TEST SANS', 'Bold')), /spelled differently/);
  assert.throws(() => upload(service, makeZip([{ name: 'readme.txt', data: Buffer.from('x') }]), 'empty.zip'), /holds no/);
});

test('a font that a saved template uses cannot be deleted, and a deleted font is gone from the layout', async t => {
  const { service } = setup(t);
  const regular = upload(service, makeFont('Test Sans')).fonts[0], bold = upload(service, makeFont('Test Sans', 'Bold')).fonts[0];
  service.saveTemplate({ definition: definition('Test Sans') }, designer);
  assert.throws(() => service.deleteFont(regular.id, designer), /used by own-font/);
  assert.throws(() => service.deleteFont(bold.id, drafter), { status: 403 });
  assert.equal(service.deleteFont(bold.id, designer).deleted, 1);
  assert.equal(service.formats().fonts.find(f => f.family === 'Test Sans').bold, false);
  await assert.rejects(service.preview({ template: definition('Test Sans', { bold: true }), test: true }, designer), /has no bold style/);
});

test('uploaded fonts come back when the service starts again', async t => {
  const { service, store } = setup(t);
  upload(service, makeFont('Test Mono'));
  const { PrintService } = await import('../src/service.js');
  const again = new PrintService(store, { defaults: { serverUrl: 'http://cups:631', queue: 'DYMO_5XL' } });
  assert.ok(again.formats().fonts.some(f => f.family === 'Test Mono'));
});
