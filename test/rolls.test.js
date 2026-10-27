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

// Made-up test data: the roll and the printer do not exist.
const roll = { sku: 'S0700001', name: 'Test roll', widthMm: 40, heightMm: 30, status: 'testing' };
const key = 'custom_40x30mm_40x30mm';
const margins = { top: 1.5, right: 0.5, bottom: 1.5, left: 1 };
const update = (service, change) => { const config = structuredClone(service.config()); change(config); return service.save({ revision: service.revision(), config }); };
const designer = { name: 'studio', role: 'designer' };
const shape = (id, extra) => ({ id: 'edge-test', name: 'Edge test', media: [key], fields: {}, objects: [{ id, type: 'rect', ...extra }] });

async function testPrint(service) {
  const p = await service.preview({ kind: 'calibration', test: true }, 'admin');
  return service.submit({ token: p.token, requestId: randomUUID() }, 'admin');
}

test('the test label fits every roll edge to edge, with a ruler on each side', () => {
  for (const media of [...labelMediaPresets, customMedia(roll), customMedia({ ...roll, widthMm: 10, heightMm: 10 }), customMedia({ ...roll, widthMm: 110, heightMm: 400 })]) {
    const definition = calibrationTemplate(media), layout = layoutTemplate(definition, {}, { media, style: media.style });
    assert.deepEqual(layout.problems, [], media.key);
    for (const side of ['top', 'right', 'bottom', 'left']) assert.ok(definition.objects.some(o => o.id === `${side}_ruler`));
  }
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
  assert.throws(() => update(service, c => { c.rolls[0] = { ...c.rolls[0], status: 'approved', margins, test: { requestId: randomUUID(), approvedAt: new Date().toISOString(), approvedBy: 'admin' } }; }), /approved with its test print/);
  assert.throws(() => update(service, c => { c.rolls.push({ ...roll, sku: 'S0700002', widthMm: 41, status: 'approved' }); }), /starts as testing/);

  update(service, c => { c.printers[0].mediaKey = key; });
  await assert.rejects(service.preview({ test: true }, 'storagesystem'), /not approved yet/);
  await assert.rejects(service.preview({ test: true }, 'admin'), /not approved yet/);
  await assert.rejects(service.preview({ kind: 'calibration', test: true }, 'storagesystem'), { status: 403 });
  assert.throws(() => service.approveRoll({ revision: service.revision(), key, requestId: randomUUID(), margins }, 'admin'), /Print the test label/);

  const job = await testPrint(service);
  assert.deepEqual([job.kind, job.mediaKey, job.state], ['calibration', key, 'submitted']);
  assert.throws(() => service.approveRoll({ revision: service.revision(), key, requestId: job.id, margins: { ...margins, top: 11 } }, 'admin'), /0-10 mm/);
  const approved = service.approveRoll({ revision: service.revision(), key, requestId: job.id, margins }, 'admin');
  const saved = approved.config.rolls[0];
  assert.deepEqual([saved.status, saved.margins, saved.test.requestId, saved.test.approvedBy], ['approved', margins, job.id, 'admin']);
  assert.equal(service.formats().mediaPresets.find(p => p.key === key).status, 'approved');
  assert.equal((await service.preview({ test: true }, 'storagesystem')).printable, true);
  // The name and article may change later; the approval stays.
  update(service, c => { c.rolls[0].name = 'Renamed'; });
  assert.equal(service.config().rolls[0].status, 'approved');
  assert.equal(store.audit().ok, true);
});

