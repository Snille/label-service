import { randomUUID, createHash } from 'node:crypto';
import { InputError, object, validatePrinting } from './validation.js';
import { CupsPrinter } from './ipp.js';
import { defaultLabelStyles, labelKinds, labelMedia, labelMediaPresets, labelLayout, labelPostScript, testLabel } from './labels.js';
import { readDymoRoll } from './dymo-roll.js';
import { layoutSvg } from './svg.js';

const hash = input => createHash('sha256').update(input).digest('hex');
export const revisionOf = config => hash(JSON.stringify(config));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// The single owner of the printer. Clients send label content; only this service renders, submits and reads the roll.
export class PrintService {
  constructor(store, { defaults = {}, printerFactory = config => new CupsPrinter(config), rollReader = readDymoRoll } = {}) {
    this.store = store; this.defaults = defaults; this.printerFactory = printerFactory; this.rollReader = rollReader;
    this.previews = new Map(); this.busy = false; this.lastRollCheck = 0;
  }
  config() {
    return this.store.printing() || {
      enabled: Boolean(this.defaults.serverUrl && this.defaults.queue), serverUrl: this.defaults.serverUrl || '', queue: this.defaults.queue || '',
      mediaKey: labelMedia.key, styles: defaultLabelStyles(),
      rollReader: { enabled: Boolean(this.defaults.printerHost), host: this.defaults.printerHost || '', port: this.defaults.printerPort || 9100 }
    };
  }
  revision() { return revisionOf(this.config()); }
  view() {
    const config = this.config();
    return { config, revision: revisionOf(config), media: labelMediaPresets.find(p => p.key === config.mediaKey), mediaPresets: labelMediaPresets, kinds: labelKinds };
  }
  formats() {
    const config = this.config();
    return { mediaKey: config.mediaKey, media: labelMediaPresets.find(p => p.key === config.mediaKey), style: config.styles[config.mediaKey], mediaPresets: labelMediaPresets, kinds: labelKinds };
  }
  assertRevision(revision) { if (revision !== this.revision()) throw new InputError('Print settings changed. Create a new preview before printing.', 409); }
  save(input) {
    object(input);
    if (Object.keys(input).some(k => !['revision', 'config'].includes(k))) throw new InputError('Unsupported print setting.');
    return this.store.transaction(() => {
      this.assertRevision(input.revision); this.store.writePrinting(validatePrinting(input.config)); return this.view();
    });
  }
  printer(config = this.config()) { if (!config.enabled) throw new InputError('Printing is disabled. Save and enable the CUPS connection first.', 409); return this.printerFactory(config); }
  async status() {
    const config = this.config(), revision = revisionOf(config);
    const status = await this.printer(config).status(); this.assertRevision(revision);
    return { ...status, queue: config.queue, mediaKey: config.mediaKey };
  }
  async readRoll(input) {
    object(input);
    if (Object.keys(input).some(k => k !== 'revision')) throw new InputError('Unsupported roll-reading request.');
    this.assertRevision(input.revision); const config = this.config();
    if (!config.rollReader?.enabled) throw new InputError('Enable and save the DYMO roll reader first.', 409);
    if (this.busy || Date.now() - this.lastRollCheck < 5000) throw new InputError('Wait before reading the roll again.', 429);
    this.busy = true; this.lastRollCheck = Date.now();
    try {
      const queue = await this.printer(config).status(); this.assertRevision(input.revision);
      if (queue.state !== 'idle' || queue.queuedJobs !== 0) throw new InputError('Read the roll only while the CUPS queue is idle and empty.', 409);
      const roll = await this.rollReader(config.rollReader); this.assertRevision(input.revision);
      return { roll, revision: input.revision };
    } finally { this.busy = false; }
  }
  preview(input, client) {
    object(input);
    if (Object.keys(input).some(k => !['kind', 'test', 'fields', 'mediaKey', 'reference'].includes(k)) || (input.test !== undefined && typeof input.test !== 'boolean')
      || (input.kind !== undefined && !labelKinds.includes(input.kind))) throw new InputError('Unsupported label preview request.');
    if (input.reference !== undefined && (typeof input.reference !== 'string' || !input.reference.trim() || input.reference.length > 200)) throw new InputError('reference must be a short string.');
    const kind = input.kind || 'box', config = this.config(), revision = revisionOf(config), media = labelMediaPresets.find(p => p.key === config.mediaKey);
    // A client may state the format it expects; the loaded roll decides, so a mismatch is refused rather than printed on the wrong labels.
    if (input.mediaKey !== undefined && input.mediaKey !== config.mediaKey) throw new InputError(`The selected label format is ${media.name}. Change the roll and format first.`, 409);
    let fields;
    if (input.test === true) {
      if (input.fields) throw new InputError('Test labels use fixed sample text.');
      const location = `TEST - ${media.widthMm} x ${media.heightMm} mm`;
      fields = kind === 'box' ? { ...testLabel, location } : { location };
    } else fields = object(input.fields, 'fields');
    const layout = labelLayout(fields, config.styles[config.mediaKey], config.mediaKey, kind), token = randomUUID();
    const now = Date.now(); for (const [id, p] of this.previews) if (p.expires <= now) this.previews.delete(id);
    if (this.previews.size >= 100) throw new InputError('Too many label previews. Wait for an older preview to expire.', 429);
    const expires = now + 10 * 60 * 1000;
    this.previews.set(token, { config, revision, kind, client, reference: input.reference, layout, document: labelPostScript(layout), expires });
    return { token, expiresAt: new Date(expires).toISOString(), kind, fields, layout, svg: layoutSvg(layout), printable: layout.warnings.length === 0 };
  }
  assertPreview(preview) {
    this.assertRevision(preview.revision);
    if (Date.now() >= preview.expires) throw new InputError('Label preview expired. Create a new preview.', 409);
  }
  async submit(input, client) {
    object(input);
    if (Object.keys(input).some(k => !['token', 'requestId'].includes(k)) || typeof input.requestId !== 'string' || !uuid.test(input.requestId)
      || typeof input.token !== 'string' || !uuid.test(input.token)) throw new InputError('Use a valid preview token and print request identifier (UUIDs).');
    const tokenHash = hash(input.token), existing = this.store.printJob(input.requestId);
    if (existing) {
      if (existing.tokenHash !== tokenHash || existing.client !== client) throw new InputError('Print request identifier is already used by another preview.', 409);
      return existing;
    }
    const preview = this.previews.get(input.token);
    // A token from another client is treated as unknown, so clients cannot see or use each other's previews.
    if (!preview || preview.client !== client) throw new InputError('Create a new label preview before printing.', 409);
    this.assertPreview(preview);
    if (preview.layout.warnings.length) throw new InputError('Label text does not fit. Shorten the label text or reduce font sizes before printing.', 409);
    if (this.busy) throw new InputError('Another print submission is in progress. Check its status first.', 429);
    this.busy = true; let claimed = false, sent = false;
    try {
      const printer = this.printer(preview.config), status = await printer.status(); this.assertPreview(preview);
      if (!status.acceptingJobs || status.state === 'stopped' || !status.formats.includes('application/postscript')) throw new InputError('The queue is stopped, not accepting jobs or does not support PostScript.', 409);
      await printer.validate(preview.config.mediaKey, `label-service ${client}`); this.assertPreview(preview);
      const claim = this.store.claimPrint({ id: input.requestId, tokenHash, documentHash: hash(preview.document), settingsRevision: preview.revision,
        serverUrl: preview.config.serverUrl, queue: preview.config.queue, mediaKey: preview.config.mediaKey, createdAt: new Date().toISOString(), state: 'submitting',
        client, kind: preview.kind, ...(preview.reference ? { reference: preview.reference } : {}) });
      if (!claim.claimed) return claim.job;
      claimed = true; sent = true;
      const jobId = await printer.print(preview.config.mediaKey, `label-service ${client}`, preview.document);
      return this.store.updatePrint(input.requestId, { state: 'submitted', jobId });
    } catch (error) {
      if (claimed) {
        // A lost response may follow a successful physical submission. Never retry it.
        // Only a verified IPP error status proves that CUPS created no job.
        return this.store.updatePrint(input.requestId, { state: sent && !(error.ippStatus >= 0x400) ? 'unknown' : 'rejected' });
      }
      throw error;
    } finally { this.busy = false; }
  }
  jobs(client) {
    return this.store.printJobs().filter(job => !client || job.client === client).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
  }
  async job(id, client) {
    const record = this.store.printJob(id);
    if (!record || (client && record.client !== client)) throw new InputError('Print job not found.', 404);
    if (!record.jobId) return { record, status: null };
    return { record, status: await this.printerFactory(record).job(record.jobId) };
  }
}
