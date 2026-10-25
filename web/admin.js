// Admin page for the label service. Same-origin calls with the admin key, which is kept in memory only.
const $ = id => document.getElementById(id);
const sizeKeys = ['titleSize', 'descriptionSize', 'locationSize', 'locationLabelSize'];
let key = '', settings = null, current = '', roll = null, preview = null, requestId = null, busy = false;

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
const printer = () => settings.config.printers.find(p => p.id === current);
const modelOf = p => settings.models.find(m => m.key === p.model);
const printerName = id => settings.config.printers.find(p => p.id === id)?.name || id || '';

function showStyle() {
  const style = printer().styles[$('style-media').value];
  $('style-name').textContent = presetName($('style-media').value);
  $('orientation').value = style.orientation;
  for (const k of sizeKeys) $(k).value = style[k];
}
function readStyle() {
  const style = printer().styles[$('style-media').value];
  style.orientation = $('orientation').value;
  for (const k of sizeKeys) style[k] = Number($(k).value);
}
function fill() {
  if (!settings.config.printers.some(p => p.id === current)) current = settings.config.defaultPrinter;
  $('printer').replaceChildren(...settings.config.printers.map(p => new Option(`${p.name} (${modelOf(p)?.name || p.model})`, p.id)));
  $('printer').value = current; $('printer-choice').hidden = settings.config.printers.length < 2;
  const options = () => modelOf(printer()).media.map(k => new Option(presetName(k), k));
  $('media').replaceChildren(...options()); $('media').value = printer().mediaKey;
  $('style-media').replaceChildren(...options()); $('style-media').value = printer().mediaKey;
  $('batch-limit').value = settings.config.batchLimit;
  $('read-roll').hidden = !modelOf(printer()).rollReader;
  showStyle();
}
async function status() {
  const s = await api(`/status?printer=${encodeURIComponent(current)}`);
  const rows = [['Printer', `${s.name} · ${modelOf(printer()).name}`], ['Queue', `${s.queue}: ${s.state}${s.acceptingJobs ? ', accepting jobs' : ', not accepting jobs'}`], ['Queued jobs', String(s.queuedJobs ?? 'unknown')],
    ['Reasons', s.reasons.join(', ') || 'none'], ['CUPS driver', s.model || 'unknown'], ['Selected format', presetName(s.mediaKey)], ['Checked', new Date().toLocaleString()]];
  $('status').replaceChildren(...rows.flatMap(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; return [dt, dd]; }));
}
async function jobs() {
  const { jobs } = await api('/jobs');
  $('jobs').replaceChildren(...jobs.map(job => {
    const tr = document.createElement('tr');
    const type = job.template ? `${job.template.id} v${job.template.version}` : job.kind;
    for (const v of [new Date(job.createdAt).toLocaleString(), job.client, type, printerName(job.printer), presetName(job.mediaKey), job.state, job.jobId ?? '']) { const td = document.createElement('td'); td.textContent = v; tr.append(td); }
    return tr;
  }));
}
function invalidate() { preview = null; requestId = null; $('paper').replaceChildren(); $('print').disabled = true; }
async function save(change, done) {
  const config = structuredClone(settings.config); change(config, config.printers.find(p => p.id === current));
  settings = await api('/settings', { revision: settings.revision, config }, 'PUT');
  fill(); invalidate(); await status(); message(done);
}

$('login').addEventListener('submit', event => { event.preventDefault(); key = $('key').value; run(async () => {
  settings = await api('/settings'); current = settings.config.defaultPrinter; fill(); $('login').hidden = true; $('app').hidden = false; $('key').value = '';
  // Show the journal even when CUPS is unreachable; the queue error is reported after it.
  await jobs(); message(''); await status();
}); });
$('printer').addEventListener('change', () => run(async () => { current = $('printer').value; roll = null; $('roll').textContent = ''; $('use-roll').hidden = true; fill(); invalidate(); message(''); await status(); }));
$('refresh').addEventListener('click', () => run(async () => { await status(); await jobs(); message(''); }));
$('read-roll').addEventListener('click', () => run(async () => {
  roll = null; $('use-roll').hidden = true;
  const result = await api('/roll', { revision: settings.revision, printer: current }); roll = result.roll;
  $('roll').textContent = `${roll.sku} · ${roll.labelsRemaining} labels remaining · ${roll.media ? roll.media.name : 'no known format for this article'} · read ${new Date(roll.observedAt).toLocaleString()}`;
  $('use-roll').hidden = !roll.media || roll.media.key === printer().mediaKey;
  message(roll.media && roll.media.key !== printer().mediaKey ? 'The loaded roll differs from the selected format.' : 'Roll read; release requested.');
}));
$('use-roll').addEventListener('click', () => run(async () => {
  await save((config, p) => { p.mediaKey = roll.media.key; }, `Selected format: ${presetName(roll.media.key)}.`); $('use-roll').hidden = true;
}));
$('style-media').addEventListener('change', () => { showStyle(); });
for (const id of ['orientation', ...sizeKeys]) $(id).addEventListener('change', () => { readStyle(); invalidate(); });
$('settings').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  readStyle(); const styles = structuredClone(printer().styles);
  await save((config, p) => { p.mediaKey = $('media').value; p.styles = styles; config.batchLimit = Number($('batch-limit').value); }, 'Settings saved.');
}); });
$('kind').addEventListener('change', invalidate);
$('test-orientation').addEventListener('change', invalidate);
$('preview').addEventListener('click', () => run(async () => {
  invalidate();
  const orientation = $('test-orientation').value;
  preview = await api('/previews', { kind: $('kind').value, test: true, printer: current, mediaKey: printer().mediaKey, ...(orientation ? { orientation } : {}) });
  requestId = crypto.randomUUID();
  const img = document.createElement('img'), caption = document.createElement('figcaption');
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.svg)}`; img.alt = 'Label preview';
  caption.className = 'hint'; caption.textContent = `${preview.layout.name} · ${preview.layout.orientation}${preview.layout.rotated ? ' · rotated on the label' : ''}`;
  $('paper').replaceChildren(img, caption);
  message(preview.printable ? 'Preview ready. Print sends one label.' : preview.warnings.map(w => w.message).join(' '), !preview.printable);
}));
$('print').addEventListener('click', () => run(async () => {
  // Keep the same identifier after a lost response: retrying can only return the original job.
  const job = await api('/jobs', { token: preview.token, requestId });
  preview = null; message(`Submitted: ${job.state}${job.jobId ? `, CUPS job ${job.jobId}` : ''}. Check the physical label before printing again.`);
  await jobs();
}));
fetch('/healthz').then(r => r.json()).then(h => { $('version').textContent = `v${h.version}`; }).catch(() => {});