test('a built-in format is measured the same way, and the approval first names the templates that reach into the margins', async t => {
  const { service } = setup(t);
  const job = await testPrint(service);
  assert.equal(job.mediaKey, 'w162h90');
  const edge = { id: 'edge-57', name: 'Edge 57', media: ['w162h90'], fields: {}, objects: [{ id: 'frame', type: 'rect', x: 0.5, y: 3, w: 20, h: 10 }] };
  service.saveTemplate({ definition: edge }, designer);
  // 3 mm on top reaches the built-in box label's title band (6/90 of 32 mm); 1 mm on the left reaches the saved frame.
  const wide = { top: 3, right: 0.5, bottom: 1, left: 1 }, small = { top: 1, right: 0.5, bottom: 1, left: 0.4 };
  const check = service.approveRoll({ revision: service.revision(), key: 'w162h90', requestId: job.id, margins: wide, check: true }, 'admin');
  assert.deepEqual(check.affected.map(a => [a.id, a.objects]), [['box', ['title']], ['location', ['location']], ['lines', ['lines']], ['edge-57', ['frame']]]);
  assert.equal(service.config().measured.w162h90, undefined);
  assert.deepEqual(service.approveRoll({ revision: service.revision(), key: 'w162h90', requestId: job.id, margins: small, check: true }, 'admin').affected, []);
  service.approveRoll({ revision: service.revision(), key: 'w162h90', requestId: job.id, margins: small }, 'admin');
  assert.deepEqual(service.formats().media.margins, small);
  assert.deepEqual(service.config().measured.w162h90.margins, small);
  assert.equal((await service.preview({ test: true }, 'storagesystem')).printable, true);
  // Not through the settings.
  assert.throws(() => update(service, c => { c.measured.w162h90.margins = wide; }), /only with its approved test print/);
  assert.throws(() => update(service, c => { delete c.measured.w162h90; }), /only with its approved test print/);
  assert.throws(() => service.approveRoll({ revision: service.revision(), key: 'w54h144', requestId: job.id, margins: small }, 'admin'), /Print the test label/);
});

test('a test print that did not reach the printer cannot be approved', async t => {
  const { service, state } = setup(t);
  update(service, c => { c.rolls.push(roll); c.printers[0].mediaKey = key; });
  state.fail = true;
  const job = await testPrint(service);
  assert.equal(job.state, 'unknown');
  assert.throws(() => service.approveRoll({ revision: service.revision(), key, requestId: job.id, margins }, 'admin'), /did not reach the printer/);
});

test('measured margins are edges a template must keep clear of, in both text directions', async t => {
  const { service } = setup(t);
  update(service, c => { c.rolls.push(roll); c.printers[0].mediaKey = key; });
  service.approveRoll({ revision: service.revision(), key, requestId: (await testPrint(service)).id, margins }, 'admin');
  const fits = await service.preview({ template: shape('box', { x: 1, y: 1.5, w: 38.5, h: 27 }), test: true }, designer);
  assert.equal(fits.printable, true);
  const left = await service.preview({ template: shape('box', { x: 0.5, y: 2, w: 10, h: 10 }), test: true }, designer);
  assert.equal(left.printable, false); assert.match(left.warnings[0].message, /"box" reaches into the edge that this roll does not print: 1 mm on the left\./);
  assert.deepEqual(left.layout.margins, margins);
  // Turned a quarter, the label's top edge becomes the canvas's right side (pageSvg: canvas (u, v) -> page (v, H - u)).
  const turned = await service.preview({ template: { ...shape('box', { x: 2, y: 2, right: 1, h: 10 }), orientation: 'portrait' }, test: true }, designer);
  assert.deepEqual(turned.layout.margins, { top: 1, right: 1.5, bottom: 0.5, left: 1.5 });
  assert.match(turned.warnings[0].message, /1\.5 mm on the right/);
  // The test print itself ignores the margins it measures, so the roll can be measured again.
  assert.equal((await service.preview({ kind: 'calibration', test: true }, 'admin')).printable, true);
});

test('a roll that a template or printer uses cannot be removed', async t => {
  const { service } = setup(t);
  update(service, c => { c.rolls.push(roll); c.printers[0].mediaKey = key; });
  assert.throws(() => update(service, c => { c.rolls = []; }), /label format that this printer model supports/);
  service.approveRoll({ revision: service.revision(), key, requestId: (await testPrint(service)).id, margins }, 'admin');
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
