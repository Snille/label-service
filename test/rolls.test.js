import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from './service.test.js';
import { calibrationTemplate } from '../src/template.js';
import { layoutTemplate } from '../src/labels.js';
import { labelMediaPresets, customMedia } from '../src/label-media.js';
import { evaluate, printPage, dotsSent } from '../src/calibration.js';

// Made-up test data: the roll and the printer do not exist.
const roll = { sku: 'S0700001', name: 'Test roll', widthMm: 40, heightMm: 30, status: 'testing' };
const key = 'custom_40x30mm_40x30mm';
// From each edge of the label to its frame line (5 mm inside), as on a test print that is true to size but lands
// 1.5 mm to the right and 2 mm low.
const distances = { left: 6.5, right: 3.5, top: 7, bottom: 3 };
const margins = { left: 1.5, right: 1, top: 2, bottom: 1 };
const update = (service, change) => { const config = structuredClone(service.config()); change(config); return service.save({ revision: service.revision(), config }); };
const designer = { name: 'studio', role: 'designer' };
const shape = (id, extra) => ({ id: 'edge-test', name: 'Edge test', media: [key], fields: {}, objects: [{ id, type: 'rect', ...extra }] });
const approve = (service, rollKey, requestId, d, check) => service.approveRoll({ revision: service.revision(), key: rollKey, requestId, distances: d, ...(check ? { check } : {}) }, 'admin');

async function testPrint(service) {
  const p = await service.preview({ kind: 'calibration', test: true }, 'admin');
  return service.submit({ token: p.token, requestId: randomUUID() }, 'admin');
}

test('the test label fits every roll, with a frame line inside each edge', () => {
  for (const media of [...labelMediaPresets, customMedia(roll), customMedia({ ...roll, widthMm: 10, heightMm: 10 }), customMedia({ ...roll, widthMm: 110, heightMm: 400 })]) {
    const definition = calibrationTemplate(media), layout = layoutTemplate(definition, {}, { media, style: media.style });
    assert.deepEqual(layout.problems, [], media.key);
    for (const side of ['top', 'right', 'bottom', 'left']) assert.ok(definition.objects.some(o => o.id === `${side}_line`));
  }
});

test('the calibration follows the owner\'s measurements of the shipping labels and the 57 x 32 mm roll', () => {
  // 2166659, true to size: left -1.3, right +1.6, top +0.4, bottom -1.0 as read on the old rulers, that is from each
  // edge to the frame line 6.3, 3.4, 4.6 and 6.0 mm.
  const shipping = labelMediaPresets.find(p => p.sku === '2166659');
  assert.deepEqual(evaluate(shipping, { left: 6.3, right: 3.4, top: 4.6, bottom: 6 }), { scale: 1, scaleY: 1, offset: { x: -1.45, y: 0.7 }, margins: { left: 1.3, right: 1, top: 1, bottom: 1 } });
  // S0722540 on the 5XL prints on a custom page 10 pt wider than the label, drawn from its left edge, because the named
  // size w162h90 makes the printer shrink the print; a printer with a narrow head keeps the named size.
  const small = labelMediaPresets.find(p => p.sku === 'S0722540');
  assert.deepEqual(printPage(small), { key: 'custom_60.68x31.75mm_60.68x31.75mm', widthPt: 172, heightPt: 90, dx: 0, dy: 0, widthMm: 60.68, heightMm: 31.75, custom: true });
  assert.equal(printPage(small, { wideHead: false }).key, 'w162h90');
  // Every named roll gets a custom page that CUPS cannot take for a named size (checked with cupsfilter: 172, 90, 82 and
  // 186 pt wide pages gave rasters of the full page).
  assert.deepEqual(labelMediaPresets.filter(p => !p.key.startsWith('custom_')).map(p => printPage(p).widthPt), [172, 90, 82, 186]);
  assert.equal(dotsSent(small), 720);
  // True to size and 0.75 mm to the right, as the 60 mm test page printed: one test print calibrates it.
  assert.deepEqual(evaluate(small, { left: 5.75, right: 4.25, top: 5, bottom: 5 }), { scale: 1, scaleY: 1, offset: { x: -0.75, y: 0 }, margins: { left: 1, right: 1, top: 1, bottom: 1 } });
  // A print that still shrinks gets a narrower image.
  const shrunk = evaluate(small, { left: 7.5, right: 7.55, top: 6.2, bottom: 6.25 });
  assert.deepEqual([shrunk.shrink, shrunk.scale, shrunk.maxDots], [true, 0.89, 632]);
  // The next test print goes on a page as wide as the printer takes, with the label centred on it.
  const narrow = { ...small, maxDots: 576 };
  assert.deepEqual(printPage(narrow), { key: 'custom_48.77x31.75mm_48.77x31.75mm', widthPt: 138.24, heightPt: 90, dx: -11.88, dy: 0, widthMm: 48.77, heightMm: 31.75, custom: true });
  assert.equal(dotsSent(narrow), 576);
  // Read on that print, true to size: the page covers 48.8 mm of the label, so the sides keep about 4 mm.
  const fixed = evaluate(narrow, { left: 5.4, right: 4.45, top: 5, bottom: 5 });
  assert.deepEqual(fixed, { scale: 1, scaleY: 1, offset: { x: -0.45, y: 0 }, margins: { left: 4.6, right: 3.7, top: 1, bottom: 1 } });
  assert.match(String(evaluate(small, { left: 2, right: 2, top: 5, bottom: 5 }).invalid), /true/);
});

