import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, restore } from '../src/store.js';
import { PrintService } from '../src/service.js';
import { validatePrinting } from '../src/validation.js';
import { defaultLabelStyles } from '../src/label-media.js';

// The converter stands in for rsvg-convert, which a development machine may not have.
export const fakeConverter = async (svg, format) => Buffer.from(format === 'pdf' ? `%PDF-fake ${svg.length}` : 'PNG-fake');
export function setup(t, path = ':memory:') {
  const store = new Store(path);
  const state = { printCalls: 0, fail: false, stopped: false, onValidate: null, queue: { state: 'idle', queuedJobs: 0 }, queues: [] };
  const printer = { async status() { return { ...state.queue, state: state.stopped ? 'stopped' : state.queue.state, acceptingJobs: true, formats: ['application/pdf', 'application/postscript'] }; },
    async validate(media, name, format) { state.format = format; state.onValidate?.(); }, async print(media, name, document) { state.printCalls++; state.document = document; if (state.fail) throw new Error('lost response'); return 42; },
    async job() { return { jobId: 42, state: 'completed' }; } };
  const service = new PrintService(store, { defaults: { serverUrl: 'http://cups:631', queue: 'DYMO_5XL' }, converter: fakeConverter, settleMs: 0,
    printerFactory: config => { state.queues.push(config?.queue); return printer; } });
  t.after(() => { if (path === ':memory:') store.close(); });
  return { store, state, service };
}
const preview = (service, client = 'storagesystem', input = { test: true }) => service.preview(input, client);
const update = (service, change) => { const config = structuredClone(service.config()); change(config); return service.save({ revision: service.revision(), config }); };
const designer = { name: 'studio', role: 'designer' }, drafter = { name: 'mcp', role: 'drafter' };

test('environment defaults configure one printer until settings are saved', t => {
  const { service } = setup(t), view = service.view(), printer = view.config.printers[0];
  assert.equal(view.config.serverUrl, 'http://cups:631'); assert.equal(view.config.defaultPrinter, 'dymo-5xl'); assert.equal(view.config.batchLimit, 50);
  assert.deepEqual([printer.id, printer.model, printer.enabled, printer.queue, printer.rollReader.enabled], ['dymo-5xl', 'lw5xl', true, 'DYMO_5XL', false]);
  update(service, c => { c.printers[0].mediaKey = 'w54h144'; c.printers[0].styles.w54h144.orientation = 'landscape'; });
  assert.equal(service.formats().style.orientation, 'landscape');
  assert.throws(() => service.save({ revision: view.revision, config: view.config }), { status: 409 });
});

test('settings saved by version 0.4 become the default printer and keep their styles', async t => {
  const { store, service } = setup(t);
  const styles = defaultLabelStyles(); styles.w162h90.descriptionSize = 7; delete styles['custom_102x210mm_102x210mm'];
  store.db.prepare("INSERT INTO settings VALUES ('printing', ?)").run(JSON.stringify({ enabled: true, serverUrl: 'http://cups:631', queue: 'DYMO_5XL', mediaKey: 'w162h90', styles,
    rollReader: { enabled: true, host: 'printer.example', port: 9100 } }));
  const config = service.config(), printer = config.printers[0];
  assert.deepEqual([config.defaultPrinter, printer.id, printer.model, printer.queue, printer.rollReader.host], ['dymo-5xl', 'dymo-5xl', 'lw5xl', 'DYMO_5XL', 'printer.example']);
  assert.equal(printer.styles.w162h90.descriptionSize, 7); assert.equal(printer.styles['custom_102x210mm_102x210mm'].titleSize, 16);
  assert.equal(store.audit().ok, true);
  update(service, c => { c.printers[0].mediaKey = 'custom_102x210mm_102x210mm'; });
  assert.equal((await preview(service)).layout.sku, '2166659');
});

