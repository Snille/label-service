import { labelMediaPresets, labelSizeKeys, labelOrientations, printerModels, mediaForModel } from './label-media.js';

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function object(value, name = 'payload') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(`${name} must be an object.`);
  return value;
}

export function text(value, name, { optional = false, empty = false } = {}) {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > 100000) {
    throw new InputError(`${name} must be ${empty ? 'a' : 'a non-empty'} string (maximum 100000 characters).`);
  }
}

export const clientName = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const printerId = /^[a-z0-9][a-z0-9-]{0,39}$/;
const queueName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;

function serverUrl(value) {
  text(value, 'serverUrl', { empty: true });
  if (value.length > 1000) throw new InputError('CUPS server URL is too long.');
  if (!value) return;
  let url; try { url = new URL(value); } catch { throw new InputError('Enter a CUPS HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new InputError('Use a CUPS origin without paths or credentials.');
}

export function validatePrinter(printer, server) {
  object(printer, 'printer');
  if (Object.keys(printer).some(key => !['id', 'name', 'model', 'enabled', 'queue', 'mediaKey', 'styles', 'rollReader'].includes(key))) throw new InputError('Unsupported printer setting.');
  if (!printerId.test(printer.id || '')) throw new InputError('Printer ids are lower-case letters, digits and hyphens.');
  if (typeof printer.name !== 'string' || !printer.name.trim() || printer.name.length > 80) throw new InputError('Give each printer a name (at most 80 characters).');
  if (!printerModels.some(m => m.key === printer.model)) throw new InputError(`Choose a supported printer model (${printerModels.map(m => m.name).join(', ')}).`);
  if (typeof printer.enabled !== 'boolean' || !mediaForModel(printer.model).some(p => p.key === printer.mediaKey)) throw new InputError('Choose a label format that this printer model supports.');
  text(printer.queue, 'queue', { empty: !printer.enabled });
  if (printer.enabled && !server) throw new InputError('Save the CUPS server before enabling a printer.');
  if (printer.queue && !queueName.test(printer.queue)) throw new InputError('Invalid CUPS queue name.');
  object(printer.styles, 'styles');
  if (Object.keys(printer.styles).sort().join(',') !== labelMediaPresets.map(p => p.key).sort().join(',')) throw new InputError('Save text sizes for each label format.');
  for (const style of Object.values(printer.styles)) {
    object(style, 'style');
    if (Object.keys(style).sort().join(',') !== [...labelSizeKeys, 'orientation'].sort().join(',')
      || labelSizeKeys.some(key => !Number.isInteger(style[key]) || style[key] < 6 || style[key] > 16)) throw new InputError('Label font sizes must be 6-16 points.');
    if (!labelOrientations.includes(style.orientation)) throw new InputError('Choose portrait or landscape label orientation.');
  }
  if (printer.rollReader !== undefined) {
    const r = object(printer.rollReader, 'rollReader');
    if (Object.keys(r).sort().join(',') !== 'enabled,host,port' || typeof r.enabled !== 'boolean' || typeof r.host !== 'string'
      || r.host.length > 253 || (r.host && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(r.host)) || (r.enabled && !r.host)
      || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535) throw new InputError('Use a roll-reader hostname or IPv4 address and a valid TCP port.');
    if (r.enabled && !printerModels.find(m => m.key === printer.model).rollReader) throw new InputError('This printer model cannot report its loaded roll.');
  }
  return printer;
}

// Settings: one CUPS server and one or more printers, each with its own queue, loaded roll and text styles.
export function validatePrinting(config) {
  object(config, 'printing');
  if (Object.keys(config).some(key => !['serverUrl', 'defaultPrinter', 'printers', 'batchLimit'].includes(key))) throw new InputError('Unsupported printing setting.');
  serverUrl(config.serverUrl);
  if (!Array.isArray(config.printers) || config.printers.length < 1 || config.printers.length > 20) throw new InputError('Configure 1-20 printers.');
  for (const printer of config.printers) validatePrinter(printer, config.serverUrl);
  if (new Set(config.printers.map(p => p.id)).size !== config.printers.length || new Set(config.printers.filter(p => p.queue).map(p => p.queue)).size !== config.printers.filter(p => p.queue).length) {
    throw new InputError('Printer ids and CUPS queues must be unique.');
  }
  if (!config.printers.some(p => p.id === config.defaultPrinter)) throw new InputError('Choose a default printer.');
  if (!Number.isInteger(config.batchLimit) || config.batchLimit < 1 || config.batchLimit > 500) throw new InputError('The batch limit is 1-500 labels.');
  return config;
}

export function validatePrintJob(record) {
  object(record, 'print job');
  if (!/^[a-f0-9-]{36}$/.test(record.id) || !/^[a-f0-9]{64}$/.test(record.tokenHash) || !/^[a-f0-9]{64}$/.test(record.documentHash)
    || !/^[a-f0-9]{64}$/.test(record.settingsRevision) || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
    || !['submitting', 'submitted', 'unknown', 'rejected'].includes(record.state)
    || (record.jobId !== undefined && (!Number.isInteger(record.jobId) || record.jobId < 1))
    || !clientName.test(record.client) || typeof record.kind !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(record.kind)
    || (record.template !== undefined && (typeof record.template?.id !== 'string' || !Number.isInteger(record.template.version)))
    || (record.printer !== undefined && !printerId.test(record.printer))
    || (record.documentFormat !== undefined && !['application/postscript', 'application/pdf'].includes(record.documentFormat))
    || (record.reference !== undefined && (typeof record.reference !== 'string' || record.reference.length > 200))) throw new InputError('Invalid print job record.');
  serverUrl(record.serverUrl);
  if (!queueName.test(record.queue || '') || !labelMediaPresets.some(p => p.key === record.mediaKey)) throw new InputError('Invalid print job record.');
  return record;
}
