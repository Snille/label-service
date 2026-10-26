// Bounded IPP/1.1 subset: RFC 8010 encoding, RFC 8011 printer/job operations.
import { InputError } from './validation.js';
let nextId = 1;
// Print quality and density from the DYMO PPDs (lw5xl.ppd and the other LabelWriter PPDs use the same names).
export const driverOptions = { DymoPrintQuality: ['Text', 'Graphics'], DymoPrintDensity: ['Light', 'Medium', 'Normal', 'Dark'] };
export const ippTags ={ integer: 0x21, boolean: 0x22, enum: 0x23, text: 0x41, name: 0x42, keyword: 0x44, uri: 0x45, charset: 0x47, language: 0x48, mime: 0x49 };
export const ippAttribute = (name, tag, value) => ({ name, tag, values: Array.isArray(value) ? value : [value] });
const integer = value => { const b = Buffer.alloc(4); b.writeInt32BE(value); return b; };

export function encodeIpp(code, id, groups, document = Buffer.alloc(0)) {
  const header = Buffer.alloc(8); header[0] = 1; header[1] = 1; header.writeUInt16BE(code, 2); header.writeInt32BE(id, 4);
  const parts = [header];
  for (const group of groups) {
    parts.push(Buffer.from([group.tag]));
    for (const a of group.attributes) for (const [index, value] of a.values.entries()) {
      const name = Buffer.from(index ? '' : a.name, 'utf8');
      const data = [0x21, 0x23].includes(a.tag) ? integer(value) : a.tag === 0x22 ? Buffer.from([value ? 1 : 0]) : Buffer.from(String(value), 'utf8');
      if (name.length > 255 || data.length > 65535) throw new InputError('IPP attribute exceeds the limit.');
      const field = Buffer.alloc(5 + name.length); field[0] = a.tag; field.writeUInt16BE(name.length, 1); name.copy(field, 3); field.writeUInt16BE(data.length, 3 + name.length);
      parts.push(field, data);
    }
  }
  return Buffer.concat([...parts, Buffer.from([3]), document]);
}

export function decodeIpp(bytes, expectedId) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 9 || bytes.length > 1024 * 1024 || ![1, 2].includes(bytes[0])
    || bytes.readInt32BE(4) !== expectedId) throw new InputError('Invalid IPP response.', 502);
  const result = { status: bytes.readUInt16BE(2), groups: [] }; let offset = 8, group, previous;
  while (offset < bytes.length) {
    const tag = bytes[offset++];
    if (tag === 3) { if (offset !== bytes.length) throw new InputError('Unexpected IPP document data.', 502); return result; }
    if (tag < 0x10) {
      if (![1, 2, 4, 5, 6, 7, 8, 9].includes(tag)) throw new InputError('Invalid IPP group.', 502);
      group = { tag, attributes: [] }; result.groups.push(group); previous = null; continue;
    }
    if (!group || offset + 2 > bytes.length) throw new InputError('Truncated IPP response.', 502);
    const nameLength = bytes.readUInt16BE(offset); offset += 2;
    if (offset + nameLength + 2 > bytes.length) throw new InputError('Truncated IPP attribute.', 502);
    const name = bytes.subarray(offset, offset + nameLength).toString('utf8'); offset += nameLength;
    const length = bytes.readUInt16BE(offset); offset += 2;
    if (offset + length > bytes.length) throw new InputError('Truncated IPP value.', 502);
    const data = bytes.subarray(offset, offset + length); offset += length;
    // The requested attributes are scalar; collections are intentionally unsupported.
    if ([0x34, 0x37, 0x4a].includes(tag)) throw new InputError('Unexpected IPP collection.', 502);
    let value;
    if ([0x21, 0x23].includes(tag)) { if (length !== 4) throw new InputError('Invalid IPP integer.', 502); value = data.readInt32BE(); }
    else if (tag === 0x22) { if (length !== 1 || data[0] > 1) throw new InputError('Invalid IPP boolean.', 502); value = Boolean(data[0]); }
    else value = data.toString('utf8');
    if (name) { previous = { name, tag, values: [] }; group.attributes.push(previous); }
    else if (!previous || previous.tag !== tag) throw new InputError('Invalid IPP continuation.', 502);
    previous.values.push(value);
  }
  throw new InputError('IPP response has no end marker.', 502);
}

export function ippValues(result, name, groupTag) {
  return result.groups.filter(g => groupTag === undefined || g.tag === groupTag).flatMap(g => g.attributes.filter(a => a.name === name).flatMap(a => a.values));
}

