import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { readDymoRoll, decodeRoll } from '../src/dymo-roll.js';
import { labelMediaPresets, labelLayout } from '../src/labels.js';
import { pageSvg } from '../src/svg.js';

function status(engine = 0) { const b = Buffer.alloc(32); b[0] = engine; b[10] = 8; b.write('S0722540', 11); b.writeUInt16LE(123, 27); return b; }
function sku() { const b = Buffer.alloc(64); b.writeUInt16LE(0xcab6); b[3] = 60; b.write('S0722540', 8); return b; }
async function fixture(t, options = {}) {
  let connections = 0, requests = 0; const commands = [], sockets = new Set();
  const server = createServer(socket => {
    connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 2) {
        const n = buffer[1] === 0x41 ? 3 : 2; if (buffer.length < n) break;
        const cmd = buffer.subarray(0, n); buffer = buffer.subarray(n); commands.push(cmd.toString('hex'));
        if (cmd[1] === 0x41) {
          requests++; const b = options.status ? options.status(requests) : status(requests === 1 ? 5 : 0);
          if (b) { socket.write(b.subarray(0, 4)); setImmediate(() => socket.write(b.subarray(4))); }
        } else if (cmd[1] === 0x55 && !options.timeout) socket.write(options.sku || sku());
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { config: { host: '127.0.0.1', port: server.address().port }, commands, connections: () => connections,
    settled: () => Promise.all([...sockets].map(socket => once(socket, 'close'))) };
}
const fast = { timeoutMs: 150, retryDelayMs: 1, graceMs: 1 };

test('roll reading waits for ownership and releases exactly its own lock on one connection', async t => {
  const f = await fixture(t), result = await readDymoRoll(f.config, fast);
  await f.settled();
  assert.deepEqual(f.commands, ['1b4101', '1b4101', '1b55', '1b51']); assert.equal(f.connections(), 1);
  assert.equal(result.labelsRemaining, 123); assert.equal(result.sku, 'S0722540'); assert.equal(result.media.key, 'w162h90'); assert.equal(result.sizeSource, 'sku-preset'); assert.equal(result.releaseRequested, true);
  assert.equal(result.raw.consumable, sku().toString('hex')); assert.equal(result.raw.status.length, 64);
  assert.equal(result.chip, null);
});
test('the chip gives the label size and the labels on a full roll', () => {
  // The answer of a real S0722520 (25 x 54 mm, 500 labels), read on the 5XL.
  const real = Buffer.from('b6ca003c0e8bf53e533037323235323000000000' + '00ff040101000000' + '6b021e004800000000001000' + '1c02fe0000000000' + '3701f401763c3200010000003903d207', 'hex');
  const s = status(); s.fill(0, 11, 23); s.write('S0722520', 11);
  assert.deepEqual(decodeRoll(s, real).chip, { widthMm: 25.4, lengthMm: 54, labelsPerRoll: 500 });
});
test('failed lock attempts and active jobs never receive an end-job command', async t => {
  for (const active of [false, true]) {
    const f = await fixture(t, { status() { const b = status(5); if (active) b.writeUInt32LE(42, 1); return b; } });
    await assert.rejects(readDymoRoll(f.config, fast), /lock|busy/); await f.settled(); assert.ok(!f.commands.includes('1b51')); assert.ok(!f.commands.includes('1b55')); assert.equal(f.commands.length, active ? 1 : 3);
  }
});
test('malformed or timed-out consumable reads release a verified acquired lock without feeding/resetting', async t => {
  for (const timeout of [false, true]) {
    const f = await fixture(t, { status: () => status(), sku: Buffer.alloc(64), timeout });
    await assert.rejects(readDymoRoll(f.config, fast), /consumable|timed out/);
    await f.settled();
    assert.deepEqual(f.commands, ['1b4101', '1b55', '1b51']);
  }
});
test('incomplete lock replies do not authorize ending an unknown job', async t => {
  const f = await fixture(t, { status: () => status().subarray(0, 16) });
  await assert.rejects(readDymoRoll(f.config, fast), /timed out/); await f.settled(); assert.deepEqual(f.commands, ['1b4101']);
});

test('an error reply with no active job releases its granted reservation without reading or feeding', async t => {
  for (const bay of [8, 9]) {
    const f = await fixture(t, { status(n) { const b = status(n === 1 ? 5 : 2); b[10] = bay; return b; } });
    await assert.rejects(readDymoRoll(f.config, fast), bay === 9 ? /label jam/ : /device error/);
    await f.settled(); assert.deepEqual(f.commands, ['1b4101', '1b4101', '1b51']);
  }
  const active = await fixture(t, { status() { const b = status(2); b.writeUInt32LE(42, 1); return b; } });
  await assert.rejects(readDymoRoll(active.config, fast), /busy|ownership/);
  await active.settled(); assert.deepEqual(active.commands, ['1b4101']);
});
test('roll decoder validates identity, placeholders and errors, and preserves a real zero count', () => {
  const b = status(), media = sku(); b.writeUInt16LE(0, 27); assert.equal(decodeRoll(b, media).labelsRemaining, 0);
  const changed = Buffer.from(media); changed.write('S0722550', 8); assert.throws(() => decodeRoll(b, changed), /disagree/);
  b.writeUInt32LE(4096, 23); assert.throws(() => decodeRoll(b, media), /device error/);
  assert.throws(() => decodeRoll(status(5), media), /idle/);
  const unknown = status(), unknownSku = sku(); unknown.write('S1234567', 11); unknownSku.write('S1234567', 8); assert.equal(decodeRoll(unknown, unknownSku).media, null);
  // Shipping labels report a seven-digit article without the S prefix.
  const shipping = status(), shippingSku = sku(); shipping.fill(0, 11, 23); shippingSku.fill(0, 8, 20); shipping.write('2166659', 11); shippingSku.write('2166659', 8);
  assert.equal(decodeRoll(shipping, shippingSku).media.key, 'custom_102x210mm_102x210mm');
  for (const bad of ['216665', 'X2166659', '21666590']) {
    const s = status(), k = sku(); s.fill(0, 11, 23); k.fill(0, 8, 20); s.write(bad, 11); k.write(bad, 8); assert.throws(() => decodeRoll(s, k), /disagree/);
  }
});
test('all explicit label formats generate their own dimensions and retain overflow guards', () => {
  for (const media of labelMediaPresets) {
    const layout = labelLayout({ title: 'M4', description: 'Test', location: 'A1' }, undefined, media.key);
    assert.equal(layout.widthPt, media.widthPt); assert.equal(layout.heightPt, media.heightPt); assert.deepEqual(layout.warnings, []);
    assert.ok(pageSvg(layout).includes(`viewBox="0 0 ${media.widthPt} ${media.heightPt}"`));
    assert.ok(layout.lines.every(line => line.y < media.heightPt && line.width <= media.widthPt - 17));
    assert.ok(labelLayout({ title: 'Test', description: 'Long '.repeat(300), location: 'A1' }, undefined, media.key).warnings.length);
  }
});