test('a new roll prints only its test label until its test print is approved', async t => {
  const { service, store } = setup(t);
  update(service, c => { c.rolls.push(roll); });
  const view = service.view(), media = view.mediaPresets.find(p => p.key === key);
  assert.deepEqual([media.status, media.sku, media.custom, media.widthPt, media.heightPt], ['testing', 'S0700001', true, 113.39, 85.04]);
  // Every printer gets text sizes for the new roll; clients do not see it yet, and templates cannot name it.
  assert.ok(view.config.printers[0].styles[key]);
  assert.equal(service.formats().mediaPresets.some(p => p.key === key), false);
  assert.throws(() => service.saveTemplate({ definition: shape('box', { x: 2, y: 2, w: 10, h: 10 }) }, designer), /media lists/);
  // Approval cannot be written through the settings.
  const test = { requestId: randomUUID(), approvedAt: new Date().toISOString(), approvedBy: 'admin' };
  assert.throws(() => update(service, c => { c.rolls[0] = { ...c.rolls[0], status: 'approved', margins, offset: { x: 0, y: 0 }, test }; }), /approved with its test print/);
  assert.throws(() => update(service, c => { c.rolls.push({ ...roll, sku: 'S0700002', widthMm: 41, status: 'approved' }); }), /starts as testing/);

  update(service, c => { c.printers[0].mediaKey = key; });
  await assert.rejects(service.preview({ test: true }, 'storagesystem'), /not approved yet/);
  await assert.rejects(service.preview({ test: true }, 'admin'), /not approved yet/);
  await assert.rejects(service.preview({ kind: 'calibration', test: true }, 'storagesystem'), { status: 403 });
  assert.throws(() => approve(service, key, randomUUID(), distances), /Print the test label/);

  const job = await testPrint(service);
  assert.deepEqual([job.kind, job.mediaKey, job.state, job.printMedia], ['calibration', key, 'submitted', undefined]);
  assert.throws(() => approve(service, key, job.id, { ...distances, top: 40 }), /0-30 mm/);
  assert.throws(() => approve(service, key, job.id, { ...distances, left: 1, right: 1 }), /scale of 127 %/);
  const approved = approve(service, key, job.id, distances);
  const saved = approved.config.rolls[0];
  assert.deepEqual([saved.status, saved.margins, saved.offset, saved.test.requestId, saved.test.approvedBy], ['approved', margins, { x: -1.5, y: -2 }, job.id, 'admin']);
  assert.deepEqual(approved.result.offset, { x: -1.5, y: -2 });
  // The same test print cannot be used twice: the calibration it was made with has changed.
  assert.throws(() => approve(service, key, job.id, distances), /Print the test label again/);
  assert.equal(service.formats().mediaPresets.find(p => p.key === key).status, 'approved');
  // Labels on the roll are now drawn 1.5 mm to the left and 2 mm higher, so they land in place.
  const p = await service.preview({ test: true }, 'storagesystem');
  assert.equal(p.printable, true);
  assert.deepEqual([p.layout.print.dx, p.layout.print.dy, p.layout.print.key], [-4.25, -5.67, key]);
  // The name and article may change later; the approval stays.
  update(service, c => { c.rolls[0].name = 'Renamed'; });
  assert.equal(service.config().rolls[0].status, 'approved');
  assert.equal(store.audit().ok, true);
});

