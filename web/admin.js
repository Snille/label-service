// Admin page for the label service. Same-origin calls with the admin key, which is kept in memory only.
const $ = id => document.getElementById(id);
const sizeKeys = ['titleSize', 'descriptionSize', 'locationSize', 'locationLabelSize'];
let key = '', settings = null, current = '', roll = null, preview = null, requestId = null, busy = false;
// The roll whose test print is open, its preview and request id, and the journal as last read.
let testing = '', rollPreview = null, rollRequestId = null, journal = [];
// crypto.randomUUID exists only on https and localhost pages; the admin page is often opened over plain http on the LAN.
const uuid = () => { const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = b[6] & 15 | 64; b[8] = b[8] & 63 | 128;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join(''); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const cell = (row, value) => { const td = document.createElement('td'); if (value instanceof Node) td.append(value); else td.textContent = value; row.append(td); return td; };
const button = (label, action) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'quiet'; b.textContent = label; b.addEventListener('click', () => run(action)); return b; };
const actions = (...buttons) => { const span = document.createElement('span'); span.className = 'actions'; span.append(...buttons); return span; };
const sizeOf = p => `${p.widthMm} × ${p.heightMm} mm`;
const marginsOf = m => m ? `top ${m.top}, right ${m.right}, bottom ${m.bottom}, left ${m.left} mm` : '';
const customKey = r => `custom_${r.widthMm}x${r.heightMm}mm_${r.widthMm}x${r.heightMm}mm`;

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
  finally { busy = false; document.querySelectorAll('button').forEach(b => { b.disabled = b.dataset.was === 'true'; }); $('print').disabled = !preview?.printable; if (settings) showRollTest(); }
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
  showStyle(); showRolls(); showPrinters();
}

