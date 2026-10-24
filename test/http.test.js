import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { PrintService } from '../src/service.js';
import { createApp, parseClients } from '../src/server.js';

const env = { LABEL_ADMIN_KEY: 'admin-key-for-tests-only', LABEL_CLIENT_KEYS: 'storagesystem=storage-key-for-tests, homeassistant=ha-key-for-tests-only', LABEL_ALLOWED_ORIGINS: 'http://designer.local' };

async function start(t) {
  const store = new Store(':memory:'); let printCalls = 0;
  const printer = { async status() { return { state: 'idle', queuedJobs: 0, acceptingJobs: true, formats: ['application/postscript'] }; },
    async validate() {}, async print() { printCalls++; return 7; }, async job() { return { jobId: 7, state: 'completed' }; } };
  const service = new PrintService(store, { defaults: { serverUrl: 'http://cups:631', queue: 'DYMO_5XL' }, printerFactory: () => printer });
  const app = createApp({ store, env, service }); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = (path, key, init = {}) => fetch(base + path, { ...init, headers: { ...(key ? { 'x-api-key': key } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
  return { base, call, prints: () => printCalls };
}

test('client keys are parsed strictly and the admin name is reserved', () => {
  assert.deepEqual(parseClients(env).map(c => [c.name, c.admin]), [['admin', true], ['storagesystem', false], ['homeassistant', false]]);
  for (const bad of ['short=abc', 'Upper=long-enough-key-1234', 'admin=long-enough-key-1234', 'a=long-enough-key-1234,b=long-enough-key-1234', 'nokey']) {
    assert.throws(() => parseClients({ LABEL_CLIENT_KEYS: bad }));
  }
});

test('HTTP API authenticates every client, limits admin operations and never prints from a preview', async t => {
  const { call, prints } = await start(t);
  const health = await (await call('/healthz')).json(); assert.equal(health.ok, true); assert.match(health.version, /^\d+\.\d+\.\d+/);
  assert.equal((await call('/api/v1/formats')).status, 401);
  assert.equal((await call('/api/v1/formats', 'wrong-key-for-tests-only')).status, 401);
  assert.equal((await call('/api/v1/formats', 'storage-key-for-tests', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/api/v1/formats', 'storage-key-for-tests', { headers: { Origin: 'http://designer.local' } })).status, 200);
  const formats = await (await call('/api/v1/formats', 'storage-key-for-tests', { headers: { authorization: 'Bearer storage-key-for-tests' } })).json();
  assert.equal(formats.mediaKey, 'w162h90'); assert.equal(formats.mediaPresets.length, 5);
  assert.equal((await call('/api/v1/settings', 'storage-key-for-tests')).status, 403);
  assert.equal((await call('/api/v1/roll', 'storage-key-for-tests', { method: 'POST', body: '{}' })).status, 403);
  const settings = await (await call('/api/v1/settings', 'admin-key-for-tests-only')).json(); assert.equal(settings.config.queue, 'DYMO_5XL');
  assert.equal((await call('/api/v1/previews', 'storage-key-for-tests', { method: 'POST', body: 'x'.repeat(70000) })).status, 413);
  assert.equal((await call('/api/v1/previews', 'storage-key-for-tests', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } })).status, 400);

  const preview = await (await call('/api/v1/previews', 'storage-key-for-tests', { method: 'POST', body: JSON.stringify({ kind: 'box', fields: { title: 'Kablar', description: 'USB-C och HDMI', location: 'Lagerhylla: A, Hylla 2, Plats: 1A' } }) })).json();
  assert.equal(preview.printable, true); assert.equal(prints(), 0);
  const requestId = randomUUID();
  assert.equal((await call('/api/v1/jobs', 'ha-key-for-tests-only', { method: 'POST', body: JSON.stringify({ token: preview.token, requestId }) })).status, 409);
  const job = await call('/api/v1/jobs', 'storage-key-for-tests', { method: 'POST', body: JSON.stringify({ token: preview.token, requestId }) });
  assert.equal(job.status, 201); assert.equal((await job.json()).jobId, 7); assert.equal(prints(), 1);
  assert.equal((await call(`/api/v1/jobs/${requestId}`, 'ha-key-for-tests-only')).status, 404);
  assert.equal((await (await call(`/api/v1/jobs/${requestId}`, 'storage-key-for-tests')).json()).status.state, 'completed');
  assert.equal((await (await call('/api/v1/jobs', 'admin-key-for-tests-only')).json()).jobs.length, 1);
  assert.equal((await (await call('/api/v1/jobs', 'ha-key-for-tests-only')).json()).jobs.length, 0);
  assert.equal((await call('/api/v1/unknown', 'storage-key-for-tests')).status, 404);
});

test('the admin page is served with a strict policy and may call the API from its own origin only', async t => {
  const { base, call } = await start(t);
  const page = await fetch(base + '/');
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await page.text(), /Admin key/);
  for (const path of ['/admin.js', '/style.css']) assert.equal((await fetch(base + path)).status, 200);
  assert.equal((await fetch(base + '/../src/server.js')).status, 404);
  const own = base.replace('127.0.0.1', '127.0.0.1');
  assert.equal((await call('/api/v1/formats', 'admin-key-for-tests-only', { headers: { Origin: own } })).status, 200);
  assert.equal((await call('/api/v1/formats', 'admin-key-for-tests-only', { headers: { Origin: 'http://127.0.0.1:1' } })).status, 403);
});

test('without any configured key the API refuses every request', async t => {
  const store = new Store(':memory:'), app = createApp({ store, env: {} }); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); store.close(); });
  const response = await fetch(`http://127.0.0.1:${app.address().port}/api/v1/formats`);
  assert.equal(response.status, 401); assert.match((await response.json()).error, /No API keys/);
});
