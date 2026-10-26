import { randomUUID, createHash } from 'node:crypto';
import { InputError, object, validatePrinting } from './validation.js';
import { CupsPrinter } from './ipp.js';
import { defaultLabelStyles, labelMediaPresets, labelTemplates, layoutTemplate, testLabel, testLines } from './labels.js';
import { printerModels, printerModel, mediaForModel } from './label-media.js';
import { builtInTemplates, validateTemplate, templateId } from './template.js';
import { fontFamilies } from './fonts.js';
import { readDymoRoll } from './dymo-roll.js';
import { layoutSvg, pageSvg } from './svg.js';
import { rsvgConvert } from './convert.js';

const hash = input => createHash('sha256').update(input).digest('hex');
export const revisionOf = config => hash(JSON.stringify(config));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const documentFormat = 'application/pdf';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Callers are identified by name; designers create and publish templates, drafters (LLM tools) only save drafts.
const who = client => typeof client === 'string' ? { name: client, role: client === 'admin' ? 'designer' : 'client' } : client;
const canDraft = client => ['designer', 'drafter'].includes(client.role);
const wasPublished = record => record.status === 'published' || Boolean(record.publishedAt);
const summary = record => ({ id: record.id, name: record.name, builtIn: false, version: record.version, status: record.status, media: record.definition.media,
  description: record.definition.description, fields: record.definition.fields, createdAt: record.createdAt, createdBy: record.createdBy });

// The single owner of the printers. Clients send label content; only this service renders, submits and reads the roll.
export class PrintService {
  // settleMs: a DYMO printer still feeds and cuts after CUPS reports a job completed, and its driver refuses the next job
  // (com.dymo.busy-error) if that job arrives too soon. Each printer therefore rests this long after its last job.
  constructor(store, { defaults = {}, printerFactory = config => new CupsPrinter(config), rollReader = readDymoRoll, converter = rsvgConvert, settleMs = 10000, queueWaitMs = 120000 } = {}) {
    this.store = store; this.defaults = defaults; this.printerFactory = printerFactory; this.rollReader = rollReader; this.converter = converter;
    this.settleMs = settleMs; this.queueWaitMs = queueWaitMs;
    this.previews = new Map(); this.busy = new Set(); this.lastRollCheck = new Map(); this.lastPrint = new Map();
  }
  // Waits until the printer has rested since its last job and its CUPS queue is idle and empty, then returns the queue status.
  async settle(cups, printer) {
    const deadline = Date.now() + this.queueWaitMs;
    for (;;) {
      const wait = this.settleMs - (Date.now() - (this.lastPrint.get(printer.id) || 0));
      if (wait > 0) await delay(wait);
      const status = await cups.status();
      if ((status.state === 'idle' && status.queuedJobs === 0) || status.state === 'stopped' || !status.acceptingJobs) return status;
      if (Date.now() >= deadline) throw new InputError(`${printer.name} is still busy with an earlier label. Try again shortly.`, 429);
      // Still printing something: rest a full period after the last time it was seen busy.
      this.lastPrint.set(printer.id, Date.now());
    }
  }
  config() {
    const saved = this.store.printing(); if (saved) return saved;
    const d = this.defaults, model = printerModel(d.printerModel) || printerModels[0];
    const id = (d.queue || 'dymo').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'dymo';
    return { serverUrl: d.serverUrl || '', defaultPrinter: id, batchLimit: 50, printers: [{
      id, name: d.printerName || `DYMO ${model.name}`, model: model.key, enabled: Boolean(d.serverUrl && d.queue), queue: d.queue || '',
      mediaKey: mediaForModel(model.key)[0].key, styles: defaultLabelStyles(),
      rollReader: { enabled: Boolean(d.printerHost) && model.rollReader, host: d.printerHost || '', port: d.printerPort || 9100 } }] };
  }
  revision() { return revisionOf(this.config()); }
  printerConfig(config, id) {
    const printer = config.printers.find(p => p.id === (id ?? config.defaultPrinter));
    if (!printer) throw new InputError('Unknown printer.', 404);
    return printer;
  }
  view() {
    const config = this.config(), printer = this.printerConfig(config);
    return { config, revision: revisionOf(config), media: labelMediaPresets.find(p => p.key === printer.mediaKey), mediaPresets: labelMediaPresets,
      models: printerModels.map(m => ({ ...m, media: mediaForModel(m.key).map(p => p.key) })), kinds: builtInTemplates.map(t => t.id), fonts: fontFamilies };
  }
  formats(id) {
    const config = this.config(), printer = this.printerConfig(config, id);
    return { printer: { id: printer.id, name: printer.name, model: printer.model }, mediaKey: printer.mediaKey, media: labelMediaPresets.find(p => p.key === printer.mediaKey),
      style: printer.styles[printer.mediaKey], mediaPresets: mediaForModel(printer.model), kinds: builtInTemplates.map(t => t.id), fonts: fontFamilies,
      printers: config.printers.map(p => ({ id: p.id, name: p.name, model: p.model, enabled: p.enabled, mediaKey: p.mediaKey, default: p.id === config.defaultPrinter })) };
  }
  assertRevision(revision) { if (revision !== this.revision()) throw new InputError('Print settings changed. Create a new preview before printing.', 409); }
  save(input) {
    object(input);
    if (Object.keys(input).some(k => !['revision', 'config'].includes(k))) throw new InputError('Unsupported print setting.');
    return this.store.transaction(() => {
      this.assertRevision(input.revision); this.store.writePrinting(validatePrinting(input.config)); return this.view();
    });
  }
  printer(config, printer) {
    if (!printer.enabled) throw new InputError(`Printing on ${printer.name} is disabled. Save and enable its CUPS queue first.`, 409);
    return this.printerFactory({ serverUrl: config.serverUrl, queue: printer.queue });
  }
  async status(id) {
    const config = this.config(), revision = revisionOf(config), printer = this.printerConfig(config, id);
    const status = await this.printer(config, printer).status(); this.assertRevision(revision);
    return { ...status, printer: printer.id, name: printer.name, printerModel: printer.model, queue: printer.queue, mediaKey: printer.mediaKey };
  }
  async readRoll(input) {
    object(input);
    if (Object.keys(input).some(k => !['revision', 'printer'].includes(k))) throw new InputError('Unsupported roll-reading request.');
    this.assertRevision(input.revision); const config = this.config(), printer = this.printerConfig(config, input.printer);
    if (!printer.rollReader?.enabled) throw new InputError('Enable and save the DYMO roll reader first.', 409);
    if (this.busy.has(printer.id) || Date.now() - (this.lastRollCheck.get(printer.id) || 0) < 5000 || Date.now() - (this.lastPrint.get(printer.id) || 0) < this.settleMs) {
      throw new InputError('Wait before reading the roll again.', 429);
    }
    this.busy.add(printer.id); this.lastRollCheck.set(printer.id, Date.now());
    try {
      const queue = await this.printer(config, printer).status(); this.assertRevision(input.revision);
      if (queue.state !== 'idle' || queue.queuedJobs !== 0) throw new InputError('Read the roll only while the CUPS queue is idle and empty.', 409);
      const roll = await this.rollReader(printer.rollReader); this.assertRevision(input.revision);
      return { roll, printer: printer.id, revision: input.revision };
    } finally { this.busy.delete(printer.id); }
  }