function showRolls() {
  $('rolls').replaceChildren(...settings.mediaPresets.map(p => {
    const tr = document.createElement('tr');
    cell(tr, p.name); cell(tr, p.sku); cell(tr, sizeOf(p));
    cell(tr, p.custom ? (p.status === 'approved' ? 'approved' : 'testing: needs its test print') : 'built in');
    cell(tr, marginsOf(p.margins) || (p.custom ? 'not measured yet' : 'not measured'));
    // Built-in formats are measured with the same test print; only added rolls can be removed.
    const test = button(p.margins ? 'Test again' : 'Test print', async () => { testing = p.key; rollPreview = null; showRollTest(); $('roll-test').scrollIntoView(); });
    cell(tr, actions(test, ...(p.custom ? [button('Remove', async () => {
      if (!confirm(`Remove the roll ${p.name}? Templates and printers must not use it.`)) return;
      await save(config => { config.rolls = config.rolls.filter(r => customKey(r) !== p.key); }, `Removed ${p.name}.`);
      if (testing === p.key) testing = '';
      showRollTest();
    })] : [])));
    return tr;
  }));
  showRollTest();
}
// The last test print of the roll that reached CUPS: that is the print to approve.
const testJob = mediaKey => journal.find(job => job.kind === 'calibration' && job.mediaKey === mediaKey && job.state === 'submitted');
function showRollTest() {
  const media = settings.mediaPresets.find(p => p.key === testing);
  $('roll-test').hidden = !media; if (!media) return;
  const loaded = printer().mediaKey === media.key, supported = modelOf(printer()).media.includes(media.key);
  $('roll-test-title').textContent = `Test print: ${media.name} on ${printer().name}`;
  $('roll-load').hidden = loaded; $('roll-load').disabled = !supported;
  $('roll-preview').disabled = !loaded;
  $('roll-print').disabled = !rollPreview?.printable;
  if (!rollPreview) $('roll-paper').replaceChildren();
  const job = testJob(media.key);
  $('roll-job').textContent = !supported ? `${modelOf(printer()).name} does not take ${sizeOf(media)} labels. Choose another printer.`
    : job ? `Test print sent ${new Date(job.createdAt).toLocaleString()} (CUPS job ${job.jobId}). Enter the margins you read on that label and approve it.`
    : 'No test print of this roll has reached the printer yet.';
  for (const side of ['top', 'right', 'bottom', 'left']) $(`margin-${side}`).value = media.margins?.[side] ?? 0;
  $('roll-approve-button').disabled = !job;
}
function showPrinters() {
  $('printers').replaceChildren(...settings.config.printers.map(p => {
    const tr = document.createElement('tr'), isDefault = p.id === settings.config.defaultPrinter;
    cell(tr, `${p.name}${isDefault ? ' (default)' : ''}`); cell(tr, modelOf(p)?.name || p.model);
    cell(tr, p.device || 'from the stack environment'); cell(tr, p.queue || 'none'); cell(tr, presetName(p.mediaKey));
    cell(tr, isDefault ? '' : actions(button('Make default', () => save(config => { config.defaultPrinter = p.id; }, `${p.name} is the default printer.`)),
      button('Remove', async () => {
        if (!confirm(`Remove ${p.name}? Its CUPS queue is removed too, with any jobs still in it. Check that its queue is empty first.`)) return;
        await save(config => { config.printers = config.printers.filter(x => x.id !== p.id); }, `Removed ${p.name}.`);
      })));
    return tr;
  }));
  if (!$('printer-model').options.length) $('printer-model').replaceChildren(...settings.models.map(m => new Option(m.name, m.key)));
  showConnection();
  $('printer-queues').textContent = settings.queuesFile
    ? 'The cups container creates the printer\'s queue within a few seconds of saving. A USB printer must also be passed into the cups container.'
    : 'This service cannot create CUPS queues: LABEL_QUEUES_FILE is not set. See the README.';
}
function showConnection() {
  const usb = $('printer-connection').value === 'usb', model = settings.models.find(m => m.key === $('printer-model').value);
  $('printer-host-label').hidden = usb; $('printer-usb-label').hidden = !usb;
  $('printer-reader-label').hidden = usb || !model?.rollReader;
}
async function status() {
  const s = await api(`/status?printer=${encodeURIComponent(current)}`);
  const rows = [['Printer', `${s.name} · ${modelOf(printer()).name}`], ['Queue', `${s.queue}: ${s.state}${s.acceptingJobs ? ', accepting jobs' : ', not accepting jobs'}`], ['Queued jobs', String(s.queuedJobs ?? 'unknown')],
    ['Reasons', s.reasons.join(', ') || 'none'], ['CUPS driver', s.model || 'unknown'], ['Selected format', presetName(s.mediaKey)], ['Checked', new Date().toLocaleString()]];
  $('status').replaceChildren(...rows.flatMap(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; return [dt, dd]; }));
}
async function jobs() {
  const { jobs } = await api('/jobs'); journal = jobs; showRollTest();
  $('jobs').replaceChildren(...jobs.map(job => {
    const tr = document.createElement('tr');
    const type = job.template ? `${job.template.id} v${job.template.version}` : job.kind;
    for (const v of [new Date(job.createdAt).toLocaleString(), job.client, type, printerName(job.printer), presetName(job.mediaKey), job.state, job.jobId ?? '']) { const td = document.createElement('td'); td.textContent = v; tr.append(td); }
    return tr;
  }));
}
// A hex string as rows of 16 bytes: offset, bytes, and the printable characters.
const dump = hex => (hex.match(/.{1,32}/g) || []).map((row, i) => {
  const bytes = row.match(/../g);
  return `${(i * 16).toString().padStart(3, ' ')}  ${bytes.join(' ').padEnd(47, ' ')}  ${bytes.map(b => { const c = parseInt(b, 16); return c >= 32 && c < 127 ? String.fromCharCode(c) : '.'; }).join('')}`;
}).join('\n');
async function readings() {
  const { readings } = await api('/roll/readings');
  $('readings').replaceChildren(...(readings.length ? readings.map(r => {
    const block = document.createElement('div'), title = document.createElement('p'), pre = document.createElement('pre');
    title.textContent = `${new Date(r.observedAt).toLocaleString()} · ${printerName(r.printer)} · ${r.sku} · ${r.labelsRemaining} labels remaining`;
    pre.textContent = `Consumable (ESC U, ${r.raw.consumable.length / 2} bytes)\n${dump(r.raw.consumable)}\n\nStatus (ESC A, ${r.raw.status.length / 2} bytes)\n${dump(r.raw.status)}`;
    block.append(title, pre); return block;
  }) : [Object.assign(document.createElement('p'), { className: 'hint', textContent: 'No readings yet. Read the loaded roll above.' })]));
}
function invalidate() { preview = null; requestId = null; $('paper').replaceChildren(); $('print').disabled = true; }
async function save(change, done) {
  const config = structuredClone(settings.config); change(config, config.printers.find(p => p.id === current));
  settings = await api('/settings', { revision: settings.revision, config }, 'PUT');
  // The settings are saved; a queue that cannot be reached is reported after the confirmation, not instead of it.
  fill(); invalidate(); message(done);
  try { await status(); } catch (error) { message(`${done} ${error.message}`, true); }
}