test('a check says whether a label fits without a token or a print document, and clients see the batch limit', async t => {
  const { service } = setup(t);
  let pdfs = 0; service.converter = async (svg, format) => { if (format === 'pdf') pdfs++; return fakeConverter(svg, format); };
  for (let i = 0; i < 120; i++) {
    const c = await preview(service, 'storagesystem', { kind: 'location', fields: { location: `IVAR-A-H2-P${i}` }, check: true });
    assert.equal(c.check, true); assert.equal(c.token, undefined); assert.equal(c.printable, true);
  }
  assert.equal(service.previews.size, 0); assert.equal(pdfs, 0);
  const tight = await preview(service, 'storagesystem', { fields: { title: 'x', description: 'long text '.repeat(60), location: 'A' }, check: true, include: ['png'] });
  assert.equal(tight.printable, false); assert.equal(tight.warnings[0].object, 'description'); assert.ok(tight.png);
  await assert.rejects(preview(service, 'storagesystem', { test: true, check: 'yes' }), /Unsupported/);
  assert.equal(service.formats().batchLimit, 50);
  update(service, c => { c.batchLimit = 20; });
  assert.equal(service.formats().batchLimit, 20);
});

test('a batch of rows becomes one print document, one token and one job', async t => {
  const { store, state, service } = setup(t);
  let pages; service.converter = async (svg, format) => { if (format === 'pdf') pages = Array.isArray(svg) ? svg.length : 1; return fakeConverter(svg, format); };
  const rows = ['IVAR-A-H2-P1', 'IVAR-A-H2-P2', 'IVAR-A-H2-P3'].map(location => ({ location }));
  const p = await preview(service, 'storagesystem', { kind: 'location', rows, reference: 'batch:1' });
  assert.equal(p.labels, 3); assert.equal(p.printable, true); assert.equal(pages, 3); assert.equal(p.layout, undefined);
  const job = await service.submit({ token: p.token, requestId: randomUUID() }, 'storagesystem');
  assert.equal(job.labels, 3); assert.equal(job.state, 'submitted'); assert.equal(state.printCalls, 1); assert.equal(store.audit().ok, true);
  // One row that does not fit stops the batch and is named by its number.
  const crowded = await preview(service, 'storagesystem', { rows: [{ title: 'a', location: 'A' }, { title: 'b', description: 'long text '.repeat(60), location: 'B' }] });
  assert.equal(crowded.printable, false); assert.deepEqual(crowded.warnings.map(w => [w.row, w.object]), [[2, 'description']]);
  await assert.rejects(service.submit({ token: crowded.token, requestId: randomUUID() }, 'storagesystem'), /does not fit/);
  await assert.rejects(preview(service, 'storagesystem', { kind: 'location', rows: [{ location: 'A' }, {}] }), /^Error: Row 2: /);
  await assert.rejects(preview(service, 'storagesystem', { kind: 'location', rows: [] }), /1-50 labels/);
  await assert.rejects(preview(service, 'storagesystem', { kind: 'location', rows: Array.from({ length: 51 }, () => ({ location: 'A' })) }), /1-50 labels/);
  await assert.rejects(preview(service, 'storagesystem', { kind: 'location', rows, check: true }), /without fields, test, check or include/);
  await assert.rejects(preview(service, 'storagesystem', { kind: 'location', rows, fields: {} }), /without fields/);
});

test('print requests are single-use, durably idempotent and owned by the client that previewed them', async t => {
  const { store, state, service } = setup(t), p = await preview(service, 'storagesystem', { kind: 'location', fields: { location: 'IVAR-A-H2-P1-A' }, reference: 'box:42' });
  assert.equal(p.printable, true); assert.match(p.svg, /^<svg/); assert.deepEqual(p.warnings, []); assert.equal(p.printer, 'dymo-5xl');
  const requestId = randomUUID();
  await assert.rejects(service.submit({ token: p.token, requestId }, 'homeassistant'), { status: 409 });
  const job = await service.submit({ token: p.token, requestId }, 'storagesystem');
  assert.equal(job.state, 'submitted'); assert.equal(job.jobId, 42); assert.equal(job.client, 'storagesystem'); assert.equal(job.kind, 'location'); assert.equal(job.reference, 'box:42');
  assert.equal(job.printer, 'dymo-5xl'); assert.equal(job.documentFormat, 'application/pdf'); assert.equal(state.format, 'application/pdf'); assert.match(state.document.toString(), /^%PDF-/);
  assert.deepEqual(await service.submit({ token: p.token, requestId }, 'storagesystem'), job);
  await assert.rejects(service.submit({ token: p.token, requestId }, 'homeassistant'), { status: 409 });
  await assert.rejects(service.submit({ token: p.token, requestId: randomUUID() }, 'storagesystem'), { status: 409 });
  assert.equal(state.printCalls, 1); assert.equal(store.audit().ok, true);
  await assert.rejects(service.job(requestId, 'homeassistant'), { status: 404 });
  assert.equal((await service.job(requestId, 'storagesystem')).status.state, 'completed');
  assert.equal(service.jobs('homeassistant').length, 0); assert.equal(service.jobs(null).length, 1);
  const restarted = new PrintService(store, { defaults: { serverUrl: 'http://cups:631', queue: 'DYMO_5XL' } });
  assert.deepEqual(await restarted.submit({ token: p.token, requestId }, 'storagesystem'), job);
});

