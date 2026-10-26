// PNG decoding to RGBA and 1-bit PNG encoding, with Node's zlib only. Pictures on labels are stored as PNG and turned
// into black and white here, so the preview and the printed label show the same dots.
import { inflateSync, deflateSync, crc32 } from 'node:zlib';
import { InputError } from './validation.js';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const isPng = bytes => bytes.length > 8 && bytes.subarray(0, 8).equals(signature);

export function pngSize(bytes) {
  if (!isPng(bytes) || bytes.toString('latin1', 12, 16) !== 'IHDR') throw new InputError('The picture is not a valid PNG.');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// Any non-interlaced PNG (grey, RGB, palette, with alpha; 1 to 16 bits) becomes 8-bit RGBA.
export function decodePng(bytes, { maxPixels = 16e6 } = {}) {
  const { width, height } = pngSize(bytes);
  let depth, type, interlace, palette = null, transparency = null; const data = [];
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(at), kind = bytes.toString('latin1', at + 4, at + 8), body = bytes.subarray(at + 8, at + 8 + length);
    if (kind === 'IHDR') { depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') transparency = body;
    else if (kind === 'IDAT') data.push(body);
    else if (kind === 'IEND') break;
    at += 12 + length;
  }
  if (!width || !height || width * height > maxPixels) throw new InputError('The picture is too large (at most 16 megapixels).');
  if (interlace) throw new InputError('Interlaced PNG pictures are not supported. Save the picture without interlacing.');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth) || (type === 3 && !palette)) throw new InputError('The PNG colour format is not supported.');
  let raw;
  try { raw = inflateSync(Buffer.concat(data)); } catch { throw new InputError('The PNG picture data is damaged.'); }
  const bpp = Math.max(1, (channels * depth) >> 3), stride = Math.ceil(width * channels * depth / 8);
  if (raw.length < height * (stride + 1)) throw new InputError('The PNG picture data is damaged.');
  const lines = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), out = lines.subarray(y * stride, (y + 1) * stride);
    const prior = y ? lines.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0, b = prior[i], c = i >= bpp ? prior[i - bpp] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (filter !== 0) throw new InputError('The PNG picture data is damaged.');
      out[i] = value & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4), max = (1 << depth) - 1;
  const sample = (row, index) => {
    if (depth === 8) return lines[row * stride + index];
    if (depth === 16) return lines[row * stride + index * 2];
    const bit = index * depth, byte = lines[row * stride + (bit >> 3)];
    return (byte >> (8 - depth - (bit & 7))) & max;
  };
  const scale = depth < 8 && type !== 3 ? 255 / max : 1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4, s = x * channels;
    if (type === 3) {
      const i = sample(y, s); rgba[o] = palette[i * 3]; rgba[o + 1] = palette[i * 3 + 1]; rgba[o + 2] = palette[i * 3 + 2];
      rgba[o + 3] = transparency && i < transparency.length ? transparency[i] : 255;
    } else if (type === 0 || type === 4) {
      const g = Math.round(sample(y, s) * scale); rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
      rgba[o + 3] = type === 4 ? sample(y, s + 1) : transparency && depth <= 8 && sample(y, s) === transparency.readUInt16BE(0) ? 0 : 255;
    } else {
      rgba[o] = sample(y, s); rgba[o + 1] = sample(y, s + 1); rgba[o + 2] = sample(y, s + 2); rgba[o + 3] = type === 6 ? sample(y, s + 3) : 255;
    }
  }
  return { width, height, rgba };
}

function chunk(kind, body) {
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(kind, 4, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

// ink[y * width + x] is true for a black dot. The result is a 1-bit greyscale PNG (0 black, 1 white).
export function encodeBlackAndWhite(width, height, ink) {
  const stride = Math.ceil(width / 8), raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!ink[y * width + x]) raw[y * (stride + 1) + 1 + (x >> 3)] |= 0x80 >> (x & 7);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 1; header[9] = 0;
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// An 8-bit RGBA PNG, for tests and for pictures made in memory.
export function encodeRgba(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Resamples to the target size in printer dots (an average over each dot's area), puts transparency on white and
// decides black or white per dot: a fixed threshold, or Floyd-Steinberg error diffusion for photos and shades.
// lighten (0-100) brightens the midtones first: a thermal dot prints larger than its share of the label, so a
// dithered picture comes out darker on paper than on screen. 0 leaves the picture as it is.
export function toBlackAndWhite(picture, width, height, { mode = 'threshold', threshold = 128, invert = false, lighten = 0 } = {}) {
  const gamma = 1 + lighten / 50;
  const grey = new Float32Array(width * height), sx = picture.width / width, sy = picture.height / height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)), y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    let sum = 0, n = 0;
    for (let v = y0; v < y1 && v < picture.height; v++) for (let u = x0; u < x1 && u < picture.width; u++) {
      const o = (v * picture.width + u) * 4, alpha = picture.rgba[o + 3] / 255;
      const luma = 0.299 * picture.rgba[o] + 0.587 * picture.rgba[o + 1] + 0.114 * picture.rgba[o + 2];
      sum += luma * alpha + 255 * (1 - alpha); n++;
    }
    const value = invert ? 255 - sum / n : sum / n;
    grey[y * width + x] = gamma === 1 ? value : 255 * Math.pow(value / 255, 1 / gamma);
  }
  const ink = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, old = grey[i], black = old < threshold; ink[i] = black ? 1 : 0;
    if (mode !== 'dither') continue;
    const error = old - (black ? 0 : 255);
    if (x + 1 < width) grey[i + 1] += error * 7 / 16;
    if (y + 1 < height) {
      if (x > 0) grey[i + width - 1] += error * 3 / 16;
      grey[i + width] += error * 5 / 16;
      if (x + 1 < width) grey[i + width + 1] += error / 16;
    }
  }
  return ink;
}
