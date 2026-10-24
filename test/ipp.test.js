import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { labelLayout, labelPostScript, testLabel } from '../src/labels.js';
import { CupsPrinter, encodeIpp, decodeIpp, ippAttribute as attr, ippTags as tag, ippValues } from '../src/ipp.js';
test('IPP transport sends one PostScript document with explicit media and rejects attribute substitution', async t => {
  let substituted = false;
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), documentStart = bytes.indexOf(Buffer.from('%!PS-Adobe'));
    const attributes = decodeIpp(documentStart < 0 ? bytes : bytes.subarray(0, documentStart), bytes.readInt32BE(4));
    requests.push({ code: bytes.readUInt16BE(2), attributes, document: documentStart < 0 ? null : bytes.subarray(documentStart) });
    res.writeHead(200, { 'content-type': 'application/ipp' });
    res.end(encodeIpp(substituted ? 1 : 0, bytes.readInt32BE(4), [{ tag: 2, attributes: [attr('job-id', tag.integer, 42), attr('job-state', tag.enum, 9)] }]));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const printer = new CupsPrinter({ serverUrl: `http://127.0.0.1:${server.address().port}`, queue: 'fixture' });
  await printer.validate('w162h90', 'Test');
  const ps = labelPostScript(labelLayout(testLabel)); assert.equal(await printer.print('w162h90', 'Test', ps), 42);
  assert.equal((await printer.job(42)).state, 'completed');
  assert.deepEqual(requests.map(r => r.code), [4, 2, 9]);
  assert.equal(requests[0].document, null); assert.deepEqual(requests[1].document, ps);
  assert.deepEqual(ippValues(requests[1].attributes, 'copies', 2), [1]);
  assert.deepEqual(ippValues(requests[1].attributes, 'media', 2), ['w162h90']);
  assert.deepEqual(ippValues(requests[1].attributes, 'ipp-attribute-fidelity', 1), [true]);
  substituted = true; await assert.rejects(printer.validate('w162h90', 'Test'), error => /substituted/.test(error.message) && error.ippStatus === 1);
});

test('IPP codec bounds malformed data and scalar continuations', () => {
  const encoded = encodeIpp(0, 1, [{ tag: 4, attributes: [attr('media-supported', tag.keyword, ['one', 'two']), attr('printer-state', tag.enum, 3)] }]);
  assert.deepEqual(ippValues(decodeIpp(encoded, 1), 'media-supported', 4), ['one', 'two']);
  assert.throws(() => decodeIpp(encoded, 2)); assert.throws(() => decodeIpp(encoded.subarray(0, -1), 1));
  assert.throws(() => decodeIpp(Buffer.alloc(1024 * 1024 + 1), 1));
  for (const url of ['http://user:key@localhost', 'file:///tmp', 'http://localhost/admin']) assert.throws(() => new CupsPrinter({ serverUrl: url, queue: 'test' }));
});
