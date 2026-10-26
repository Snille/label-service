import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { PrintService } from '../src/service.js';
import { createApp, parseClients } from '../src/server.js';
import { encodeRgba } from '../src/png.js';

const env = { LABEL_ADMIN_KEY: 'admin-key-for-tests-only', LABEL_CLIENT_KEYS: 'storagesystem=storage-key-for-tests, homeassistant=ha-key-for-tests-only, studio=studio-key-for-tests-only, mcp=mcp-key-for-tests-only',
  LABEL_CLIENT_ROLES: 'studio=designer, mcp=drafter', LABEL_ALLOWED_ORIGINS: 'http://designer.local' };
const fakeConverter = async (svg, format) => Buffer.from(format === 'pdf' ? '%PDF-fake' : 'PNG-fake');

async function start(t) {
  const store = new Store(':memory:'); let printCalls = 0, lastPrint = null;
  const printer = { async status() { return { state: 'idle', queuedJobs: 0, acceptingJobs: true, formats: ['application/pdf'] }; },
    async validate() {}, async print(...args) { printCalls++; lastPrint = args; return 7; }, async job() { return { jobId: 7, state: 'completed' }; } };
  const service = new PrintService(store, { defaults: { serverUrl: 'http://cups:631', queue: 'DYMO_5XL' }, printerFactory: () => printer, converter: fakeConverter, settleMs: 0 });
  const app = createApp({ store, env, service }); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = (path, key, init = {}) => fetch(base + path, { ...init, headers: { ...(key ? { 'x-api-key': key } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
  return { base, call, prints: () => printCalls, lastPrint: () => lastPrint };
}

test('client keys and roles are parsed strictly and the admin name is reserved', () => {
  assert.deepEqual(parseClients(env).map(c => [c.name, c.admin, c.role]), [['admin', true, 'designer'], ['storagesystem', false, 'client'], ['homeassistant', false, 'client'],
    ['studio', false, 'designer'], ['mcp', false, 'drafter']]);
  for (const bad of ['short=abc', 'Upper=long-enough-key-1234', 'admin=long-enough-key-1234', 'a=long-enough-key-1234,b=long-enough-key-1234', 'nokey']) {
    assert.throws(() => parseClients({ LABEL_CLIENT_KEYS: bad }));
  }
  for (const roles of ['studio=owner', 'ghost=designer', 'studio']) assert.throws(() => parseClients({ ...env, LABEL_CLIENT_ROLES: roles }));
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
  const { templates } = await (await call('/api/v1/templates', 'storage-key-for-tests')).json();
  assert.deepEqual(templates.map(t => t.kind), ['box', 'location', 'lines']);
  assert.equal((await call('/api/v1/settings', 'storage-key-for-tests')).status, 403);
  assert.equal((await call('/api/v1/roll', 'storage-key-for-tests', { method: 'POST', body: '{}' })).status, 403);
  const settings = await (await call('/api/v1/settings', 'admin-key-for-tests-only')).json(); assert.equal(settings.config.printers[0].queue, 'DYMO_5XL');
  assert.equal((await call('/api/v1/previews', 'storage-key-for-tests', { method: 'POST', body: 'x'.repeat(300000) })).status, 413);
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

test('templates are saved, published and printed through the HTTP API with role checks', async t => {
  const { call, prints } = await start(t);
  const definition = { id: 'shelf-tag', name: 'Hyllkant', media: ['*'], fields: { text: { type: 'text', sample: 'Skruv M4' } },
    objects: [{ id: 'text', type: 'text', x: 3, y: 3, right: 3, bottom: 3, text: '{{text}}', size: 20, minSize: 8, bold: true, valign: 'middle' }] };
  const post = (path, key, body) => call(path, key, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await post('/api/v1/templates', 'storage-key-for-tests', { definition })).status, 403);
  const draft = await post('/api/v1/templates', 'mcp-key-for-tests-only', { definition });
  assert.equal(draft.status, 201); assert.equal((await draft.json()).version, 1);
  assert.equal((await post('/api/v1/templates', 'mcp-key-for-tests-only', { definition: { ...definition, objects: [] } })).status, 400);
  assert.equal((await call('/api/v1/templates/shelf-tag', 'storage-key-for-tests')).status, 404);
  assert.equal((await post('/api/v1/templates/shelf-tag/versions/1/publish', 'mcp-key-for-tests-only', {})).status, 403);
  assert.equal((await post('/api/v1/templates/shelf-tag/versions/1/publish', 'studio-key-for-tests-only', {})).status, 200);
  const record = await (await call('/api/v1/templates/shelf-tag', 'storage-key-for-tests')).json();
  assert.equal(record.status, 'published'); assert.equal(record.definition.objects.length, 1);
  assert.equal((await call('/api/v1/templates/shelf-tag?version=1', 'storage-key-for-tests')).status, 200);
  assert.equal((await (await call('/api/v1/templates/shelf-tag/versions', 'studio-key-for-tests-only')).json()).versions.length, 1);
  assert.equal((await call('/api/v1/templates/shelf-tag/versions', 'storage-key-for-tests')).status, 403);
  const { templates } = await (await call('/api/v1/templates', 'storage-key-for-tests')).json();
  assert.deepEqual(templates.map(t => t.id), ['box', 'location', 'lines', 'shelf-tag']);
  const preview = await (await post('/api/v1/previews', 'storage-key-for-tests', { template: 'shelf-tag', fields: { text: 'Skruv M4 x 20' }, include: ['png'] })).json();
  assert.equal(preview.printable, true); assert.equal(preview.png, Buffer.from('PNG-fake').toString('base64'));
  const job = await (await post('/api/v1/jobs', 'storage-key-for-tests', { token: preview.token, requestId: randomUUID() })).json();
  assert.deepEqual(job.template, { id: 'shelf-tag', version: 1 }); assert.equal(prints(), 1);
  assert.equal((await call('/api/v1/formats?printer=missing', 'storage-key-for-tests')).status, 404);

  // Deleting: designers only, and never a template that was published, even after it is archived.
  const del = (id, key) => call(`/api/v1/templates/${id}`, key, { method: 'DELETE' });
  await post('/api/v1/templates', 'studio-key-for-tests-only', { definition: { ...definition, id: 'scratch-tag' } });
  await post('/api/v1/templates', 'studio-key-for-tests-only', { definition: { ...definition, id: 'scratch-tag' } });
  const listed = (await (await call('/api/v1/templates', 'studio-key-for-tests-only')).json()).templates.filter(t => !t.builtIn);
  assert.deepEqual(listed.map(t => [t.id, t.archived, t.everPublished]), [['scratch-tag', false, false], ['shelf-tag', false, true]]);
  assert.equal((await del('scratch-tag', 'mcp-key-for-tests-only')).status, 403);
  assert.equal((await del('scratch-tag', 'storage-key-for-tests')).status, 403);
  assert.deepEqual(await (await del('scratch-tag', 'studio-key-for-tests-only')).json(), { id: 'scratch-tag', deleted: 2 });
  assert.equal((await del('scratch-tag', 'studio-key-for-tests-only')).status, 404);
  assert.equal((await post('/api/v1/templates/shelf-tag/versions/1/archive', 'studio-key-for-tests-only', {})).status, 200);
  assert.equal((await del('shelf-tag', 'studio-key-for-tests-only')).status, 409);
  const archived = (await (await call('/api/v1/templates', 'studio-key-for-tests-only')).json()).templates.find(t => t.id === 'shelf-tag');
  assert.deepEqual([archived.archived, archived.everPublished], [true, true]);
  assert.equal((await call('/api/v1/templates/shelf-tag/versions', 'studio-key-for-tests-only', { method: 'DELETE' })).status, 404);
});

test('pictures are uploaded, listed, served, used by templates and deleted only when no template uses them', async t => {
  const { call, lastPrint } = await start(t);
  const post = (path, key, body) => call(path, key, { method: 'POST', body: JSON.stringify(body) });
  const rgba = Buffer.alloc(8 * 4 * 4, 255), png = encodeRgba(8, 4, rgba).toString('base64');
  assert.equal((await post('/api/v1/assets', 'storage-key-for-tests', { name: 'logo', data: png })).status, 403);
  assert.equal((await post('/api/v1/assets', 'studio-key-for-tests-only', { name: 'bad', data: Buffer.from('hello').toString('base64') })).status, 415);
  const uploaded = await post('/api/v1/assets', 'studio-key-for-tests-only', { name: 'Spectrogon logo', data: png });
  assert.equal(uploaded.status, 201);
  const asset = await uploaded.json();
  assert.match(asset.id, /^[a-f0-9]{12}$/); assert.deepEqual([asset.name, asset.type, asset.width, asset.height, asset.createdBy], ['Spectrogon logo', 'png', 8, 4, 'studio']);
  assert.deepEqual((await (await call('/api/v1/assets', 'mcp-key-for-tests-only')).json()).assets.map(a => a.id), [asset.id]);
  const content = await call(`/api/v1/assets/${asset.id}/content`, 'studio-key-for-tests-only');
  assert.equal(content.headers.get('content-type'), 'image/png'); assert.ok(Buffer.from(await content.arrayBuffer()).equals(Buffer.from(png, 'base64')));
  assert.equal((await call('/api/v1/assets/000000000000/content', 'studio-key-for-tests-only')).status, 404);
  const tooBig = await post('/api/v1/assets', 'studio-key-for-tests-only', { name: 'big', data: Buffer.alloc(2.1 * 1024 * 1024, 1).toString('base64') });
  assert.equal(tooBig.status, 413); assert.match((await tooBig.json()).error, /larger than 2 MB/);

  const definition = { id: 'with-logo', name: 'With logo', media: ['*'], fields: {}, objects: [{ id: 'logo', type: 'image', x: 2, y: 2, w: 20, h: 10, asset: asset.id }] };
  const preview = await (await post('/api/v1/previews', 'studio-key-for-tests-only', { template: definition, fields: {} })).json();
  assert.equal(preview.printable, true); assert.match(preview.svg, /<image aria-label="logo"/);
  // Pictures print in the driver's graphics quality, at the template's density.
  const dense = await (await post('/api/v1/previews', 'studio-key-for-tests-only', { template: { ...definition, printDensity: 'light' }, fields: {} })).json();
  assert.deepEqual(dense.driver, { DymoPrintQuality: 'Graphics', DymoPrintDensity: 'Light' });
  await post('/api/v1/jobs', 'studio-key-for-tests-only', { token: dense.token, requestId: randomUUID() });
  assert.deepEqual(lastPrint().at(-1), { DymoPrintQuality: 'Graphics', DymoPrintDensity: 'Light' });
  const plain = await (await post('/api/v1/previews', 'studio-key-for-tests-only', { kind: 'box', test: true })).json();
  assert.deepEqual(plain.driver, { DymoPrintQuality: 'Text' });
  assert.equal((await post('/api/v1/previews', 'studio-key-for-tests-only', { template: { ...definition, printDensity: 'max' }, fields: {} })).status, 400);
  await post('/api/v1/templates', 'studio-key-for-tests-only', { definition });
  const used = await call(`/api/v1/assets/${asset.id}`, 'studio-key-for-tests-only', { method: 'DELETE' });
  assert.equal(used.status, 409); assert.match((await used.json()).error, /used by with-logo/);
  assert.equal((await call('/api/v1/templates/with-logo', 'studio-key-for-tests-only', { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/v1/assets/${asset.id}`, 'mcp-key-for-tests-only', { method: 'DELETE' })).status, 403);
  assert.deepEqual(await (await call(`/api/v1/assets/${asset.id}`, 'studio-key-for-tests-only', { method: 'DELETE' })).json(), { id: asset.id, deleted: 1 });
  const missing = await (await post('/api/v1/previews', 'studio-key-for-tests-only', { template: definition, fields: {} })).json();
  assert.equal(missing.printable, false); assert.match(missing.warnings[0].message, /does not exist/);
});

test('the admin page is served with a strict policy and may call the API from its own origin only', async t => {
  const { base, call } = await start(t);
  const page = await fetch(base + '/');
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await page.text(), /Admin key/);
  for (const path of ['/admin.js', '/style.css']) assert.equal((await fetch(base + path)).status, 200);
  for (const [path, type] of [['/favicon.ico', 'image/x-icon'], ['/favicon-32.png', 'image/png'], ['/apple-touch-icon.png', 'image/png']]) {
    const icon = await fetch(base + path); assert.equal(icon.status, 200); assert.equal(icon.headers.get('content-type'), type);
    assert.ok((await icon.arrayBuffer()).byteLength > 100);
  }
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