test('a client may choose the text direction per label without changing the saved format setting', async t => {
  const { service } = setup(t), saved = service.formats().style.orientation;
  assert.equal(saved, 'landscape');
  const natural = await preview(service, 'storagesystem', { kind: 'location', fields: { location: 'IVAR-A-H2-P1-A' } });
  const turned = await preview(service, 'storagesystem', { kind: 'location', fields: { location: 'IVAR-A-H2-P1-A' }, orientation: 'portrait' });
  assert.equal(natural.layout.rotated, false); assert.equal(turned.layout.rotated, true); assert.equal(turned.layout.orientation, 'portrait');
  assert.equal((await preview(service, 'storagesystem', { test: true, orientation: 'landscape' })).layout.rotated, false);
  assert.equal(service.formats().style.orientation, saved);
  await assert.rejects(preview(service, 'storagesystem', { test: true, orientation: 'sideways' }), /Unsupported/);
  const lines = await preview(service, 'storagesystem', { kind: 'lines', test: true });
  assert.equal(lines.kind, 'lines'); assert.equal(lines.printable, true); assert.equal(service.templates().templates.length, 3);
});

test('free-line labels are journalled with their kind', async t => {
  const { store, service } = setup(t);
  const p = await preview(service, 'homeassistant', { kind: 'lines', fields: { lines: [{ text: 'Batteri bytt', bold: true }, { text: '2026-10-24' }] }, reference: 'ha:battery' });
  const job = await service.submit({ token: p.token, requestId: randomUUID() }, 'homeassistant');
  assert.equal(job.kind, 'lines'); assert.equal(job.client, 'homeassistant'); assert.equal(store.audit().ok, true);
});

test('a printer rests after each job and waits for its queue before the next one is sent', async t => {
  const { state, service } = setup(t); service.settleMs = 80;
  update(service, c => { c.printers[0].rollReader = { enabled: true, host: 'printer.example', port: 9100 }; });
  const times = [], printer = service.printerFactory(), print = printer.print;
  printer.print = async (...args) => { times.push(Date.now()); return print(...args); };
  const first = await preview(service), second = await preview(service);
  await service.submit({ token: first.token, requestId: randomUUID() }, 'storagesystem');
  await service.submit({ token: second.token, requestId: randomUUID() }, 'storagesystem');
  assert.ok(times[1] - times[0] >= 75, `second job after ${times[1] - times[0]} ms`);
  await assert.rejects(service.readRoll({ revision: service.revision() }), /Wait/);
  // A queue that is still working is polled until it is idle; one that never empties is refused, not printed.
  service.settleMs = 5; let polls = 0; const status = printer.status;
  printer.status = async () => ({ ...(await status()), ...(++polls < 3 ? { state: 'processing', queuedJobs: 1 } : {}) });
  await service.submit({ token: (await preview(service)).token, requestId: randomUUID() }, 'storagesystem');
  assert.ok(polls >= 3); assert.equal(state.printCalls, 3);
  service.queueWaitMs = 30; printer.status = async () => ({ ...(await status()), state: 'processing', queuedJobs: 1 });
  await assert.rejects(service.submit({ token: (await preview(service)).token, requestId: randomUUID() }, 'storagesystem'), { status: 429 });
  assert.equal(state.printCalls, 3); assert.equal(service.busy.size, 0);
});