test('a built-in format prints on a wider custom page and is calibrated with one test print', async t => {
  const { service, state, store } = setup(t);
  const edge = { id: 'edge-57', name: 'Edge 57', media: ['w162h90'], fields: {}, objects: [{ id: 'frame', type: 'rect', x: 0.5, y: 3, w: 20, h: 10 }] };
  service.saveTemplate({ definition: edge }, designer);
  const first = await testPrint(service);
  assert.deepEqual([first.mediaKey, first.printMedia], ['w162h90', 'custom_60.68x31.75mm_60.68x31.75mm']);
  const read = { left: 5.75, right: 4.25, top: 5, bottom: 5 };
  // The built-in labels keep 3 mm at the sides; the saved frame, 0.5 mm from the left, would stop printing.
  const check = approve(service, 'w162h90', first.id, read, true);
  assert.deepEqual(check.affected.map(a => [a.id, a.objects]), [['edge-57', ['frame']]]);
  assert.equal(service.config().measured.w162h90, undefined);
  approve(service, 'w162h90', first.id, read);
  assert.deepEqual(service.config().measured.w162h90.page, 'custom');
  assert.deepEqual([service.formats().media.margins, service.formats().media.offset], [{ left: 1, right: 1, top: 1, bottom: 1 }, { x: -0.75, y: 0 }]);
  const box = await service.preview({ test: true }, 'storagesystem');
  assert.deepEqual([box.printable, box.layout.print.dx], [true, -2.13]);
  const job = await service.submit({ token: box.token, requestId: randomUUID() }, 'storagesystem');
  assert.equal(job.printMedia, 'custom_60.68x31.75mm_60.68x31.75mm');
  assert.ok(state.document.length > 0);
  // Not through the settings.
  assert.throws(() => update(service, c => { c.measured.w162h90.margins.left = 2; }), /only with its approved test print/);
  assert.throws(() => update(service, c => { delete c.measured.w162h90; }), /only with its approved test print/);
  assert.throws(() => approve(service, 'w54h144', first.id, read), /Print the test label/);
  // A calibration from before 0.15.2, measured on the named page, is dropped.
  const config = service.config(); config.measured.w162h90 = { maxDots: 576, test: config.measured.w162h90.test };
  store.writePrinting(config);
  assert.deepEqual(service.config().measured, {});
});

test('a test print that did not reach the printer cannot be approved', async t => {
  const { service, state } = setup(t);
  update(service, c => { c.rolls.push(roll); c.printers[0].mediaKey = key; });
  state.fail = true;
  const job = await testPrint(service);
  assert.equal(job.state, 'unknown');
  assert.throws(() => approve(service, key, job.id, distances), /did not reach the printer/);
});

