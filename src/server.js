import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { PrintService } from './service.js';
import { InputError, clientName } from './validation.js';

export const version = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
const digest = value => createHash('sha256').update(value).digest();
const pages = { '/index.html': ['index.html', 'text/html; charset=utf-8'], '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.ico': ['favicon.ico', 'image/x-icon'], '/favicon-32.png': ['favicon-32.png', 'image/png'], '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'] };

// LABEL_CLIENT_KEYS="storagesystem=<key>,homeassistant=<key>": one key per calling system, so each can be identified and revoked.
// LABEL_CLIENT_ROLES="studio=designer,mcp=drafter": designers create and publish templates, drafters only save drafts.
export function parseClients(env) {
  const clients = [], roles = {};
  for (const entry of (env.LABEL_CLIENT_ROLES || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [name, role, extra] = entry.split('=').map(s => s.trim());
    if (extra !== undefined || !clientName.test(name || '') || !['designer', 'drafter', 'client'].includes(role)) throw new Error('LABEL_CLIENT_ROLES entries must be name=designer, name=drafter or name=client.');
    roles[name] = role;
  }
  const add = (name, key) => {
    if (!clientName.test(name) || typeof key !== 'string' || key.length < 16) throw new Error(`Invalid client "${name}": use a lower-case name and a key of at least 16 characters.`);
    if (clients.some(c => c.name === name || c.key === key)) throw new Error(`Duplicate client name or key: ${name}.`);
    clients.push({ name, key, digest: digest(key), admin: name === 'admin', role: name === 'admin' ? 'designer' : roles[name] || 'client' });
  };
  if (env.LABEL_ADMIN_KEY?.trim()) add('admin', env.LABEL_ADMIN_KEY.trim());
  for (const entry of (env.LABEL_CLIENT_KEYS || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const at = entry.indexOf('='); if (at < 1) throw new Error('LABEL_CLIENT_KEYS entries must be name=key.');
    const name = entry.slice(0, at).trim();
    if (name === 'admin') throw new Error('The client name "admin" is reserved for LABEL_ADMIN_KEY.');
    add(name, entry.slice(at + 1).trim());
  }
  for (const name of Object.keys(roles)) if (!clients.some(c => c.name === name)) throw new Error(`LABEL_CLIENT_ROLES names an unknown client: ${name}.`);
  return clients;
}

async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new InputError('Request body is too large.', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new InputError('Send JSON with Content-Type: application/json.', 415);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new InputError('Invalid JSON.'); }
}

export function createApp({ store, env = process.env, service } = {}) {
  const clients = parseClients(env);
  const origins = (env.LABEL_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  service ||= new PrintService(store, { defaults: { serverUrl: env.CUPS_URL, queue: env.CUPS_QUEUE, printerHost: env.PRINTER_HOST, printerPort: env.PRINTER_PORT ? Number(env.PRINTER_PORT) : undefined,
    printerModel: env.PRINTER_MODEL, printerName: env.PRINTER_NAME } });
  const identify = req => {
    const header = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!header) return null;
    const given = digest(String(header));
    return clients.find(c => timingSafeEqual(c.digest, given)) || null;
  };
  return createServer(async (req, res) => {
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost'), path = url.pathname, method = req.method;
      if (path === '/healthz' && method === 'GET') return json({ ok: true, version });
      const page = pages[path === '/' ? '/index.html' : path];
      if (page && method === 'GET') {
        // The admin page holds no data; it asks for the admin key and keeps it in the tab's memory only.
        res.writeHead(200, { 'content-type': page[1], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
        return res.end(readFileSync(new URL(`../web/${page[0]}`, import.meta.url)));
      }
      if (!path.startsWith('/api/v1/')) throw new InputError('Not found.', 404);
      // Browsers may call the API from this service's own admin page or from origins configured explicitly.
      if (req.headers.origin && !origins.includes(req.headers.origin) && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) {
        throw new InputError('Origin is not allowed.', 403);
      }
      const client = identify(req);
      if (!client) throw new InputError(clients.length ? 'A valid API key is required.' : 'No API keys are configured. Set LABEL_ADMIN_KEY or LABEL_CLIENT_KEYS.', 401);
      const admin = () => { if (!client.admin) throw new InputError('This operation requires the admin key.', 403); };
      const jobMatch = path.match(/^\/api\/v1\/jobs\/([a-f0-9-]{36})$/);
      const templateMatch = path.match(/^\/api\/v1\/templates\/([a-z0-9-]{2,64})(?:\/versions(?:\/(\d{1,6})\/(publish|archive))?)?$/);
      const printer = url.searchParams.get('printer') ?? undefined, wanted = url.searchParams.get('version');
      if (path === '/api/v1/formats' && method === 'GET') return json(service.formats(printer));
      if (path === '/api/v1/templates' && method === 'GET') return json(service.templates(client));
      if (path === '/api/v1/templates' && method === 'POST') return json(service.saveTemplate(await body(req), client), 201);
      if (templateMatch && method === 'GET' && !path.endsWith('/versions') && !templateMatch[3]) {
        if (wanted !== null && !/^\d{1,6}$/.test(wanted)) throw new InputError('version must be a number.');
        return json(service.template(templateMatch[1], wanted === null ? undefined : Number(wanted), client));
      }
      if (templateMatch && method === 'GET' && path.endsWith('/versions')) return json(service.templateVersions(templateMatch[1], client));
      if (templateMatch?.[3] && method === 'POST') return json(service.setTemplateStatus(templateMatch[1], Number(templateMatch[2]), templateMatch[3] === 'publish' ? 'published' : 'archived', client));
      if (path === '/api/v1/status' && method === 'GET') return json(await service.status(printer));
      if (path === '/api/v1/previews' && method === 'POST') return json(await service.preview(await body(req), client), 201);
      if (path === '/api/v1/jobs' && method === 'POST') return json(await service.submit(await body(req), client), 201);
      if (path === '/api/v1/jobs' && method === 'GET') return json({ jobs: service.jobs(client.admin ? null : client.name) });
      if (jobMatch && method === 'GET') return json(await service.job(jobMatch[1], client.admin ? null : client.name));
      if (path === '/api/v1/settings' && method === 'GET') { admin(); return json(service.view()); }
      if (path === '/api/v1/settings' && method === 'PUT') { admin(); return json(service.save(await body(req))); }
      if (path === '/api/v1/roll' && method === 'POST') { admin(); return json(await service.readRoll(await body(req))); }
      throw new InputError('Not found.', 404);
    } catch (error) {
      const status = error instanceof InputError ? error.status : 500;
      if (status === 500) console.error(error);
      json({ error: status === 500 ? 'Internal error.' : error.message }, status);
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const store = new Store(process.env.LABEL_DB || './data/label-service.sqlite');
  const app = createApp({ store });
  const port = Number(process.env.PORT || 3230), host = process.env.HOST || '127.0.0.1';
  app.listen(port, host, () => console.log(`Label service ${version} listening on ${host}:${port}.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close(() => { store.close(); process.exit(0); }));
}