  // Templates: the built-in kinds plus saved templates. Ordinary clients see published versions only.
  templates(client = 'client') {
    client = who(client);
    const saved = this.store.templateIds().map(id => {
      const versions = this.store.templateVersions(id), published = versions.filter(v => v.status === 'published').at(-1);
      // Designers and drafters also learn whether every version is archived and whether any was ever published.
      return canDraft(client) ? { ...summary(published || versions.at(-1)), latest: summary(versions.at(-1)),
        archived: versions.every(v => v.status === 'archived'), everPublished: versions.some(wasPublished) } : published && summary(published);
    }).filter(Boolean);
    return { templates: [...labelTemplates, ...saved] };
  }
  template(id, version, client = 'client') {
    client = who(client);
    const builtIn = builtInTemplates.find(t => t.id === id);
    if (builtIn) return { id, name: builtIn.name, builtIn: true, version: 1, status: 'published', definition: builtIn };
    const versions = templateId.test(id) ? this.store.templateVersions(id) : [];
    const visible = versions.filter(v => canDraft(client) || v.status === 'published');
    const record = version === undefined ? (visible.filter(v => v.status === 'published').at(-1) || (canDraft(client) ? visible.at(-1) : undefined)) : visible.find(v => v.version === version);
    if (!record) throw new InputError('Template not found.', 404);
    return record;
  }
  templateVersions(id, client) {
    if (!canDraft(who(client))) throw new InputError('This operation requires a designer key.', 403);
    const versions = this.store.templateVersions(id); if (!versions.length) throw new InputError('Template not found.', 404);
    return { versions: versions.map(summary) };
  }
  saveTemplate(input, client) {
    client = who(client); object(input);
    if (!canDraft(client)) throw new InputError('This operation requires a designer key.', 403);
    if (Object.keys(input).some(k => k !== 'definition')) throw new InputError('Send { definition }.');
    const definition = validateTemplate(structuredClone(input.definition));
    return this.store.addTemplateVersion({ id: definition.id, status: 'draft', name: definition.name, definition, createdAt: new Date().toISOString(), createdBy: client.name });
  }
  setTemplateStatus(id, version, status, client) {
    client = who(client);
    if (client.role !== 'designer') throw new InputError('Publishing and archiving require a designer key.', 403);
    if (!this.store.template(id, version)) throw new InputError('Template version not found.', 404);
    return this.store.updateTemplateVersion(id, version, status === 'published'
      ? { status, publishedAt: new Date().toISOString(), publishedBy: client.name } : { status, archivedAt: new Date().toISOString(), archivedBy: client.name });
  }
  // Only a template that was never published can be deleted: no other system can depend on it. Published ones are archived.
  deleteTemplate(id, client) {
    client = who(client);
    if (client.role !== 'designer') throw new InputError('Deleting templates requires a designer key.', 403);
    return this.store.transaction(() => {
      const versions = templateId.test(id) ? this.store.templateVersions(id) : [];
      if (!versions.length) throw new InputError('Template not found.', 404);
      if (versions.some(wasPublished)) throw new InputError('This template has been published, so other systems may use it. Archive its versions instead.', 409);
      return { id, deleted: this.store.deleteTemplate(id) };
    });
  }
  resolve(input, client) {
    if (input.template !== undefined && input.kind !== undefined) throw new InputError('Send either kind or template.');
    if (input.template && typeof input.template === 'object') {
      if (!canDraft(client)) throw new InputError('Only designer keys may preview unsaved templates.', 403);
      return { definition: validateTemplate(structuredClone(input.template)), ref: { id: input.template.id, version: 0, status: 'unsaved' } };
    }
    const id = input.template ?? input.kind ?? 'box';
    if (typeof id !== 'string' || (input.version !== undefined && !Number.isInteger(input.version))) throw new InputError('Unsupported label type.');
    if (input.kind !== undefined && !builtInTemplates.some(t => t.id === id)) throw new InputError('Unsupported label type.');
    const record = this.template(id, input.version, client);
    return { definition: record.definition, ref: { id, version: record.version, status: record.status }, builtIn: record.builtIn };
  }
  sampleFields(definition, media) {
    if (definition.id === 'box') return { ...testLabel, location: `TEST - ${media.widthMm} x ${media.heightMm} mm` };
    if (definition.id === 'location') return { location: `TEST - ${media.widthMm} x ${media.heightMm} mm` };
    if (definition.id === 'lines') return { lines: testLines };
    return Object.fromEntries(Object.entries(definition.fields).map(([key, field]) =>
      [key, field.type === 'lines' ? [{ text: field.sample || field.label || key }] : field.sample ?? field.label ?? key]));
  }

