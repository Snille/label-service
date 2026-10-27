// Barcodes and 2D codes. bwip-js encodes the data; the layout draws the bars and modules itself as filled rectangles
// sized in whole printer dots (300 dpi), so every bar prints with sharp edges and the same width.
import bwipjs from 'bwip-js';

export const dot = 72 / 300; // one printer dot in points
const names = { code128: 'Code 128', code39: 'Code 39', ean13: 'EAN-13', ean8: 'EAN-8', upca: 'UPC-A', itf14: 'ITF-14', qrcode: 'QR code', datamatrix: 'Data Matrix' };
export const symbologyName = symbology => names[symbology] || symbology;

// bwip-js reports problems as "bwipp.ean13badCheckDigit#6915: Incorrect EAN-13 check digit provided".
const reason = error => String(error?.message || error).replace(/^bwipp?\.[\w]+#\d+:\s*/, '').replace(/^bwip-js:\s*/, '');

// The GS1 check digit (EAN-13, EAN-8, UPC-A, ITF-14): from the right, the digits weigh 3, 1, 3, 1 ...
export function gs1CheckDigit(digits) {
  const sum = [...digits].reverse().reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 1 : 3), 0);
  return String((10 - sum % 10) % 10);
}
export const ean13CheckDigit = gs1CheckDigit;
// The number of digits without the check digit, for the codes whose check digit label-service adds.
const gs1Digits = { ean13: 12, ean8: 7, upca: 11, itf14: 13 };

// Linear codes become modules [{start, width}] counted in narrow bars; 2D codes become a grid of dark cells.
export function encode(symbology, text, { ecLevel } = {}) {
  let result;
  try {
    result = bwipjs.raw({ bcid: symbology, text, ...(symbology === 'qrcode' && ecLevel ? { eclevel: ecLevel } : {}) })[0];
  } catch (error) {
    throw new Error(reason(error));
  }
  if (result.pixs) return { kind: 'matrix', columns: result.pixx, rows: result.pixy, cells: Array.from(result.pixs, Boolean) };
  const bars = []; let position = 0;
  result.sbs.forEach((width, index) => { if (index % 2 === 0) bars.push({ start: position, width }); position += width; });
  const short = gs1Digits[symbology], label = short && new RegExp(`^\\d{${short}}$`).test(text) ? text + gs1CheckDigit(text) : text;
  return { kind: 'linear', bars, modules: position, text: label };
}
