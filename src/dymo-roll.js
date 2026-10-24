import { createConnection } from 'node:net';
import { InputError } from './validation.js';
import { labelMediaPresets } from './labels.js';

const failure = message => new InputError(message || 'DYMO roll reading failed. Check the printer before trying again.', 502);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class Session {
  constructor(config, timeoutMs) {
    this.buffer = Buffer.alloc(0); this.waiter = null; this.error = null; this.timeoutMs = timeoutMs;
    this.socket = createConnection({ host: config.host, port: config.port });
    this.socket.on('error', () => this.fail(failure()));
    this.socket.on('end', () => this.fail(failure('DYMO closed the diagnostic connection before completion.')));
    this.socket.on('data', chunk => {
      if (this.buffer.length + chunk.length > 1024) return this.fail(failure('Unexpected DYMO response size.'));
      this.buffer = Buffer.concat([this.buffer, chunk]); this.flush();
    });
    this.lifetime = setTimeout(() => { this.fail(failure('DYMO diagnostic deadline exceeded.')); this.socket.destroy(); }, 20000);
  }
  fail(error) { this.error ||= error; if (this.waiter) { const w = this.waiter; this.waiter = null; clearTimeout(w.timer); w.reject(this.error); } }
  flush() {
    const w = this.waiter;
    if (w && this.buffer.length >= w.length) {
      this.waiter = null; clearTimeout(w.timer); const data = this.buffer.subarray(0, w.length); this.buffer = this.buffer.subarray(w.length); w.resolve(data);
    }
  }
  connected() {
    return new Promise((resolve, reject) => {
      if (this.error) return reject(this.error);
      const timer = setTimeout(() => finish(failure('DYMO connection timed out.')), this.timeoutMs);
      const finish = error => { clearTimeout(timer); this.socket.off('connect', ok); this.socket.off('error', bad); error ? reject(error) : resolve(); };
      const ok = () => finish(), bad = () => finish(failure());
      this.socket.once('connect', ok); this.socket.once('error', bad);
    });
  }
  write(bytes) {
    if (this.error || this.socket.destroyed) return Promise.reject(this.error || failure());
    return new Promise((resolve, reject) => this.socket.write(Buffer.from(bytes), error => error ? reject(failure()) : resolve()));
  }
  read(length) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(failure('DYMO response timed out. Lock ownership may be unknown; check the printer.')); }, this.timeoutMs);
      this.waiter = { resolve, reject, timer, length }; this.flush();
    });
  }
  async close(graceMs) {
    clearTimeout(this.lifetime);
    if (!this.socket.destroyed) { this.socket.end(); await delay(graceMs); this.socket.destroy(); }
    if (this.waiter) this.fail(failure());
  }
}

export function decodeRoll(status, sku) {
  if (!Buffer.isBuffer(status) || status.length !== 32 || status[0] !== 0 || status.readUInt32LE(1) !== 0) throw failure('No verified idle DYMO lock was granted.');
  if (status.readUInt32LE(23) !== 0) throw failure('DYMO reports a device error. Check the printer.');
  if (!Buffer.isBuffer(sku) || sku.length !== 64 || sku.readUInt16LE(0) !== 0xcab6 || sku[2] !== 0 || sku[3] !== 60) throw failure('Unrecognized DYMO consumable response.');
  const text = bytes => bytes.toString('ascii').replace(/\0+$/, '');
  const article = text(sku.subarray(8, 20));
  if (!/^S\d{7}$/.test(article) || text(status.subarray(11, 23)) !== article) throw failure('DYMO roll changed or consumable identifiers disagree. Read the roll again.');
  const head = ['ok', 'overheated', 'unknown'][status[8]] || 'unknown';
  const bay = ['unknown', 'open', 'no-media', 'misaligned', 'unknown-media', 'empty', 'critically-low', 'low', 'ok', 'jammed', 'unrecognized-media'][status[10] & 15] || 'unknown';
  if (head !== 'ok' || !['empty', 'critically-low', 'low', 'ok'].includes(bay)) throw failure('DYMO head or loaded roll is not in a supported state. Check the printer.');
  const media = labelMediaPresets.find(preset => preset.sku === article) || null;
  return { sku: article, labelsRemaining: status.readUInt16LE(27), head, bay, errorId: 0, media, sizeSource: media ? 'sku-preset' : 'unknown' };
}

export async function readDymoRoll(config, { timeoutMs = 2500, retryDelayMs = 3000, graceMs = 200 } = {}) {
  const session = new Session(config, timeoutMs); let owned = false, result, released = false;
  try {
    await session.connected();
    let status;
    for (let attempt = 0; attempt < 3; attempt++) {
      await session.write([0x1b, 0x41, 0x01]); status = await session.read(32);
      // Status 0-3 is returned to the granted host. An error with job ID zero
      // still owns this reservation and must release it before reporting failure.
      if ([0, 2].includes(status[0]) && status.readUInt32LE(1) === 0) {
        owned = true;
        if (status[0] === 2) throw failure((status[10] & 15) === 9
          ? 'DYMO reports a label jam. Check and reload the roll before trying again.'
          : 'DYMO reports a device error. Check the printer before trying again.');
        break;
      }
      // Wait only for the documented pre-lock reply; never interrupt an active job.
      if (status[0] !== 5 || status.readUInt32LE(1) !== 0) throw failure('DYMO is busy or lock ownership is unknown. No release command was sent.');
      if (attempt < 2) await delay(retryDelayMs);
    }
    if (!owned) throw failure('DYMO did not grant an idle lock. No release command was sent.');
    await session.write([0x1b, 0x55]); const sku = await session.read(64);
    result = decodeRoll(status, sku);
  } finally {
    try {
      // End only the interface lock this session has actually acquired. Never feed or reset.
      if (owned) { await session.write([0x1b, 0x51]); released = true; }
    } finally { await session.close(graceMs); }
  }
  return { ...result, releaseRequested: released, observedAt: new Date().toISOString() };
}
