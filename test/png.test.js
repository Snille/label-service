import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodePng, encodeRgba, encodeBlackAndWhite, toBlackAndWhite } from '../src/png.js';

// A grey ramp from black (left) to white (right); the top two rows are transparent.
function ramp(width = 40, height = 20) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4, v = Math.round(x / (width - 1) * 255);
    rgba[o] = rgba[o + 1] = rgba[o + 2] = v; rgba[o + 3] = y < 2 ? 0 : 255;
  }
  return { width, height, rgba };
}

test('PNG pictures decode to RGBA, including palette, grey and filtered rows', () => {
  const picture = ramp(), back = decodePng(encodeRgba(picture.width, picture.height, picture.rgba));
  assert.deepEqual([back.width, back.height], [40, 20]); assert.ok(back.rgba.equals(picture.rgba));
  // A 2 x 2 palette picture with 1-bit indices and an Up filter on the second row.
  const chunk = (kind, body) => { const b = Buffer.alloc(8 + body.length + 4); b.writeUInt32BE(body.length, 0); b.write(kind, 4, 'latin1'); body.copy(b, 8); return b; };
  const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 1, 3, 0, 0, 0]);
  // Row 2 stores the difference to row 1: 0b10000000 - 0b01000000, so its indices are 1 and 0.
  const raw = Buffer.from([0, 0b01000000, 2, 0b01000000]);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', Buffer.from([255, 0, 0, 0, 0, 255])), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const palette = decodePng(png);
  assert.deepEqual([...palette.rgba.subarray(0, 8)], [255, 0, 0, 255, 0, 0, 255, 255]);
  assert.deepEqual([...palette.rgba.subarray(8, 16)], [0, 0, 255, 255, 255, 0, 0, 255]);
  assert.throws(() => decodePng(Buffer.from('not a picture')), /not a valid PNG/);
  const interlaced = Buffer.from(png); interlaced[8 + 8 + 12] = 1;
  assert.throws(() => decodePng(interlaced), /Interlaced/);
});

test('pictures become black and white dots by threshold or dithering, with transparency on white', () => {
  const picture = ramp();
  const threshold = toBlackAndWhite(picture, 20, 10);
  assert.deepEqual([...threshold.subarray(100, 120)].join(''), '11111111110000000000');
  assert.equal([...threshold.subarray(0, 20)].join(''), '0'.repeat(20)); // transparent rows are white
  assert.equal([...toBlackAndWhite(picture, 20, 10, { invert: true }).subarray(100, 120)].join(''), '00000000001111111111');
  // Dithering spreads the grey: about as many black dots as the ramp is dark.
  const dither = toBlackAndWhite(picture, 20, 10, { mode: 'dither' }), black = [...dither.subarray(20)].filter(Boolean).length;
  assert.ok(black > 60 && black < 100, `${black} black dots`);
  // Lightening makes fewer dots black, more so the stronger it is; 0 changes nothing.
  const count = options => [...toBlackAndWhite(picture, 20, 10, { mode: 'dither', ...options }).subarray(20)].filter(Boolean).length;
  assert.equal(count({ lighten: 0 }), black);
  assert.ok(count({ lighten: 40 }) < black && count({ lighten: 100 }) < count({ lighten: 40 }), `${black} > ${count({ lighten: 40 })} > ${count({ lighten: 100 })}`);
  const bw = decodePng(encodeBlackAndWhite(20, 10, threshold));
  assert.deepEqual([bw.width, bw.height, bw.rgba[(5 * 20) * 4], bw.rgba[(5 * 20 + 19) * 4]], [20, 10, 0, 255]);
});
