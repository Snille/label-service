import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { labelLayout, labelMediaPresets, layoutTemplate, testLabel } from '../src/labels.js';
import { layoutSvg, pageSvg } from '../src/svg.js';
import { validateTemplate, builtInTemplates } from '../src/template.js';
import { rsvgConvert } from '../src/convert.js';

test('the box label keeps the original positions, real font metrics and Swedish glyphs', () => {
  const layout = labelLayout(testLabel); assert.deepEqual(layout.warnings, []);
  // Baselines sit where the accepted PostScript placed them: band top plus the font size.
  assert.deepEqual(layout.lines.map(l => [l.text, l.size, l.y]), [['Storage System TEST', 11, 17], ['ÅÄÖ åäö - en testetikett', 8, 36.5], ['TEST - 57 x 32 mm', 8, 79]]);
  assert.ok(layout.lines.every(l => l.x === 81 && l.width <= 162 - 17));
  const page = pageSvg(labelLayout({ title: 'Test (A) \\ B', description: 'ÅÄÖ åäö', location: 'A-H1-P1-A' }));
  assert.match(page, /viewBox="0 0 162 90"/); assert.match(page, /aria-label="ÅÄÖ åäö"/); assert.doesNotMatch(page, /<text/);
  assert.ok(labelLayout({ ...testLabel, description: 'a long description '.repeat(30) }).warnings.includes('description'));
  assert.throws(() => labelLayout({ ...testLabel, title: '漢字' }), /not available in the font/);
});

test('a chosen text direction lays text out on the turned label and rotates only the printed page', () => {
  for (const media of labelMediaPresets) {
    const natural = labelLayout(testLabel, media.style, media.key);
    assert.equal(natural.rotated, false); assert.doesNotMatch(pageSvg(natural), /matrix/);
    const other = media.style.orientation === 'portrait' ? 'landscape' : 'portrait';
    const turned = labelLayout({ location: 'IVAR-A-H2-P1-A' }, { ...media.style, orientation: other }, media.key, 'location');
    assert.equal(turned.rotated, true); assert.deepEqual([turned.widthPt, turned.heightPt], [media.heightPt, media.widthPt]);
    const page = pageSvg(turned);
    assert.ok(page.includes(`viewBox="0 0 ${media.widthPt} ${media.heightPt}"`));
    assert.ok(page.includes(`<g transform="matrix(0 -1 1 0 0 ${media.heightPt})">`));
    assert.ok(layoutSvg(turned).includes(`viewBox="0 0 ${media.heightPt} ${media.widthPt}"`));
  }
});

test('location labels fit compact codes on every format and reject box fields', () => {
  for (const media of labelMediaPresets) {
    const layout = labelLayout({ location: 'IVAR-A-H2-P1-A' }, media.style, media.key, 'location');
    assert.deepEqual(layout.warnings, [], media.key);
    assert.equal(layout.lines.map(line => line.text).join(''), 'IVAR-A-H2-P1-A');
  }
  assert.ok(labelLayout({ location: 'Lagerhylla A '.repeat(18) }, labelMediaPresets[1].style, 'w54h144', 'location').warnings.includes('location'));
  assert.throws(() => labelLayout({ title: 'x', location: 'A' }, null, 'w162h90', 'location'), /Unsupported label field/);
});

test('the 102 x 210 mm shipping format keeps its fractional page size', () => {
  const media = labelMediaPresets.find(p => p.sku === '2166659');
  assert.match(pageSvg(labelLayout(testLabel, media.style, media.key)), /viewBox="0 0 289.13 595.28" width="289.13pt" height="595.28pt"/);
  for (const orientation of ['portrait', 'landscape']) assert.deepEqual(labelLayout(testLabel, { ...media.style, orientation }, media.key).warnings, []);
});

test('free lines keep their order, shrink together to fit and validate each line', () => {
  const lines = [{ text: 'Kabel HDMI 2 m', bold: true, size: 14 }, { text: '' }, { text: 'Rack 3, port 12' }];
  const layout = labelLayout({ lines }, labelMediaPresets[0].style, 'w162h90', 'lines');
  assert.deepEqual(layout.warnings, []); assert.deepEqual(layout.lines.map(l => l.text), ['Kabel HDMI 2 m', 'Rack 3, port 12']);
  assert.ok(layout.lines[0].bold && layout.lines[0].size > layout.lines[1].size);
  assert.ok(layout.lines[0].y < layout.lines[1].y);
  const crowded = labelLayout({ lines: Array.from({ length: 6 }, (_, i) => ({ text: `Rad ${i + 1}`, size: 16 })) }, labelMediaPresets[0].style, 'w162h90', 'lines');
  assert.deepEqual(crowded.warnings, []); assert.ok(crowded.lines.every(l => l.size < 16 && l.size >= 6));
  assert.ok(labelLayout({ lines: Array.from({ length: 12 }, () => ({ text: 'lång rad med många ord '.repeat(8).slice(0, 200) })) }, labelMediaPresets[1].style, 'w54h144', 'lines').warnings.includes('lines'));
  for (const bad of [[], Array(13).fill({ text: 'x' }), [{ text: 'x', size: 20 }], [{ text: 'x', color: 'red' }], [{ text: 'a\nb' }], [{ text: '漢字' }], [{ text: 5 }]]) {
    assert.throws(() => labelLayout({ lines: bad }, null, 'w162h90', 'lines'));
  }
  assert.throws(() => labelLayout({ title: 'x' }, null, 'w162h90', 'lines'), /Unsupported label field/);
});