test('ambiguous submission failures remain unknown and retries cannot print a second label', async t => {
  const { state, service } = setup(t); state.fail = true;
  const p = await preview(service), input = { token: p.token, requestId: randomUUID() };
  assert.equal((await service.submit(input, 'storagesystem')).state, 'unknown');
  assert.equal((await service.submit(input, 'storagesystem')).state, 'unknown'); assert.equal(state.printCalls, 1);
});

test('a verified IPP error status is recorded as rejected, while warnings and lost responses stay unknown', async t => {
  const { state, service } = setup(t), printer = service.printerFactory();
  for (const [ippStatus, expected] of [[0x0401, 'rejected'], [0x0500, 'rejected'], [0x0001, 'unknown'], [undefined, 'unknown']]) {
    printer.print = async () => { state.printCalls++; throw Object.assign(new Error('failed'), { ippStatus }); };
    const p = await preview(service);
    assert.equal((await service.submit({ token: p.token, requestId: randomUUID() }, 'storagesystem')).state, expected, String(ippStatus));
  }
});

test('wrong format, stale settings, stopped queues, expired and overflowing previews do not submit', async t => {
  const { store, state, service } = setup(t);
  await assert.rejects(preview(service, 'storagesystem', { test: true, mediaKey: 'w54h144' }), /selected label format is S0722540/);
  assert.equal((await preview(service, 'storagesystem', { test: true, mediaKey: 'w162h90' })).printable, true);
  let p = await preview(service);
  update(service, c => { c.printers[0].queue = 'other'; });
  await assert.rejects(service.submit({ token: p.token, requestId: randomUUID() }, 'storagesystem'), { status: 409 });
  p = await preview(service); service.previews.get(p.token).expires = 0;
  await assert.rejects(service.submit({ token: p.token, requestId: randomUUID() }, 'storagesystem'), { status: 409 });
  p = await preview(service); state.stopped = true;
  await assert.rejects(service.submit({ token: p.token, requestId: randomUUID() }, 'storagesystem'), { status: 409 }); state.stopped = false;
  p = await preview(service, 'storagesystem', { fields: { title: 'x', description: 'long text '.repeat(60), location: 'A' } });
  assert.equal(p.printable, false); assert.equal(p.warnings[0].object, 'description');
  await assert.rejects(service.submit({ token: p.token, requestId: randomUUID() }, 'storagesystem'), /does not fit/);
  p = await preview(service); state.onValidate = () => update(service, c => { c.printers[0].enabled = false; });
  await assert.rejects(service.submit({ token: p.token, requestId: randomUUID() }, 'storagesystem'), { status: 409 });
  for (const bad of [{ test: true, fields: { location: 'A' } }, { kind: 'shelf', test: true }, { fields: { location: 'A' }, reference: '' }, { copies: 2, test: true }, { kind: 'box', template: 'box', test: true }]) {
    await assert.rejects(preview(service, 'storagesystem', bad));
  }
  assert.equal(state.printCalls, 0); assert.equal(store.printJobs().length, 0);
});

test('roll reading needs an idle empty queue, never overlaps and is discarded when settings change', async t => {
  const { service, state } = setup(t); let calls = 0, resolve;
  service.rollReader = async () => { calls++; return new Promise(r => { resolve = r; }); };
  await assert.rejects(service.readRoll({ revision: service.revision() }), /Enable/);
  update(service, c => { c.printers[0].rollReader = { enabled: true, host: 'printer.example', port: 9100 }; });
  const config = service.config();
  for (const bad of [{ host: 'http://printer' }, { port: 0 }, { enabled: true, host: '' }, { command: 'reset' }]) {
    const changed = structuredClone(config); changed.printers[0].rollReader = { ...changed.printers[0].rollReader, ...bad };
    assert.throws(() => validatePrinting(changed), /roll-reader/);
  }
  state.queue.queuedJobs = 1;
  await assert.rejects(service.readRoll({ revision: service.revision() }), /idle and empty/); assert.equal(calls, 0);
  service.lastRollCheck.clear(); state.queue.queuedJobs = 0; const pending = service.readRoll({ revision: service.revision() }); await new Promise(setImmediate);
  assert.equal(service.busy.has('dymo-5xl'), true); await assert.rejects(service.readRoll({ revision: service.revision() }), /Wait/);
  update(service, c => { c.printers[0].queue = 'changed'; }); resolve({ sku: 'S0722540', labelsRemaining: 123, observedAt: '2026-10-27T12:00:00.000Z', raw: { status: '00', consumable: 'b6ca' } });
  await assert.rejects(pending, /settings changed/); assert.equal(service.busy.size, 0);
  // The chip's raw answer is kept even so, newest first, at most 20.
  assert.deepEqual(service.store.rollReadings()[0], { printer: 'dymo-5xl', observedAt: '2026-10-27T12:00:00.000Z', sku: 'S0722540', labelsRemaining: 123, raw: { status: '00', consumable: 'b6ca' } });
  for (let i = 0; i < 25; i++) service.store.addRollReading({ printer: 'dymo-5xl', observedAt: String(i), sku: 'S0722540', labelsRemaining: i, raw: {} });
  assert.equal(service.store.rollReadings().length, 20); assert.equal(service.store.rollReadings()[0].labelsRemaining, 24);
  assert.equal(service.store.audit().ok, true);
});

