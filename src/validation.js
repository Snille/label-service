import { labelMediaPresets, labelSizeKeys, labelOrientations, defaultLabelStyles } from './label-media.js';

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

export function validatePrinting(config) {
  object(config, 'printing');
  if (Object.keys(config).some(key => !['enabled', 'serverUrl', 'queue', 'mediaKey', 'styles', 'rollReader'].includes(key))) throw new InputError('Unsupported printing setting.');
  if (typeof config.enabled !== 'boolean' || !labelMediaPresets.some(p => p.key === config.mediaKey)) throw new InputError('Choose a supported label format.');
  for (const key of ['serverUrl', 'queue']) text(config[key], key, { empty: !config.enabled });
  if (config.serverUrl.length > 1000) throw new InputError('CUPS server URL is too long.');
  if (config.serverUrl) {
    let url; try { url = new URL(config.serverUrl); } catch { throw new InputError('Enter a CUPS HTTP(S) origin.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new InputError('Use a CUPS origin without paths or credentials.');
  }
  if (config.queue && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(config.queue)) throw new InputError('Invalid CUPS queue name.');
  object(config.styles, 'styles');
  if (Object.keys(config.styles).sort().join(',') !== labelMediaPresets.map(p => p.key).sort().join(',')) throw new InputError('Save text sizes for each label format.');
  for (const style of Object.values(config.styles)) {
    object(style, 'style');
    if (Object.keys(style).sort().join(',') !== [...labelSizeKeys, 'orientation'].sort().join(',')
      || labelSizeKeys.some(key => !Number.isInteger(style[key]) || style[key] < 6 || style[key] > 16)) throw new InputError('Label font sizes must be 6-16 points.');
    if (!labelOrientations.includes(style.orientation)) throw new InputError('Choose portrait or landscape label orientation.');
  }
  if (config.rollReader !== undefined) {
    const r = object(config.rollReader, 'rollReader');
    if (Object.keys(r).sort().join(',') !== 'enabled,host,port' || typeof r.enabled !== 'boolean' || typeof r.host !== 'string'
      || r.host.length > 253 || (r.host && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(r.host)) || (r.enabled && !r.host)
      || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535) throw new InputError('Use a roll-reader hostname or IPv4 address and a valid TCP port.');
  }
  return config;
}

export function validatePrintJob(record) {
  object(record, 'print job');
  if (!/^[a-f0-9-]{36}$/.test(record.id) || !/^[a-f0-9]{64}$/.test(record.tokenHash) || !/^[a-f0-9]{64}$/.test(record.documentHash)
    || !/^[a-f0-9]{64}$/.test(record.settingsRevision) || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
    || !['submitting', 'submitted', 'unknown', 'rejected'].includes(record.state)
    || (record.jobId !== undefined && (!Number.isInteger(record.jobId) || record.jobId < 1))
    || !clientName.test(record.client) || !['box', 'location'].includes(record.kind)
    || (record.reference !== undefined && (typeof record.reference !== 'string' || record.reference.length > 200))) throw new InputError('Invalid print job record.');
  validatePrinting({ enabled: true, serverUrl: record.serverUrl, queue: record.queue, mediaKey: record.mediaKey, styles: defaultLabelStyles() });
  return record;
}
