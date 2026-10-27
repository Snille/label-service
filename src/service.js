import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';
import { InputError, object, validatePrinting, validateMargins } from './validation.js';
import { CupsPrinter } from './ipp.js';
import { defaultLabelStyles, labelTemplates, layoutTemplate, testLabel, testLines } from './labels.js';
import { printerModels, printerModel, mediaForModel, allMedia, customMediaKey } from './label-media.js';
import { builtInTemplates, validateTemplate, templateId, assetId, calibrationTemplate } from './template.js';
import { decodePng, isPng, encodeRgba } from './png.js';
import { isPdf, pdfPage } from './pdf.js';
import { fontFamilies } from './fonts.js';
import { readDymoRoll } from './dymo-roll.js';
import { layoutSvg, pageSvg } from './svg.js';
import { rsvgConvert } from './convert.js';

const hash = input => createHash('sha256').update(input).digest('hex');
export const revisionOf = config => hash(JSON.stringify(config));
const maxPictureBytes = 2 * 1024 * 1024;
// The pixel size of a baseline or progressive JPEG, from its first start-of-frame marker.
function jpegSize(bytes) {
  for (let at = 2; at + 9 < bytes.length;) {
    if (bytes[at] !== 0xff) break;
    const marker = bytes[at + 1], length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    at += 2 + length;
  }
  throw new InputError('The JPEG picture is damaged.');
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const documentFormat = 'application/pdf';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Callers are identified by name; designers create and publish templates, drafters (LLM tools) only save drafts.
const who = client => typeof client === 'string' ? { name: client, role: client === 'admin' ? 'designer' : 'client' } : client;
const canDraft = client => ['designer', 'drafter'].includes(client.role);
const wasPublished = record => record.status === 'published' || Boolean(record.publishedAt);
// Templates may name only approved rolls; a roll that is still testing prints nothing but its test print.
const approvedMedia = config => allMedia(config).filter(p => p.status === 'approved');
const approval = roll => JSON.stringify([roll.status, roll.margins && [roll.margins.top, roll.margins.right, roll.margins.bottom, roll.margins.left], roll.test?.requestId, roll.test?.approvedAt, roll.test?.approvedBy]);
const sameRoll = (a, b) => approval(a) === approval(b);
const summary = record => ({ id: record.id, name: record.name, builtIn: false, version: record.version, status: record.status, media: record.definition.media,
  description: record.definition.description, fields: record.definition.fields, createdAt: record.createdAt, createdBy: record.createdBy });

// The single owner of the printers. Clients send label content; only this service renders, submits and reads the roll.
export class PrintService {
  // settleMs: a DYMO printer still feeds and cuts after CUPS reports a job completed, and its driver refuses the next job
  // (com.dymo.busy-error) if that job arrives too soon. Each printer therefore rests this long after its last job.
  constructor(store, { defaults = {}, printerFactory = config => new CupsPrinter(config), rollReader = readDymoRoll, converter = rsvgConvert, pdfReader = pdfPage, settleMs = 10000, queueWaitMs = 120000, queuesFile = '' } = {}) {
    this.store = store; this.defaults = defaults; this.queuesFile = queuesFile; this.printerFactory = printerFactory; this.rollReader = rollReader; this.converter = converter; this.pdfReader = pdfReader;
    this.settleMs = settleMs; this.queueWaitMs = queueWaitMs;
    this.previews = new Map(); this.pictures = new Map(); this.busy = new Set(); this.lastRollCheck = new Map(); this.lastPrint = new Map();
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
    return { serverUrl: d.serverUrl || '', defaultPrinter: id, batchLimit: 50, rolls: [], printers: [{
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
    const media = allMedia(config);
    return { config, revision: revisionOf(config), media: media.find(p => p.key === printer.mediaKey), mediaPresets: media,
      models: printerModels.map(m => ({ ...m, media: mediaForModel(m.key, media).map(p => p.key) })), kinds: builtInTemplates.map(t => t.id), fonts: fontFamilies,
      queuesFile: Boolean(this.queuesFile) };
  }
  formats(id) {
    const config = this.config(), printer = this.printerConfig(config, id);
    // Clients see the approved rolls; the loaded roll is named even while it is testing, so they can say why nothing prints.
    return { printer: { id: printer.id, name: printer.name, model: printer.model }, mediaKey: printer.mediaKey, media: allMedia(config).find(p => p.key === printer.mediaKey),
      style: printer.styles[printer.mediaKey], mediaPresets: mediaForModel(printer.model, approvedMedia(config)), kinds: builtInTemplates.map(t => t.id), fonts: fontFamilies, batchLimit: config.batchLimit,
      printers: config.printers.map(p => ({ id: p.id, name: p.name, model: p.model, enabled: p.enabled, mediaKey: p.mediaKey, default: p.id === config.defaultPrinter })) };
  }
  assertRevision(revision) { if (revision !== this.revision()) throw new InputError('Print settings changed. Create a new preview before printing.', 409); }
  save(input) {
    object(input);
    if (Object.keys(input).some(k => !['revision', 'config'].includes(k))) throw new InputError('Unsupported print setting.');
    return this.store.transaction(() => {
      this.assertRevision(input.revision);
      const before = this.config(), config = object(input.config, 'printing');
      // A new roll starts as testing; only an approved test print makes it approved (approveRoll). Its name and article may change.
      if (config.rolls !== undefined && !Array.isArray(config.rolls)) throw new InputError('rolls is a list.');
      for (const roll of config.rolls || []) {
        object(roll, 'roll');
        const key = customMediaKey(roll.widthMm, roll.heightMm), old = before.rolls.find(r => customMediaKey(r.widthMm, r.heightMm) === key);
        if (old ? !sameRoll(roll, old) : roll.status !== 'testing' || roll.margins !== undefined || roll.test !== undefined) {
          throw new InputError('A new roll starts as testing, and it is approved with its test print on the admin page.');
        }
      }
      // A removed roll must not be loaded in a printer (checked below) or named by a saved template.
      const kept = new Set(allMedia(config).map(p => p.key)), removed = allMedia(before).filter(p => p.custom && !kept.has(p.key)).map(p => p.key);
      const users = removed.length ? [...new Set(this.store.allTemplateVersions().filter(t => t.definition.media.some(k => removed.includes(k))).map(t => t.id))] : [];
      if (users.length) throw new InputError(`The roll is used by the templates ${users.join(', ')}. Change or delete those templates first.`, 409);
      // Each printer keeps text sizes for every roll: an added roll gets its defaults, a removed one is dropped.
      const media = allMedia(config);
      if (Array.isArray(config.printers)) for (const p of config.printers) {
        if (p && typeof p === 'object' && p.styles && typeof p.styles === 'object') p.styles = Object.fromEntries(media.map(m => [m.key, p.styles[m.key] || { ...m.style }]));
      }
      validatePrinting(config);
      if (config.printers.some(p => p.device) && !this.queuesFile) throw new InputError('This service cannot create CUPS queues. Set LABEL_QUEUES_FILE and share its folder with the cups container.', 409);
      this.store.writePrinting(config); this.writeQueues(config);
      return this.view();
    });
  }
  // Approves a roll's test print (decision B12): the request id of a test print of that roll that reached CUPS, and the
  // margins read from the paper. Approving again with a new test print measures the roll anew.
  approveRoll(input, client) {
    client = who(client); object(input);
    if (Object.keys(input).some(k => !['revision', 'key', 'requestId', 'margins'].includes(k))) throw new InputError('Send { revision, key, requestId, margins }.');
    return this.store.transaction(() => {
      this.assertRevision(input.revision);
      const config = structuredClone(this.config()), roll = config.rolls.find(r => customMediaKey(r.widthMm, r.heightMm) === input.key);
      if (!roll) throw new InputError('Only a roll added on the admin page is approved here.', 404);
      const job = typeof input.requestId === 'string' ? this.store.printJob(input.requestId) : null;
      if (!job || job.kind !== 'calibration' || job.mediaKey !== input.key) throw new InputError('Print the test label of this roll first, then approve that print.', 409);
      if (job.state !== 'submitted') throw new InputError(`The test print is ${job.state}; it did not reach the printer. Print it again.`, 409);
      Object.assign(roll, { status: 'approved', margins: validateMargins(structuredClone(input.margins)), test: { requestId: job.id, approvedAt: new Date().toISOString(), approvedBy: client.name } });
      this.store.writePrinting(validatePrinting(config));
      return this.view();
    });
  }
  // The CUPS queues of printers added on the admin page, one line each ("queue model device"), written whole for the cups
  // container, which creates, changes and removes those queues. The first printer's queue comes from the environment.
  writeQueues(config = this.config()) {
    if (!this.queuesFile) return;
    const lines = config.printers.filter(p => p.device).map(p => `${p.queue} ${p.model} ${p.device}\n`).join('');
    writeFileSync(`${this.queuesFile}.tmp`, `# Written by label-service from the printers on its admin page.\n${lines}`);
    renameSync(`${this.queuesFile}.tmp`, this.queuesFile);
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
      // The roll reader knows the built-in formats; added rolls are found by their article number too.
      roll.media = allMedia(config).find(p => p.sku === roll.sku) || null; roll.sizeSource = roll.media ? 'sku-preset' : 'unknown';
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
    const definition = validateTemplate(structuredClone(input.definition), approvedMedia(this.config()));
    return this.store.addTemplateVersion({ id: definition.id, status: 'draft', name: definition.name, definition, createdAt: new Date().toISOString(), createdBy: client.name });
  }
  setTemplateStatus(id, version, status, client) {
    client = who(client);
    if (client.role !== 'designer') throw new InputError('Publishing and archiving require a designer key.', 403);
    if (!this.store.template(id, version)) throw new InputError('Template version not found.', 404);
    return this.store.updateTemplateVersion(id, version, status === 'published'
      ? { status, publishedAt: new Date().toISOString(), publishedBy: client.name } : { status, archivedAt: new Date().toISOString(), archivedBy: client.name });
  }
  // Pictures: PNG is kept as uploaded; JPEG and SVG are turned into PNG by rsvg-convert (an SVG is drawn 1600 pixels
  // wide, since it has no pixels of its own); one page of a PDF (page, 1 by default) is drawn by poppler at up to
  // 300 dpi. crop {x, y, w, h}, shares of the picture from 0 to 1, keeps only that part. Every picture is decoded once
  // to check it.
  async uploadAsset(input, client) {
    client = who(client); object(input);
    if (!canDraft(client)) throw new InputError('Uploading pictures requires a designer key.', 403);
    if (Object.keys(input).some(k => !['name', 'data', 'page', 'crop'].includes(k)) || typeof input.data !== 'string') throw new InputError('Send { name, data, page?, crop? } with the picture as base64.');
    if (input.page !== undefined && !(Number.isInteger(input.page) && input.page >= 1 && input.page <= 9999)) throw new InputError('page is a page number, 1 for the first.');
    const crop = input.crop;
    if (crop !== undefined && (object(crop, 'crop'), Object.keys(crop).some(k => !['x', 'y', 'w', 'h'].includes(k))
      || !['x', 'y', 'w', 'h'].every(k => typeof crop[k] === 'number' && crop[k] >= 0 && crop[k] <= 1) || crop.w <= 0 || crop.h <= 0 || crop.x + crop.w > 1.0001 || crop.y + crop.h > 1.0001)) {
      throw new InputError('crop is { x, y, w, h }, shares of the picture from 0 to 1.');
    }
    const name = String(input.name ?? 'picture').trim().slice(0, 120) || 'picture', bytes = Buffer.from(input.data, 'base64');
    if (!bytes.length) throw new InputError('The picture is empty.');
    if (bytes.length > maxPictureBytes) throw new InputError('The picture is larger than 2 MB. Make it smaller first.', 413);
    let type, png, pdf;
    if (input.page !== undefined && !isPdf(bytes)) throw new InputError('page is only for a PDF.');
    if (isPng(bytes)) { type = 'png'; png = bytes; }
    else if (isPdf(bytes)) { type = 'pdf'; pdf = await this.pdfReader(bytes, input.page || 1); png = pdf.png; }
    else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      type = 'jpeg'; const size = jpegSize(bytes);
      png = await this.converter(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size.width}" height="${size.height}"><image width="${size.width}" height="${size.height}" xlink:href="data:image/jpeg;base64,${bytes.toString('base64')}"/></svg>`, 'png', { dpi: 96, background: false });
    } else if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(bytes.toString('utf8', 0, 4096))) {
      type = 'svg'; png = await this.converter(bytes.toString('utf8'), 'png', { dpi: 96, width: 1600, background: false });
    } else throw new InputError('Upload a PNG, JPEG or SVG picture, or a PDF.', 415);
    let picture = decodePng(png);
    if (picture.width > 6000 || picture.height > 6000) throw new InputError('The picture is larger than 6000 pixels on a side. Make it smaller first.', 413);
    if (crop) {
      const x = Math.floor(crop.x * picture.width), y = Math.floor(crop.y * picture.height);
      const w = Math.max(1, Math.min(picture.width - x, Math.round(crop.w * picture.width))), h = Math.max(1, Math.min(picture.height - y, Math.round(crop.h * picture.height)));
      const rgba = Buffer.alloc(w * h * 4);
      for (let row = 0; row < h; row++) picture.rgba.copy(rgba, row * w * 4, ((y + row) * picture.width + x) * 4, ((y + row) * picture.width + x + w) * 4);
      picture = { width: w, height: h, rgba }; png = encodeRgba(w, h, rgba);
    }
    const record = { id: randomBytes(6).toString('hex'), name, type, width: picture.width, height: picture.height, bytes: png.length, createdAt: new Date().toISOString(), createdBy: client.name,
      ...(pdf ? { page: pdf.page, pages: pdf.pages } : {}), ...(crop ? { cropped: true } : {}) };
    this.pictures.set(record.id, picture);
    return this.store.addAsset(record, png);
  }
  assets(client) {
    if (!canDraft(who(client))) throw new InputError('This operation requires a designer key.', 403);
    return { assets: this.store.assets() };
  }
  assetContent(id, client) {
    if (!canDraft(who(client))) throw new InputError('This operation requires a designer key.', 403);
    const png = assetId.test(id) ? this.store.assetPng(id) : null;
    if (!png) throw new InputError('Picture not found.', 404);
    return png;
  }
  // A picture that a saved template uses (any version, any status) stays, so no template loses its picture.
  deleteAsset(id, client) {
    client = who(client);
    if (client.role !== 'designer') throw new InputError('Deleting pictures requires a designer key.', 403);
    return this.store.transaction(() => {
      if (!assetId.test(id) || !this.store.asset(id)) throw new InputError('Picture not found.', 404);
      const users = [...new Set(this.store.allTemplateVersions().filter(t => t.definition.objects.some(o => o.type === 'image' && o.asset === id)).map(t => t.id))];
      if (users.length) throw new InputError(`The picture is used by ${users.join(', ')}. Remove it from those templates first.`, 409);
      this.pictures.delete(id);
      return { id, deleted: this.store.deleteAsset(id) };
    });
  }
  // Decoded pictures for the layout, kept for the most recent ones.
  picture(id) {
    if (this.pictures.has(id)) return this.pictures.get(id);
    const png = assetId.test(id) ? this.store.assetPng(id) : null; if (!png) return null;
    const picture = decodePng(png); this.pictures.set(id, picture);
    if (this.pictures.size > 20) this.pictures.delete(this.pictures.keys().next().value);
    return picture;
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
      return { definition: validateTemplate(structuredClone(input.template), approvedMedia(this.config())), ref: { id: input.template.id, version: 0, status: 'unsaved' } };
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
    if (Object.keys(input).some(k => !['kind', 'template', 'version', 'test', 'check', 'fields', 'rows', 'mediaKey', 'orientation', 'reference', 'printer', 'include'].includes(k))
      || (input.test !== undefined && typeof input.test !== 'boolean') || (input.check !== undefined && typeof input.check !== 'boolean')
      || (input.orientation !== undefined && !['portrait', 'landscape'].includes(input.orientation))
      || (input.include !== undefined && (!Array.isArray(input.include) || input.include.some(i => i !== 'png')))) {
      throw new InputError('Unsupported label preview request.');
    }
    if (input.reference !== undefined && (typeof input.reference !== 'string' || !input.reference.trim() || input.reference.length > 200)) throw new InputError('reference must be a short string.');
    const config = this.config(), revision = revisionOf(config), printer = this.printerConfig(config, input.printer);
    const media = allMedia(config).find(p => p.key === printer.mediaKey);
    if (!media) throw new InputError(`${printer.name} has a roll that is no longer known. Choose its loaded roll on the admin page.`, 409);
    // A client may state the format it expects; the loaded roll decides, so a mismatch is refused rather than printed on the wrong labels.
    if (input.mediaKey !== undefined && input.mediaKey !== printer.mediaKey) throw new InputError(`The selected label format is ${media.name}. Change the roll and format first.`, 409);
    // A batch: rows of field values become one print document with one label per row, sent as one job (decision B8 as
    // changed on 2026-10-27), because the DYMO driver needs a pause between jobs but prints the pages of one job in one run.
    let rows;
    if (input.rows !== undefined) {
      if (input.fields !== undefined || input.test !== undefined || input.check !== undefined || input.include !== undefined || !Array.isArray(input.rows)) {
        throw new InputError('A batch preview takes rows of fields, without fields, test, check or include.');
      }
      if (!input.rows.length || input.rows.length > config.batchLimit) throw new InputError(`A batch holds 1-${config.batchLimit} labels.`);
      rows = input.rows.map((row, index) => object(row, `rows[${index}]`));
    }
    // The test print of a roll is drawn for the loaded roll, edge to edge, and only the admin prints it. Nothing else
    // prints on a roll that is still testing.
    const calibration = input.kind === 'calibration';
    if (calibration && (client.name !== 'admin' || rows || input.fields !== undefined)) throw new InputError('Only the admin prints the test label of a roll, from the admin page.', 403);
    if (!calibration && media.status !== 'approved') throw new InputError(`The roll ${media.name} is new and not approved yet. Print and approve its test label on the admin page first.`, 409);
    const { definition, ref, builtIn } = calibration
      ? { definition: calibrationTemplate(media), ref: { id: 'calibration', version: 1, status: 'published' }, builtIn: true } : this.resolve(input, client);
    if (!definition.media.includes('*') && !definition.media.includes(printer.mediaKey)) throw new InputError(`The template "${definition.name}" is not made for ${media.name}. Load a matching roll first.`, 409);
    let fields;
    if (input.test === true) {
      if (input.fields) throw new InputError('Test labels use fixed sample text.');
      fields = this.sampleFields(definition, media);
    } else if (!rows) fields = object(input.fields, 'fields');
    // A client may choose the text direction for this label; otherwise the template's or the format's saved direction applies.
    const style = printer.styles[printer.mediaKey];
    // The test print measures the edges, so it ignores margins measured before and keeps the roll's natural direction.
    const lay = values => layoutTemplate(definition, values, calibration ? { media: { ...media, margins: undefined }, style, orientation: definition.orientation }
      : { media, style, orientation: input.orientation, picture: id => this.picture(id) });
    const layouts = rows ? rows.map((row, index) => {
      try { return lay(row); } catch (error) { if (error instanceof InputError) error.message = `Row ${index + 1}: ${error.message}`; throw error; }
    }) : [lay(fields)];
    const layout = layouts[0];
    // Pictures and codes print in the driver's graphics quality; a template may ask for a lighter or darker print.
    const driver = { DymoPrintQuality: layout.items.some(i => i.type === 'image' || i.type === 'barcode') ? 'Graphics' : 'Text',
      ...(definition.printDensity ? { DymoPrintDensity: definition.printDensity[0].toUpperCase() + definition.printDensity.slice(1) } : {}) };
    // Built-in and published templates print for every client; drafts and unsaved designs only from a designer key.
    const allowed = builtIn || ref.status === 'published' || client.role === 'designer';
    const denied = allowed ? [] : [{ object: 'template', message: 'Only published templates can be printed with this key. Publish the template first.' }];
    const kind = builtIn ? ref.id : 'template', template = builtIn ? undefined : { id: ref.id, version: ref.version };
    const head = { kind, ...(template ? { template: { ...template, status: ref.status } } : {}), printer: printer.id };
    let answer, document = null;
    if (rows) {
      // Warnings name the row (1 is the first row sent); one row that does not fit stops the whole batch.
      const problems = [...layouts.flatMap((l, index) => l.problems.map(p => ({ row: index + 1, ...p }))), ...denied];
      const printable = problems.length === 0;
      answer = { ...head, labels: rows.length, driver, printable, warnings: problems };
      if (printable) document = await this.converter(layouts.map(pageSvg), 'pdf');
    } else {
      const problems = [...layout.problems, ...denied];
      const printable = problems.length === 0, svg = layoutSvg(layout);
      const png = input.include?.includes('png') ? (await this.converter(svg, 'png')).toString('base64') : undefined;
      answer = { ...head, fields, layout, driver, svg, ...(png ? { png } : {}), printable, warnings: problems };
      // A check answers whether the label fits without a print document or a token, so a batch can check every row first
      // without filling the preview store.
      if (input.check === true) return { check: true, ...answer };
      if (printable) document = await this.converter(pageSvg(layout), 'pdf');
    }
    const token = randomUUID(), now = Date.now();
    for (const [id, p] of this.previews) if (p.expires <= now) this.previews.delete(id);
    if (this.previews.size >= 100) throw new InputError('Too many label previews. Wait for an older preview to expire.', 429);
    const expires = now + 10 * 60 * 1000;
    this.previews.set(token, { config, revision, printer: printer.id, kind, template, client: client.name, reference: input.reference, layout, driver,
      printable: answer.printable, document, labels: rows?.length || 1, expires });
    return { token, expiresAt: new Date(expires).toISOString(), ...answer };
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
      await cups.validate(printer.mediaKey, `label-service ${client.name}`, documentFormat, preview.driver); this.assertPreview(preview);
      const claim = this.store.claimPrint({ id: input.requestId, tokenHash, documentHash: hash(preview.document), settingsRevision: preview.revision,
        serverUrl: preview.config.serverUrl, queue: printer.queue, printer: printer.id, mediaKey: printer.mediaKey, documentFormat, createdAt: new Date().toISOString(), state: 'submitting',
        client: client.name, kind: preview.kind, ...(preview.template ? { template: preview.template } : {}), ...(preview.reference ? { reference: preview.reference } : {}),
        ...(preview.labels > 1 ? { labels: preview.labels } : {}) });
      if (!claim.claimed) return claim.job;
      claimed = true; sent = true;
      const jobId = await cups.print(printer.mediaKey, `label-service ${client.name}`, preview.document, documentFormat, preview.driver);
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