test('several printers keep their own queue, roll and model limits', async t => {
  const { state, service } = setup(t);
  update(service, c => { c.printers.push({ ...structuredClone(c.printers[0]), id: 'friend-450', name: 'DYMO LabelWriter 450', model: 'lw450', queue: 'DYMO_450', mediaKey: 'w54h144', rollReader: { enabled: false, host: '', port: 9100 } }); });
  assert.deepEqual(service.formats('friend-450').mediaPresets.map(p => p.key), ['w162h90', 'w54h144', 'w72h154', 'w154h286']);
  assert.equal(service.formats().printers.length, 2);
  const p = await preview(service, 'storagesystem', { test: true, printer: 'friend-450', kind: 'location' });
  assert.equal(p.layout.sku, 'S0722550'); assert.equal(p.printer, 'friend-450');
  const job = await service.submit({ token: p.token, requestId: randomUUID() }, 'storagesystem');
  assert.deepEqual([job.printer, job.queue, job.mediaKey], ['friend-450', 'DYMO_450', 'w54h144']); assert.ok(state.queues.includes('DYMO_450'));
  await assert.rejects(preview(service, 'storagesystem', { test: true, printer: 'missing' }), { status: 404 });
  for (const [change, pattern] of [
    [c => { c.printers[1].mediaKey = 'custom_102x210mm_102x210mm'; }, /supports/], [c => { c.printers[1].rollReader.enabled = true; c.printers[1].rollReader.host = 'p.example'; }, /cannot report/],
    [c => { c.printers[1].queue = 'DYMO_5XL'; }, /unique/], [c => { c.defaultPrinter = 'missing'; }, /default printer/], [c => { c.printers[1].model = 'lm280'; }, /model/],
    [c => { c.batchLimit = 0; }, /batch limit/]
  ]) assert.throws(() => update(service, change), pattern);
});

const design = {
  id: 'cable-tag', name: 'Kabeletikett', media: ['w162h90', 'w54h144'],
  fields: { name: { type: 'text', sample: 'HDMI 2 m' }, port: { type: 'text', required: false, maxLength: 20 } },
  objects: [{ id: 'name', type: 'text', x: 3, y: 3, right: 3, h: '50%', text: '{{name}}', size: 14, minSize: 8, bold: true }, { type: 'text', x: 3, bottom: 3, right: 3, h: 8, text: 'Port {{port}}', size: 9 }]
};