export class CupsPrinter {
  constructor({ serverUrl, queue }) {
    let url; try { url = new URL(serverUrl); } catch { throw new InputError('Enter a CUPS HTTP(S) origin.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || typeof queue !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(queue)) throw new InputError('Use a CUPS origin and a valid queue name.');
    this.serverUrl = url.origin; this.queue = queue; this.path = `/printers/${encodeURIComponent(queue)}`;
    this.uri = `${url.protocol === 'https:' ? 'ipps:' : 'ipp:'}//${url.host}${this.path}`;
  }
  async operation(code, attributes = [], jobAttributes = [], document) {
    const id = nextId; nextId = nextId >= 0x7fffffff ? 1 : nextId + 1;
    const groups = [{ tag: 1, attributes: [
      ippAttribute('attributes-charset', ippTags.charset, 'utf-8'), ippAttribute('attributes-natural-language', ippTags.language, 'en'),
      ippAttribute('printer-uri', ippTags.uri, this.uri), ippAttribute('requesting-user-name', ippTags.name, 'label-service'), ...attributes
    ] }];
    if (jobAttributes.length) groups.push({ tag: 2, attributes: jobAttributes });
    try {
      const response = await fetch(this.serverUrl + this.path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(document ? 30000 : 10000),
        headers: { 'content-type': 'application/ipp' }, body: encodeIpp(code, id, groups, document) });
      if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/ipp')) { await response.body?.cancel(); throw new Error(); }
      const parts = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 1024 * 1024) throw new Error(); parts.push(chunk); }
      const result = decodeIpp(Buffer.concat(parts), id);
      if (result.status !== 0) {
        const error = new InputError('CUPS rejected the request or substituted attributes. Check the queue, format and media.', 502);
        // A verified client/server error status (0x0400 and above) means CUPS created no job.
        error.ippStatus = result.status; throw error;
      }
      return result;
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError('CUPS could not return a verified response. Check the connection and job status before printing again.', 502);
    }
  }
  async status() {
    const result = await this.operation(0x000b, [ippAttribute('requested-attributes', ippTags.keyword,
      ['printer-state', 'printer-state-reasons', 'printer-is-accepting-jobs', 'queued-job-count', 'printer-make-and-model', 'document-format-supported', 'media-supported', 'media-default'])]);
    const one = name => ippValues(result, name, 4)[0];
    return { state: { 3: 'idle', 4: 'processing', 5: 'stopped' }[one('printer-state')] || 'unknown',
      acceptingJobs: one('printer-is-accepting-jobs') === true, queuedJobs: one('queued-job-count'), model: one('printer-make-and-model'),
      reasons: ippValues(result, 'printer-state-reasons', 4), formats: ippValues(result, 'document-format-supported', 4),
      media: ippValues(result, 'media-supported', 4), defaultMedia: one('media-default') };
  }
  // driver: DYMO PPD options passed to the filter as job attributes, such as { DymoPrintQuality: 'Graphics' }.
  // CUPS accepts any option name here, so only known ones are sent.
  options(media, name, format, driver = {}) {
    return { operation: [ippAttribute('job-name', ippTags.name, name), ippAttribute('ipp-attribute-fidelity', ippTags.boolean, true),
      ippAttribute('document-format', ippTags.mime, format)],
    job: [ippAttribute('copies', ippTags.integer, 1), ippAttribute('media', ippTags.keyword, media),
      ...Object.entries(driver).filter(([key, value]) => driverOptions[key]?.includes(value)).map(([key, value]) => ippAttribute(key, ippTags.keyword, value))] };
  }
  async validate(media, name, format = 'application/pdf', driver = {}) { const o = this.options(media, name, format, driver); await this.operation(0x0004, o.operation, o.job); }
  async print(media, name, document, format = 'application/pdf', driver = {}) {
    const o = this.options(media, name, format, driver); const result = await this.operation(0x0002, o.operation, o.job, document);
    const id = ippValues(result, 'job-id', 2)[0];
    if (!Number.isInteger(id) || id < 1) throw new InputError('CUPS did not return a valid job identifier. Check the queue before retrying.', 502);
    return id;
  }
  async job(id) {
    if (!Number.isInteger(id) || id < 1) throw new InputError('Invalid print job.');
    const result = await this.operation(0x0009, [ippAttribute('job-id', ippTags.integer, id),
      ippAttribute('requested-attributes', ippTags.keyword, ['job-id', 'job-state', 'job-state-reasons', 'job-media-sheets-completed'])]);
    const state = ippValues(result, 'job-state', 2)[0];
    return { jobId: id, state: { 3: 'pending', 4: 'held', 5: 'processing', 6: 'stopped', 7: 'canceled', 8: 'aborted', 9: 'completed' }[state] || 'unknown',
      reasons: ippValues(result, 'job-state-reasons', 2), sheetsCompleted: ippValues(result, 'job-media-sheets-completed', 2)[0] };
  }
}
