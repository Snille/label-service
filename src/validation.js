import { labelMediaPresets, labelSizeKeys, labelOrientations, printerModels, mediaForModel, allMedia, rollArticle } from './label-media.js';

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

// A printer's device is the address CUPS sends its jobs to: socket://host[:port] on the LAN or a usb:// URI. Only
// printers added on the admin page have one; the first printer's queue comes from the environment.
export const deviceUri = /^(socket:\/\/[A-Za-z0-9][A-Za-z0-9.-]{0,252}(:\d{1,5})?|usb:\/\/[A-Za-z0-9%/?=&._-]{1,300})$/;

export function validatePrinter(printer, server, media = labelMediaPresets) {
  object(printer, 'printer');
  if (Object.keys(printer).some(key => !['id', 'name', 'model', 'enabled', 'queue', 'device', 'mediaKey', 'styles', 'rollReader'].includes(key))) throw new InputError('Unsupported printer setting.');
  if (!printerId.test(printer.id || '')) throw new InputError('Printer ids are lower-case letters, digits and hyphens.');
  if (typeof printer.name !== 'string' || !printer.name.trim() || printer.name.length > 80) throw new InputError('Give each printer a name (at most 80 characters).');
  if (!printerModels.some(m => m.key === printer.model)) throw new InputError(`Choose a supported printer model (${printerModels.map(m => m.name).join(', ')}).`);
  if (typeof printer.enabled !== 'boolean' || !mediaForModel(printer.model, media).some(p => p.key === printer.mediaKey)) throw new InputError('Choose a label format that this printer model supports.');
  text(printer.queue, 'queue', { empty: !printer.enabled && printer.device === undefined });
  if (printer.enabled && !server) throw new InputError('Save the CUPS server before enabling a printer.');
  if (printer.queue && !queueName.test(printer.queue)) throw new InputError('Invalid CUPS queue name.');
  if (printer.device !== undefined && (typeof printer.device !== 'string' || !deviceUri.test(printer.device) || (printer.device.startsWith('socket:') && Number(printer.device.split(':')[2] || 9100) > 65535))) {
    throw new InputError(`Give ${printer.name} a network address (socket://host:9100) or a usb:// address.`);
  }
  object(printer.styles, 'styles');
  if (Object.keys(printer.styles).sort().join(',') !== media.map(p => p.key).sort().join(',')) throw new InputError('Save text sizes for each label format.');
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

const tenths = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && Math.abs(value * 10 - Math.round(value * 10)) < 1e-9;
export const marginSides = ['top', 'right', 'bottom', 'left'];
export function validateMargins(margins) {
  object(margins, 'margins');
  if (Object.keys(margins).sort().join(',') !== [...marginSides].sort().join(',') || marginSides.some(side => !tenths(margins[side], 0, 10))) {
    throw new InputError('Margins are top, right, bottom and left: 0-10 mm in steps of 0.1 mm.');
  }
  return margins;
}
// A roll added on the admin page. It is "testing" until its test print is approved; then it has the measured margins
// and the request id of that test print.
export function validateRoll(roll) {
  object(roll, 'roll');
  if (Object.keys(roll).some(key => !['sku', 'name', 'widthMm', 'heightMm', 'status', 'margins', 'test'].includes(key))) throw new InputError('Unsupported roll setting.');
  if (typeof roll.sku !== 'string' || !rollArticle.test(roll.sku)) throw new InputError('A roll needs its article number as the roll reports it: S and seven digits (S0722540) or seven digits.');
  if (roll.name !== undefined && (typeof roll.name !== 'string' || !roll.name.trim() || roll.name.length > 60)) throw new InputError('A roll name is at most 60 characters.');
  if (!tenths(roll.widthMm, 10, 110) || !tenths(roll.heightMm, 10, 400)) throw new InputError('A roll is 10-110 mm wide (across the print head) and 10-400 mm long, in steps of 0.1 mm.');
  if (!['testing', 'approved'].includes(roll.status)) throw new InputError('A roll is testing or approved.');
  if (roll.status === 'approved') {
    validateMargins(roll.margins);
    const t = object(roll.test, 'test');
    if (Object.keys(t).sort().join(',') !== 'approvedAt,approvedBy,requestId' || !/^[a-f0-9-]{36}$/.test(t.requestId) || !Number.isFinite(Date.parse(t.approvedAt)) || !clientName.test(t.approvedBy)) {
      throw new InputError('An approved roll names its test print.');
    }
  } else if (roll.margins !== undefined || roll.test !== undefined) throw new InputError('A roll gets margins when its test print is approved.');
  return roll;
}

// Settings: one CUPS server, the rolls added on the admin page and one or more printers, each with its own queue,
// loaded roll and text styles.
export function validatePrinting(config) {
  object(config, 'printing');
  if (Object.keys(config).some(key => !['serverUrl', 'defaultPrinter', 'printers', 'batchLimit', 'rolls'].includes(key))) throw new InputError('Unsupported printing setting.');
  serverUrl(config.serverUrl);
  if (config.rolls !== undefined) {
    if (!Array.isArray(config.rolls) || config.rolls.length > 50) throw new InputError('At most 50 added rolls.');
    config.rolls.forEach(validateRoll);
  }
  const media = allMedia(config);
  if (new Set(media.map(p => p.key)).size !== media.length) throw new InputError('Two rolls have the same size. Each size is one roll.');
  if (new Set(media.map(p => p.sku)).size !== media.length) throw new InputError('Two rolls have the same article number.');
  if (!Array.isArray(config.printers) || config.printers.length < 1 || config.printers.length > 20) throw new InputError('Configure 1-20 printers.');
  for (const printer of config.printers) validatePrinter(printer, config.serverUrl, media);
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
    || (record.reference !== undefined && (typeof record.reference !== 'string' || record.reference.length > 200))
    || (record.labels !== undefined && (!Number.isInteger(record.labels) || record.labels < 2 || record.labels > 500))) throw new InputError('Invalid print job record.');
  serverUrl(record.serverUrl);
  // The roll of an old job may have been removed since, so the key is checked by its form only.
  if (!queueName.test(record.queue || '') || !/^[a-zA-Z0-9_.]{3,80}$/.test(record.mediaKey || '')) throw new InputError('Invalid print job record.');
  return record;
}