test('templates are drafted, published and versioned; only published ones print for ordinary keys', async t => {
  const { store, state, service } = setup(t);
  assert.throws(() => service.saveTemplate({ definition: design }, 'storagesystem'), { status: 403 });
  const draft = service.saveTemplate({ definition: design }, drafter);
  assert.deepEqual([draft.id, draft.version, draft.status, draft.createdBy], ['cable-tag', 1, 'draft', 'mcp']);
  assert.equal(service.templates('storagesystem').templates.length, 3); assert.equal(service.templates(drafter).templates.at(-1).latest.status, 'draft');
  await assert.rejects(preview(service, 'storagesystem', { template: 'cable-tag', test: true }), { status: 404 });
  // A drafter sees its draft, with a reason why it cannot print yet.
  const mcp = await preview(service, drafter, { template: 'cable-tag', fields: { name: 'USB-C', port: '4' }, include: ['png'] });
  assert.equal(mcp.printable, false); assert.equal(mcp.warnings[0].object, 'template'); assert.equal(mcp.png, Buffer.from('PNG-fake').toString('base64'));
  await assert.rejects(service.submit({ token: mcp.token, requestId: randomUUID() }, 'mcp'), /not published/);
  assert.throws(() => service.setTemplateStatus('cable-tag', 1, 'published', drafter), { status: 403 });
  service.setTemplateStatus('cable-tag', 1, 'published', designer);
  const changed = structuredClone(design); changed.objects[0].size = 12;
  assert.equal(service.saveTemplate({ definition: changed }, designer).version, 2);
  // Ordinary clients get the latest published version (1) until version 2 is published.
  const p = await preview(service, 'storagesystem', { template: 'cable-tag', fields: { name: 'USB-C' }, reference: 'rack:3' });
  assert.equal(p.printable, true); assert.deepEqual(p.template, { id: 'cable-tag', version: 1, status: 'published' }); assert.equal(p.kind, 'template');
  const job = await service.submit({ token: p.token, requestId: randomUUID() }, 'storagesystem');
  assert.deepEqual(job.template, { id: 'cable-tag', version: 1 }); assert.equal(job.kind, 'template'); assert.equal(state.printCalls, 1);
  assert.equal(service.template('cable-tag', undefined, 'storagesystem').version, 1); assert.equal(service.template('cable-tag', undefined, designer).version, 1);
  assert.throws(() => service.template('cable-tag', 2, 'storagesystem'), { status: 404 });
  assert.deepEqual(service.templateVersions('cable-tag', designer).versions.map(v => [v.version, v.status]), [[1, 'published'], [2, 'draft']]);
  // A designer may test-print a draft or an unsaved design from the editor.
  assert.equal((await preview(service, designer, { template: 'cable-tag', version: 2, test: true })).printable, true);
  assert.equal((await preview(service, designer, { template: { ...design, id: 'unsaved-tag' }, test: true })).printable, true);
  await assert.rejects(preview(service, 'storagesystem', { template: design, test: true }), { status: 403 });
  update(service, c => { c.printers[0].mediaKey = 'w72h154'; });
  await assert.rejects(preview(service, 'storagesystem', { template: 'cable-tag', fields: { name: 'x' } }), /not made for S0722520/);
  service.setTemplateStatus('cable-tag', 1, 'archived', designer);
  assert.equal(service.templates('storagesystem').templates.length, 3); assert.equal(store.audit().ok, true);
});

test('the journal survives backup and restore, and the audit detects damage', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'label-service-'));
  try {
    const { store, service } = setup(t, join(dir, 'label-service.sqlite'));
    await service.submit({ token: (await preview(service)).token, requestId: randomUUID() }, 'storagesystem');
    service.saveTemplate({ definition: design }, designer);
    await store.backup(join(dir, 'backup.sqlite')); await assert.rejects(store.backup(join(dir, 'backup.sqlite')));
    await restore(join(dir, 'backup.sqlite'), join(dir, 'restored.sqlite'));
    const restored = new Store(join(dir, 'restored.sqlite'));
    try { assert.deepEqual(restored.printJobs(), store.printJobs()); assert.equal(restored.templateVersions('cable-tag').length, 1); assert.equal(restored.audit().ok, true); } finally { restored.close(); }
    store.db.prepare("UPDATE print_jobs SET record=json_set(record,'$.state','bad')").run();
    assert.equal(store.audit().ok, false); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a version 1 database gains the templates and pictures tables and keeps its journal', t => {
  const dir = mkdtempSync(join(tmpdir(), 'label-service-'));
  try {
    const path = join(dir, 'old.sqlite'), old = new Store(path);
    old.db.exec('DROP TABLE templates; DROP TABLE assets; DROP TABLE fonts; PRAGMA user_version = 1;'); old.close();
    const store = new Store(path);
    try { assert.equal(store.audit().schemaVersion, 4); assert.deepEqual(store.templateIds(), []); assert.deepEqual(store.assets(), []); assert.deepEqual(store.fonts(), []); } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