const shipping = {
  id: 'shipping-small', name: 'Fraktetikett liten', media: ['w154h286'], orientation: 'portrait',
  fields: { recipient: { type: 'text', maxLength: 200, multiline: true }, orderNo: { type: 'text', pattern: '^[0-9]{6,10}$', required: false } },
  objects: [
    { type: 'rect', x: 2, y: 2, right: 2, h: 12, stroke: 0.4, radius: 1.5 },
    { id: 'recipient', type: 'text', x: 4, y: 16, right: 4, h: 30, text: '{{recipient}}', font: 'Liberation Serif', size: 12, minSize: 7, align: 'left' },
    { type: 'line', x: 2, y: 48, right: 2, h: 0, dash: [1, 0.5] },
    { id: 'order', type: 'text', x: 4, y: '55%', w: '50%', h: 6, text: 'Order {{orderNo}}', font: 'Liberation Mono', bold: true, size: 9, align: 'right' },
    { type: 'ellipse', right: 4, bottom: 4, w: 10, h: 10, fill: 'black' }
  ]
};

test('saved templates validate strictly and lay out text, lines, rectangles and ellipses', () => {
  validateTemplate(structuredClone(shipping));
  const media = labelMediaPresets.find(p => p.key === 'w154h286');
  const layout = layoutTemplate(shipping, { recipient: 'Erik Exempel\nStorgatan 1\n123 45 Åstorp', orderNo: '1234567' }, { media, style: media.style });
  assert.deepEqual(layout.problems, []); assert.equal(layout.orientation, 'portrait');
  assert.deepEqual(layout.items.map(i => i.type), ['rect', 'text', 'line', 'text', 'ellipse']);
  assert.equal(layout.items[1].rows.length, 3); assert.ok(layout.items[1].rows.every(r => Math.abs(r.x - 4 * 72 / 25.4) < 0.01));
  const svg = layoutSvg(layout);
  assert.match(svg, /<rect x="5.669" y="5.669" width="142.661" height="34.016" rx="4.252" fill="none" stroke="black"/);
  assert.match(svg, /stroke-dasharray="2.835 1.417"/); assert.match(svg, /<ellipse [^>]*fill="black"/);
  const crowded = layoutTemplate(shipping, { recipient: 'Adressrad\n'.repeat(15) }, { media, style: media.style });
  assert.equal(crowded.problems[0].object, 'recipient'); assert.match(crowded.problems[0].message, /needs \d+ rows, but \d+ fit at 7 pt/);
  assert.throws(() => layoutTemplate(shipping, { recipient: 'A', orderNo: '12' }, { media, style: media.style }), /expected format/);
  assert.throws(() => layoutTemplate(shipping, { recipient: 'A', extra: 'x' }, { media, style: media.style }), /Unsupported label field/);
  for (const [change, pattern] of [
    [d => { d.id = 'box'; }, /built-in/], [d => { d.media = ['nope']; }, /media/], [d => { d.objects[1].text = '{{missing}}'; }, /not a text field/],
    [d => { d.objects[1].font = 'Comic Sans'; }, /font/], [d => { d.objects[1].italic = true; }, /no italic/], [d => { delete d.objects[0].h; }, /exactly two/],
    [d => { d.objects[0].x = '120%%'; }, /millimetres or a percentage/], [d => { d.objects[1].script = 'x'; }, /unsupported property/],
    [d => { d.objects[1].size = '$nope'; }, /points/], [d => { d.fields.orderNo.pattern = '('; }, /regular expression/], [d => { d.objects = []; }, /objects/]
  ]) {
    const bad = structuredClone(shipping); change(bad); assert.throws(() => validateTemplate(bad), pattern);
  }
  assert.ok(builtInTemplates.every(t => t.objects.length));
});

// Runs where librsvg is installed (the Docker build); skipped on a development machine without it.
const rsvg = spawnSync(process.env.RSVG_CONVERT || 'rsvg-convert', ['--version']).status === 0;
test('rsvg-convert turns the page into a PDF of the exact label size and the preview into a PNG', { skip: !rsvg && 'rsvg-convert is not installed' }, async () => {
  for (const media of labelMediaPresets) {
    const layout = labelLayout(testLabel, media.style, media.key), pdf = (await rsvgConvert(pageSvg(layout), 'pdf')).toString('latin1');
    assert.match(pdf, /^%PDF-/);
    const box = pdf.match(/\/MediaBox \[\s*([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)\s*\]/).slice(1).map(Number);
    assert.ok(Math.abs(box[2] - box[0] - media.widthPt) < 0.01 && Math.abs(box[3] - box[1] - media.heightPt) < 0.01, `${media.key}: ${box}`);
  }
  const png = await rsvgConvert(layoutSvg(labelLayout(testLabel)), 'png');
  assert.equal(png.readUInt32BE(16), 675); assert.equal(png.readUInt32BE(20), 375);
});
