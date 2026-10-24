// Admin page for the label service. Same-origin calls with the admin key, which is kept in memory only.
const $ = id => document.getElementById(id);
const sizeKeys = ['titleSize', 'descriptionSize', 'locationSize', 'locationLabelSize'];
let key = '', settings = null, roll = null, preview = null, requestId = null, busy = false;

const message = (text, error = false) => { $('message').textContent = text; $('message').className = error ? 'error' : ''; };
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`/api/v1${path}`, { method, headers: { 'x-api-key': key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
async function run(action) {
  if (busy) return; busy = true; document.querySelectorAll('button').forEach(b => { b.dataset.was = b.disabled; b.disabled = true; });
  try { await action(); } catch (error) { message(error.message, true); }
  finally { busy = false; document.querySelectorAll('button').forEach(b => { b.disabled = b.dataset.was === 'true'; }); $('print').disabled = !preview?.printable; }
}
const presetName = mediaKey => settings.mediaPresets.find(p => p.key === mediaKey)?.name || mediaKey;

function showStyle() {
  const style = settings.config.styles[$('style-media').value];
  $('style-name').textContent = presetName($('style-media').value);
  $('orientation').value = style.orientation;
  for (const k of sizeKeys) $(k).value = style[k];
}
function readStyle() {
  const style = settings.config.styles[$('style-media').value];
  style.orientation = $('orientation').value;
  for (const k of sizeKeys) style[k] = Number($(k).value);
}
function fill() {
  const options = () => settings.mediaPresets.map(p => new Option(p.name, p.key));
  $('media').replaceChildren(...options()); $('media').value = settings.config.mediaKey;
  $('style-media').replaceChildren(...options()); $('style-media').value = settings.config.mediaKey;
  showStyle();
}
async function status() {
  const s = await api('/status');
  const rows = [['Queue', `${s.queue}: ${s.state}${s.acceptingJobs ? ', accepting jobs' : ', not accepting jobs'}`], ['Queued jobs', String(s.queuedJobs ?? 'unknown')],
    ['Reasons', s.reasons.join(', ') || 'none'], ['Printer', s.model || 'unknown'], ['Selected format', presetName(s.mediaKey)], ['Checked', new Date().toLocaleString()]];
  $('status').replaceChildren(...rows.flatMap(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; return [dt, dd]; }));
}
async function jobs() {
  const { jobs } = await api('/jobs');
  $('jobs').replaceChildren(...jobs.map(job => {
    const tr = document.createElement('tr');
    for (const v of [new Date(job.createdAt).toLocaleString(), job.client, job.kind, presetName(job.mediaKey), job.state, job.jobId ?? '']) { const td = document.createElement('td'); td.textContent = v; tr.append(td); }
    return tr;
  }));
}
function invalidate() { preview = null; requestId = null; $('paper').replaceChildren(); $('print').disabled = true; }

$('login').addEventListener('submit', event => { event.preventDefault(); key = $('key').value; run(async () => {
  settings = await api('/settings'); fill(); $('login').hidden = true; $('app').hidden = false; $('key').value = '';
  // Show the journal even when CUPS is unreachable; the queue error is reported after it.
  await jobs(); message(''); await status();
}); });
$('refresh').addEventListener('click', () => run(async () => { await status(); await jobs(); message(''); }));
$('read-roll').addEventListener('click', () => run(async () => {
  roll = null; $('use-roll').hidden = true;
  const result = await api('/roll', { revision: settings.revision }); roll = result.roll;
  $('roll').textContent = `${roll.sku} · ${roll.labelsRemaining} labels remaining · ${roll.media ? roll.media.name : 'no known format for this article'} · read ${new Date(roll.observedAt).toLocaleString()}`;
  $('use-roll').hidden = !roll.media || roll.media.key === settings.config.mediaKey;
  message(roll.media && roll.media.key !== settings.config.mediaKey ? 'The loaded roll differs from the selected format.' : 'Roll read; release requested.');
}));
$('use-roll').addEventListener('click', () => run(async () => {
  settings = await api('/settings', { revision: settings.revision, config: { ...settings.config, mediaKey: roll.media.key } }, 'PUT');
  fill(); invalidate(); $('use-roll').hidden = true; await status(); message(`Selected format: ${presetName(settings.config.mediaKey)}.`);
}));
$('style-media').addEventListener('change', () => { showStyle(); });
for (const id of ['orientation', ...sizeKeys]) $(id).addEventListener('change', () => { readStyle(); invalidate(); });
$('settings').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  readStyle();
  settings = await api('/settings', { revision: settings.revision, config: { ...settings.config, mediaKey: $('media').value } }, 'PUT');
  fill(); invalidate(); await status(); message('Settings saved.');
}); });
$('kind').addEventListener('change', invalidate);
$('preview').addEventListener('click', () => run(async () => {
  invalidate();
  preview = await api('/previews', { kind: $('kind').value, test: true, mediaKey: settings.config.mediaKey });
  requestId = crypto.randomUUID();
  const img = document.createElement('img'), caption = document.createElement('figcaption');
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.svg)}`; img.alt = 'Label preview';
  caption.className = 'hint'; caption.textContent = `${preview.layout.name} · ${preview.layout.orientation}${preview.layout.rotated ? ' · rotated on the label' : ''}`;
  $('paper').replaceChildren(img, caption);
  message(preview.printable ? 'Preview ready. Print sends one label.' : `Text does not fit (${preview.layout.warnings.join(', ')}). Change the sizes or direction.`, !preview.printable);
}));
$('print').addEventListener('click', () => run(async () => {
  // Keep the same identifier after a lost response: retrying can only return the original job.
  const job = await api('/jobs', { token: preview.token, requestId });
  preview = null; message(`Submitted: ${job.state}${job.jobId ? `, CUPS job ${job.jobId}` : ''}. Check the physical label before printing again.`);
  await jobs();
}));
fetch('/healthz').then(r => r.json()).then(h => { $('version').textContent = `v${h.version}`; }).catch(() => {});
