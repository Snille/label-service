import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelLayout, labelMediaPresets, labelPostScript, testLabel } from '../src/labels.js';
import { layoutSvg } from '../src/svg.js';

test('label generation shares bounded layout, preserves Swedish glyphs and escapes PostScript syntax', () => {
  const layout = labelLayout(testLabel); assert.deepEqual(layout.warnings, []);
  const ps = labelPostScript(labelLayout({ title: 'Test (A) \\ B', description: 'ÅÄÖ åäö', location: 'A-H1-P1-A' })).toString('ascii');
  assert.match(ps, /PageSize \[162 90\]/); assert.match(ps, /\\305\\304\\326/); assert.match(ps, /\\\(A\\\)/);
  assert.equal(ps.match(/^showpage$/gm).length, 1);
  assert.ok(labelLayout({ ...testLabel, description: 'a long description '.repeat(30) }).warnings.includes('description'));
  assert.throws(() => labelLayout({ ...testLabel, title: '漢字' }));
});

test('a chosen text direction lays text out on the turned label and rotates only that PostScript page', () => {
  for (const media of labelMediaPresets) {
    const natural = labelLayout(testLabel, media.style, media.key), ps = labelPostScript(natural).toString('ascii');
    assert.equal(natural.rotated, false); assert.doesNotMatch(ps, /rotate/);
    const other = media.style.orientation === 'portrait' ? 'landscape' : 'portrait';
    const turned = labelLayout({ location: 'IVAR-A-H2-P1-A' }, { ...media.style, orientation: other }, media.key, 'location');
    assert.equal(turned.rotated, true); assert.deepEqual([turned.widthPt, turned.heightPt], [media.heightPt, media.widthPt]);
    const turnedPs = labelPostScript(turned).toString('ascii');
    assert.match(turnedPs, new RegExp(`PageSize \\[${media.widthPt} ${media.heightPt}\\]`));
    assert.match(turnedPs, new RegExp(`^${media.widthPt} 0 translate 90 rotate$`, 'm'));
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

test('the 102 x 210 mm shipping format uses a custom page with integer DSC bounds', () => {
  const media = labelMediaPresets.find(p => p.sku === '2166659');
  const ps = labelPostScript(labelLayout(testLabel, media.style, media.key)).toString('ascii');
  assert.match(ps, /^%%BoundingBox: 0 0 290 596$/m); assert.match(ps, /^%%HiResBoundingBox: 0 0 289.13 595.28$/m);
  assert.match(ps, /PageSize \[289.13 595.28\]/);
  assert.doesNotMatch(labelPostScript(labelLayout(testLabel)).toString('ascii'), /HiResBoundingBox/);
  for (const orientation of ['portrait', 'landscape']) assert.deepEqual(labelLayout(testLabel, { ...media.style, orientation }, media.key).warnings, []);
});

test('SVG preview escapes text and keeps the readable canvas size', () => {
  const svg = layoutSvg(labelLayout({ title: '<b>&"x"</b>', description: '', location: 'A' }));
  assert.match(svg, /viewBox="0 0 162 90"/); assert.match(svg, /&lt;b&gt;&amp;&quot;x&quot;&lt;\/b&gt;/); assert.doesNotMatch(svg, /<b>/);
});
