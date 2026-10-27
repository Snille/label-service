// A small reader for zip archives, enough for a zipped font family: stored and deflated entries, read from the
// central directory. Sizes are capped before anything is inflated.
import { inflateRawSync } from 'node:zlib';
import { InputError } from './validation.js';

export const isZip = bytes => bytes.length > 22 && bytes.readUInt32LE(0) === 0x04034b50;

export function readZip(bytes, { maxEntries = 200, maxEntryBytes = 20 * 1024 * 1024, maxTotalBytes = 60 * 1024 * 1024, want = () => true } = {}) {
  const damaged = () => new InputError('The zip file is damaged.');
  // The end of central directory record is in the last 64 KB (after an optional comment).
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) if (bytes.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  if (end < 0) throw damaged();
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (count > maxEntries) throw new InputError(`The zip file holds more than ${maxEntries} files.`, 413);
  if (start + size > bytes.length) throw damaged();
  const entries = []; let total = 0;
  for (let at = start, i = 0; i < count; i++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) throw damaged();
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), packed = bytes.readUInt32LE(at + 20), unpacked = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32), local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1');
    at += 46 + nameLength + extra + comment;
    if (name.endsWith('/') || !want(name)) continue;
    if (flags & 1) throw new InputError(`${name} is encrypted. Upload a zip file without a password.`, 415);
    if (![0, 8].includes(method)) throw new InputError(`${name} is packed in a way this reader does not know. Zip it again or upload the font itself.`, 415);
    if (unpacked > maxEntryBytes || (total += unpacked) > maxTotalBytes) throw new InputError('The files in the zip file are too large.', 413);
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw damaged();
    const from = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (from + packed > bytes.length) throw damaged();
    const raw = bytes.subarray(from, from + packed);
    let data;
    try { data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: maxEntryBytes }); } catch { throw damaged(); }
    if (data.length !== unpacked) throw damaged();
    entries.push({ name, data });
  }
  return entries;
}