$('login').addEventListener('submit', event => { event.preventDefault(); key = $('key').value; run(async () => {
  settings = await api('/settings'); current = settings.config.defaultPrinter; fill(); $('login').hidden = true; $('app').hidden = false; $('key').value = '';
  // Show the journal even when CUPS is unreachable; the queue error is reported after it.
  await jobs(); await readings(); message(''); await status();
}); });
$('printer').addEventListener('change', () => run(async () => { current = $('printer').value; roll = null; $('roll').textContent = ''; $('use-roll').hidden = true; fill(); invalidate(); message(''); await status(); }));
$('refresh').addEventListener('click', () => run(async () => { await status(); await jobs(); message(''); }));
$('read-roll').addEventListener('click', () => run(async () => {
  roll = null; $('use-roll').hidden = true; $('add-detected').hidden = true;
  const result = await api('/roll', { revision: settings.revision, printer: current }); roll = result.roll;
  const size = roll.chip ? ` · the chip says ${roll.chip.widthMm} × ${roll.chip.lengthMm} mm${roll.chip.labelsPerRoll ? `, ${roll.chip.labelsPerRoll} labels per roll` : ''}` : '';
  $('roll').textContent = `${roll.sku} · ${roll.labelsRemaining} labels remaining · ${roll.media ? roll.media.name : 'no known format for this article'}${size} · read ${new Date(roll.observedAt).toLocaleString()}`;
  $('use-roll').hidden = !roll.media || roll.media.key === printer().mediaKey;
  $('add-detected').hidden = Boolean(roll.media);
  await readings(); $('readings-box').open = true;
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
  requestId = uuid();
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
// An unknown roll: fill the add form from the chip. The admin checks the size and adds it; it starts as testing.
$('add-detected').addEventListener('click', () => {
  $('roll-sku').value = roll.sku; $('roll-name').value = '';
  $('roll-width').value = roll.chip?.widthMm ?? ''; $('roll-height').value = roll.chip?.lengthMm ?? '';
  $('roll-from-chip').hidden = false;
  $('roll-from-chip').textContent = roll.chip
    ? `Filled in from the roll's chip: ${roll.chip.widthMm} × ${roll.chip.lengthMm} mm. Check it with a ruler: the chip gives the whole label, and a fold-over label prints on a smaller face. Then add the roll and print its test label.`
    : 'The chip gave no size for this roll. Measure the label and enter its width and length.';
  $('roll-add').scrollIntoView({ block: 'center' }); (roll.chip ? $('roll-name') : $('roll-width')).focus();
});
$('roll-add').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  const added = { sku: $('roll-sku').value.trim(), ...($('roll-name').value.trim() ? { name: $('roll-name').value.trim() } : {}),
    widthMm: Number($('roll-width').value), heightMm: Number($('roll-height').value), status: 'testing' };
  await save(config => { config.rolls = [...(config.rolls || []), added]; }, `Added ${added.sku}. Print its test label before anything else prints on it.`);
  testing = customKey(added); rollPreview = null; $('roll-add').reset(); $('roll-from-chip').hidden = true; $('add-detected').hidden = true; showRollTest();
}); });
$('roll-load').addEventListener('click', () => run(async () => {
  const media = settings.mediaPresets.find(p => p.key === testing);
  await save((config, p) => { p.mediaKey = media.key; }, `Selected format: ${media.name}.`);
}));
$('roll-preview').addEventListener('click', () => run(async () => {
  rollPreview = null; rollRequestId = null; showRollTest();
  rollPreview = await api('/previews', { kind: 'calibration', test: true, printer: current, mediaKey: testing });
  rollRequestId = uuid();
  const img = document.createElement('img'); img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rollPreview.svg)}`; img.alt = 'Test label preview';
  $('roll-paper').replaceChildren(img); showRollTest();
  message(rollPreview.printable ? 'Test label ready. Print sends one label.' : rollPreview.warnings.map(w => w.message).join(' '), !rollPreview.printable);
}));
$('roll-print').addEventListener('click', () => run(async () => {
  if (!confirm(`Print one test label on ${printer().name}?`)) return;
  // Keep the same identifier after a lost response: retrying can only return the original job.
  const job = await api('/jobs', { token: rollPreview.token, requestId: rollRequestId });
  rollPreview = null; await jobs();
  message(`Test label: ${job.state}${job.jobId ? `, CUPS job ${job.jobId}` : ''}. Read the margins on the paper.`, job.state !== 'submitted');
}));
$('roll-approve').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  const job = testJob(testing), margins = Object.fromEntries(['top', 'right', 'bottom', 'left'].map(side => [side, Number($(`margin-${side}`).value)]));
  const request = { revision: settings.revision, key: testing, requestId: job.id, margins };
  // Templates that reach into the new margins would stop printing; name them and ask first.
  const { affected } = await api('/rolls/approve', { ...request, check: true });
  // The built-in labels (used by other systems) cannot be changed, so margins that stop them deserve a second look.
  const builtIns = affected.filter(a => a.status === 'built in');
  if (affected.length && !confirm(`These templates reach into the new margins and will not print on ${presetName(testing)} until they are changed:\n\n`
    + `${affected.map(a => `${a.name} (${a.id}${a.version ? ` v${a.version}, ${a.status}` : `, ${a.status}`}): ${a.objects.join(', ')}`).join('\n')}`
    + `${builtIns.length ? '\n\nThe built-in labels cannot be changed: other systems would get refusals for them on this roll. They have printed right on paper, so check the margins you read first.' : ''}`
    + '\n\nApprove these margins anyway?')) {
    message('Not approved. Check the margins, or change those templates first.'); return;
  }
  settings = await api('/rolls/approve', request);
  fill(); invalidate(); message(`Approved the margins of ${presetName(testing)}.${affected.length ? ` ${affected.length} template(s) need changes before they print on it.` : ''}`);
}); });
$('printer-model').addEventListener('change', showConnection);
$('printer-connection').addEventListener('change', showConnection);
$('printer-add').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  const name = $('printer-name').value.trim(), model = settings.models.find(m => m.key === $('printer-model').value), usb = $('printer-connection').value === 'usb';
  const base = name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'printer';
  let id = base; for (let n = 2; settings.config.printers.some(p => p.id === id); n++) id = `${base}-${n}`;
  const [host, port] = $('printer-host').value.trim().split(':');
  if (!usb && !host) throw new Error('Enter the printer\'s network address.');
  const reader = !usb && model.rollReader && $('printer-reader').checked;
  const added = { id, name, model: model.key, enabled: true, queue: `DYMO_${id.toUpperCase().replace(/-/g, '_')}`,
    device: usb ? $('printer-usb').value.trim() : `socket://${host}${port ? `:${port}` : ''}`,
    mediaKey: settings.mediaPresets.find(p => p.status === 'approved' && model.media.includes(p.key)).key, styles: {},
    rollReader: { enabled: reader, host: reader ? host : '', port: reader && port ? Number(port) : 9100 } };
  await save(config => { config.printers.push(added); }, `Added ${name}. Choose its loaded roll above once its queue shows.`);
  $('printer-add').reset(); showConnection();
}); });
fetch('/healthz').then(r => r.json()).then(h => { $('version').textContent = `v${h.version}`; }).catch(() => {});