test('measured edges are edges a template must keep clear of, in both text directions', async t => {
  const { service } = setup(t);
  update(service, c => { c.rolls.push(roll); c.printers[0].mediaKey = key; });
  approve(service, key, (await testPrint(service)).id, distances);
  const fits = await service.preview({ template: shape('box', { x: 1.5, y: 2, w: 37.5, h: 27 }), test: true }, designer);
  assert.equal(fits.printable, true);
  const left = await service.preview({ template: shape('box', { x: 0.5, y: 2, w: 10, h: 10 }), test: true }, designer);
  assert.equal(left.printable, false); assert.match(left.warnings[0].message, /"box" reaches into the edge that this roll does not print: 1\.5 mm on the left\./);
  assert.deepEqual(left.layout.margins, margins);
  // Turned a quarter, the label's top edge becomes the canvas's right side (pageSvg: canvas (u, v) -> page (v, H - u)).
  const turned = await service.preview({ template: { ...shape('box', { x: 2, y: 2, right: 1.5, h: 10 }), orientation: 'portrait' }, test: true }, designer);
  assert.deepEqual(turned.layout.margins, { top: 1.5, right: 2, bottom: 1, left: 1 });
  assert.match(turned.warnings[0].message, /2 mm on the right/);
  // The test print itself ignores the margins it measures, so the roll can be measured again.
  assert.equal((await service.preview({ kind: 'calibration', test: true }, 'admin')).printable, true);
});

test('a roll that a template or printer uses cannot be removed', async t => {
  const { service } = setup(t);
  update(service, c => { c.rolls.push(roll); c.printers[0].mediaKey = key; });
  assert.throws(() => update(service, c => { c.rolls = []; }), /label format that this printer model supports/);
  approve(service, key, (await testPrint(service)).id, distances);
  service.saveTemplate({ definition: shape('box', { x: 2, y: 2, w: 10, h: 10 }) }, designer);
  update(service, c => { c.printers[0].mediaKey = 'w162h90'; });
  assert.throws(() => update(service, c => { c.rolls = []; }), /used by the templates edge-test/);
});

test('rolls are checked: article numbers, sizes and duplicates', t => {
  const { service } = setup(t);
  for (const [bad, pattern] of [[{ sku: 'TEST-1' }, /article number/], [{ widthMm: 5 }, /10-110 mm/], [{ heightMm: 30.25 }, /steps of 0.1/],
    [{ sku: 'S0722540' }, /same article/], [{ extra: 1 }, /Unsupported roll/]]) {
    assert.throws(() => update(service, c => { c.rolls.push({ ...roll, ...bad }); }), pattern);
  }
  update(service, c => { c.rolls.push(roll); });
  assert.throws(() => update(service, c => { c.rolls.push({ ...roll, sku: 'S0700002' }); }), /same size/);
  // A roll wider than 62 mm needs a wide printer model.
  update(service, c => { c.rolls.push({ ...roll, sku: 'S0700003', widthMm: 89, heightMm: 36 }); });
  assert.equal(service.view().models.find(m => m.key === 'lw550t').media.includes('custom_89x36mm_89x36mm'), false);
  assert.equal(service.view().models.find(m => m.key === 'lw5xl').media.includes('custom_89x36mm_89x36mm'), true);
});

test('printers added with an address are written to the queue file for the cups container', t => {
  const { service } = setup(t), dir = mkdtempSync(join(tmpdir(), 'label-queues-')), file = join(dir, 'queues.txt');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const added = { id: 'test-550', name: 'LabelWriter 550 Turbo (test)', model: 'lw550t', enabled: true, queue: 'DYMO_TEST_550', device: 'socket://printer-test.invalid:9100',
    mediaKey: 'w162h90', styles: {}, rollReader: { enabled: false, host: '', port: 9100 } };
  assert.throws(() => update(service, c => { c.printers.push(added); }), /cannot create CUPS queues/);
  service.queuesFile = file;
  update(service, c => { c.printers.push(added); });
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(l => l && !l.startsWith('#')).join('\n'), 'DYMO_TEST_550 lw550t socket://printer-test.invalid:9100');
  assert.ok(service.config().printers[1].styles.w54h144);
  // The 102 mm shipping labels need a wide model.
  assert.throws(() => update(service, c => { c.printers[1].mediaKey = 'custom_102x210mm_102x210mm'; }), /label format that this printer model supports/);
  for (const device of ['http://printer.invalid', 'socket://bad host', 'socket://printer.invalid:99999', 'usb://a b']) {
    assert.throws(() => update(service, c => { c.printers[1].device = device; }), /network address/);
  }
  update(service, c => { c.printers.pop(); });
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(l => l && !l.startsWith('#')).length, 0);
});