  async preview(input, client) {
    client = who(client); object(input);
    if (Object.keys(input).some(k => !['kind', 'template', 'version', 'test', 'fields', 'mediaKey', 'orientation', 'reference', 'printer', 'include'].includes(k))
      || (input.test !== undefined && typeof input.test !== 'boolean') || (input.orientation !== undefined && !['portrait', 'landscape'].includes(input.orientation))
      || (input.include !== undefined && (!Array.isArray(input.include) || input.include.some(i => i !== 'png')))) {
      throw new InputError('Unsupported label preview request.');
    }
    if (input.reference !== undefined && (typeof input.reference !== 'string' || !input.reference.trim() || input.reference.length > 200)) throw new InputError('reference must be a short string.');
    const config = this.config(), revision = revisionOf(config), printer = this.printerConfig(config, input.printer);
    const media = labelMediaPresets.find(p => p.key === printer.mediaKey);
    // A client may state the format it expects; the loaded roll decides, so a mismatch is refused rather than printed on the wrong labels.
    if (input.mediaKey !== undefined && input.mediaKey !== printer.mediaKey) throw new InputError(`The selected label format is ${media.name}. Change the roll and format first.`, 409);
    const { definition, ref, builtIn } = this.resolve(input, client);
    if (!definition.media.includes('*') && !definition.media.includes(printer.mediaKey)) throw new InputError(`The template "${definition.name}" is not made for ${media.name}. Load a matching roll first.`, 409);
    let fields;
    if (input.test === true) {
      if (input.fields) throw new InputError('Test labels use fixed sample text.');
      fields = this.sampleFields(definition, media);
    } else fields = object(input.fields, 'fields');
    // A client may choose the text direction for this label; otherwise the template's or the format's saved direction applies.
    const style = printer.styles[printer.mediaKey];
    const layout = layoutTemplate(definition, fields, { media, style, orientation: input.orientation });
    // Built-in and published templates print for every client; drafts and unsaved designs only from a designer key.
    const allowed = builtIn || ref.status === 'published' || client.role === 'designer';
    const problems = [...layout.problems, ...(allowed ? [] : [{ object: 'template', message: 'Only published templates can be printed with this key. Publish the template first.' }])];
    const printable = problems.length === 0, svg = layoutSvg(layout);
    const document = printable ? await this.converter(pageSvg(layout), 'pdf') : null;
    const png = input.include?.includes('png') ? (await this.converter(svg, 'png')).toString('base64') : undefined;
    const token = randomUUID(), now = Date.now();
    for (const [id, p] of this.previews) if (p.expires <= now) this.previews.delete(id);
    if (this.previews.size >= 100) throw new InputError('Too many label previews. Wait for an older preview to expire.', 429);
    const expires = now + 10 * 60 * 1000, kind = builtIn ? ref.id : 'template', template = builtIn ? undefined : { id: ref.id, version: ref.version };
    this.previews.set(token, { config, revision, printer: printer.id, kind, template, client: client.name, reference: input.reference, layout, printable, document, expires });
    return { token, expiresAt: new Date(expires).toISOString(), kind, ...(template ? { template: { ...template, status: ref.status } } : {}), printer: printer.id,
      fields, layout, svg, ...(png ? { png } : {}), printable, warnings: problems };
  }
  assertPreview(preview) {
    this.assertRevision(preview.revision);
    if (Date.now() >= preview.expires) throw new InputError('Label preview expired. Create a new preview.', 409);
  }
  async submit(input, client) {
    client = who(client); object(input);
    if (Object.keys(input).some(k => !['token', 'requestId'].includes(k)) || typeof input.requestId !== 'string' || !uuid.test(input.requestId)
      || typeof input.token !== 'string' || !uuid.test(input.token)) throw new InputError('Use a valid preview token and print request identifier (UUIDs).');
    const tokenHash = hash(input.token), existing = this.store.printJob(input.requestId);
    if (existing) {
      if (existing.tokenHash !== tokenHash || existing.client !== client.name) throw new InputError('Print request identifier is already used by another preview.', 409);
      return existing;
    }
    const preview = this.previews.get(input.token);
    // A token from another client is treated as unknown, so clients cannot see or use each other's previews.
    if (!preview || preview.client !== client.name) throw new InputError('Create a new label preview before printing.', 409);
    this.assertPreview(preview);
    if (!preview.printable) throw new InputError('Label text does not fit or the template is not published. Shorten the label text or reduce font sizes before printing.', 409);
    const printer = this.printerConfig(preview.config, preview.printer);
    if (this.busy.has(printer.id)) throw new InputError('Another print submission is in progress. Check its status first.', 429);
    this.busy.add(printer.id); let claimed = false, sent = false;
    try {
      const cups = this.printer(preview.config, printer), status = await this.settle(cups, printer); this.assertPreview(preview);
      if (!status.acceptingJobs || status.state === 'stopped' || !status.formats.includes(documentFormat)) throw new InputError('The queue is stopped, not accepting jobs or does not support PDF.', 409);
      await cups.validate(printer.mediaKey, `label-service ${client.name}`, documentFormat); this.assertPreview(preview);
      const claim = this.store.claimPrint({ id: input.requestId, tokenHash, documentHash: hash(preview.document), settingsRevision: preview.revision,
        serverUrl: preview.config.serverUrl, queue: printer.queue, printer: printer.id, mediaKey: printer.mediaKey, documentFormat, createdAt: new Date().toISOString(), state: 'submitting',
        client: client.name, kind: preview.kind, ...(preview.template ? { template: preview.template } : {}), ...(preview.reference ? { reference: preview.reference } : {}) });
      if (!claim.claimed) return claim.job;
      claimed = true; sent = true;
      const jobId = await cups.print(printer.mediaKey, `label-service ${client.name}`, preview.document, documentFormat);
      return this.store.updatePrint(input.requestId, { state: 'submitted', jobId });
    } catch (error) {
      if (claimed) {
        // A lost response may follow a successful physical submission. Never retry it.
        // Only a verified IPP error status proves that CUPS created no job.
        return this.store.updatePrint(input.requestId, { state: sent && !(error.ippStatus >= 0x400) ? 'unknown' : 'rejected' });
      }
      throw error;
    } finally { if (sent) this.lastPrint.set(printer.id, Date.now()); this.busy.delete(printer.id); }
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
