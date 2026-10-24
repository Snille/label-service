import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, restore } from '../src/store.js';
import { PrintService } from '../src/service.js';
import { validatePrinting } from '../src/validation.js';

export function setup(t, path = ':memory:') {
  const store = new Store(path);
  const state = { printCalls: 0, fail: false, stopped: false, onValidate: null, queue: { state: 'idle', queuedJobs: 0 } };
  const printer = { async status() { return { ...state.queue, state: state.stopped ? 'stopped' : state.queue.state, acceptingJobs: true, formats: ['application/postscript'] }; },
    async validate() { state.onValidate?.(); }, async print() { state.printCalls++; if (state.fail) throw new Error('lost response'); return 42; },
    async job() { return { jobId: 42, state: 'completed' }; } };
  const service = new PrintService(store, { defaults: { serverUrl: 'http://cups:631', queue: 'DYMO_5XL' }, printerFactory: () => printer });
  t.after(() => { if (path === ':memory:') store.close(); });
  return { store, state, service };
}
const preview = (service, client = 'storagesystem', input = { test: true }) => service.preview(input, client);

test('environment defaults configure CUPS until settings are saved', t => {
  const { service } = setup(t), view = service.view();
  assert.equal(view.config.enabled, true); assert.equal(view.config.serverUrl, 'http://cups:631'); assert.equal(view.config.rollReader.enabled, false);
  const styles = structuredClone(view.config.styles); styles.w54h144.orientation = 'landscape';
  service.save({ revision: view.revision, config: { ...view.config, mediaKey: 'w54h144', styles } });
  assert.equal(service.formats().style.orientation, 'landscape');
  assert.throws(() => service.save({ revision: view.revision, config: view.config }), { status: 409 });
});

test('print requests are single-use, durably idempotent and owned by the client that previewed them', async t => {
  const { store, state, service } = setup(t), p = preview(service, 'storagesystem', { kind: 'location', fields: { location: 'IVAR-A-H2-P1-A' }, reference: 'box:42' });
  assert.equal(p.printable, true); assert.match(p.svg, /^<svg/);
  const requestId = randomUUID();
  await assert.rejects(service.submit({ token: p.token, requestId }, 'homeassistant'), { status: 409 });
  const job = await service.submit({ token: p.token, requestId }, 'storagesystem');
  assert.equal(job.state, 'submitted'); assert.equal(job.jobId, 42); assert.equal(job.client, 'storagesystem'); assert.equal(job.kind, 'location'); assert.equal(job.reference, 'box:42');
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

test('ambiguous submission failures remain unknown and retries cannot print a second label', async t => {
  const { state, service } = setup(t); state.fail = true;
  const p = preview(service), input = { token: p.token, requestId: randomUUID() };
  assert.equal((await service.submit(input, 'storagesystem')).state, 'unknown');
  assert.equal((await service.submit(input, 'storagesystem')).state, 'unknown'); assert.equal(state.printCalls, 1);
});

test('wrong format, stale settings, stopped queues, expired and overflowing previews do not submit', async t => {
  const { store, state, service } = setup(t);
  assert.throws(() => preview(service, 'storagesystem', { test: true, mediaKey: 'w54h144' }), /selected label format is S0722540/);
  assert.equal(preview(service, 'storagesystem', { test: true, mediaKey: 'w162h90' }).printable, true);
  let p = preview(service); const view = service.view();
  service.save({ revision: view.revision, config: { ...view.config, queue: 'other' } });
  await assert.rejects(service.submit({ token: p.token, requestId: randomUUID() }, 'storagesystem'), { status: 409 });
  p = preview(service); service.previews.get(p.token).expires = 0;
  await assert.rejects(service.submit({ token: p.token, requestId: randomUUID() }, 'storagesystem'), { status: 409 });
  p = preview(service); state.stopped = true;
  await assert.rejects(service.submit({ token: p.token, requestId: randomUUID() }, 'storagesystem'), { status: 409 }); state.stopped = false;
  p = preview(service, 'storagesystem', { fields: { title: 'x', description: 'long text '.repeat(60), location: 'A' } });
  assert.equal(p.printable, false);
  await assert.rejects(service.submit({ token: p.token, requestId: randomUUID() }, 'storagesystem'), /does not fit/);
  p = preview(service); state.onValidate = () => { const v = service.view(); service.save({ revision: v.revision, config: { ...v.config, enabled: false } }); };
  await assert.rejects(service.submit({ token: p.token, requestId: randomUUID() }, 'storagesystem'), { status: 409 });
  for (const bad of [{ test: true, fields: { location: 'A' } }, { kind: 'shelf', test: true }, { fields: { location: 'A' }, reference: '' }, { copies: 2, test: true }]) {
    assert.throws(() => preview(service, 'storagesystem', bad));
  }
  assert.equal(state.printCalls, 0); assert.equal(store.printJobs().length, 0);
});

test('roll reading needs an idle empty queue, never overlaps and is discarded when settings change', async t => {
  const { service, state } = setup(t); let calls = 0, resolve;
  service.rollReader = async () => { calls++; return new Promise(r => { resolve = r; }); };
  await assert.rejects(service.readRoll({ revision: service.revision() }), /Enable/);
  const config = { ...service.config(), rollReader: { enabled: true, host: '192.0.2.10', port: 9100 } };
  service.save({ revision: service.revision(), config });
  for (const bad of [{ host: 'http://printer' }, { port: 0 }, { enabled: true, host: '' }, { command: 'reset' }]) assert.throws(() => validatePrinting({ ...config, rollReader: { ...config.rollReader, ...bad } }), /roll-reader/);
  state.queue.queuedJobs = 1;
  await assert.rejects(service.readRoll({ revision: service.revision() }), /idle and empty/); assert.equal(calls, 0);
  service.lastRollCheck = 0; state.queue.queuedJobs = 0; const pending = service.readRoll({ revision: service.revision() }); await new Promise(setImmediate);
  assert.equal(service.busy, true); await assert.rejects(service.readRoll({ revision: service.revision() }), /Wait/);
  service.save({ revision: service.revision(), config: { ...config, queue: 'changed' } }); resolve({ labelsRemaining: 123 });
  await assert.rejects(pending, /settings changed/); assert.equal(service.busy, false);
});

test('the journal survives backup and restore, and the audit detects damage', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'label-service-'));
  try {
    const { store, service } = setup(t, join(dir, 'label-service.sqlite'));
    await service.submit({ token: preview(service).token, requestId: randomUUID() }, 'storagesystem');
    await store.backup(join(dir, 'backup.sqlite')); await assert.rejects(store.backup(join(dir, 'backup.sqlite')));
    await restore(join(dir, 'backup.sqlite'), join(dir, 'restored.sqlite'));
    const restored = new Store(join(dir, 'restored.sqlite'));
    try { assert.deepEqual(restored.printJobs(), store.printJobs()); assert.equal(restored.audit().ok, true); } finally { restored.close(); }
    store.db.prepare("UPDATE print_jobs SET record=json_set(record,'$.state','bad')").run();
    assert.equal(store.audit().ok, false); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
