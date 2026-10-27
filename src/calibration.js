// Roll calibration from the test print (decision B12). The DYMO 5XL prints a raster image at true size only while it is
// no wider than the printer accepts for the roll (about 48.5 mm on the 54 and 57 mm rolls, the whole 102 mm on the
// shipping labels); a wider image is shrunk to fit, the same in both directions. It also places the image a little
// off the label. The test print has a frame of lines a known distance inside the edges; the admin measures, on each
// side, the distance from the label's edge to its line. From the four distances follow the printer's scale, the
// image's offset and the edges that do not print. Everything here is in millimetres on the label as it reads in its
// natural direction.
import { mmToPt } from './label-media.js';

export const minimumEdgeMm = 1;
const dpi = 300;
const ptToMm = pt => pt * 25.4 / 72;
const round = (value, step = 0.01) => Math.round(value / step) * step;
const up = (value, step = 0.1) => Math.ceil(value / step - 1e-9) * step;
const fixed = value => +value.toFixed(2);
const ceil8 = dots => Math.ceil(dots / 8) * 8;

// The page CUPS prints for a roll: the roll's own page, or a narrower custom page when the printer accepts fewer dots
// (maxDots), with the label drawn centred on it. offset moves the drawing to make up for where the printer puts it.
export function printPage(media) {
  const labelWidthPt = media.widthPt, heightPt = media.heightPt;
  const widthPt = media.maxDots ? media.maxDots * 72 / dpi : labelWidthPt;
  const widthMm = fixed(ptToMm(widthPt)), heightMm = fixed(ptToMm(heightPt));
  const key = media.maxDots ? `custom_${widthMm}x${heightMm}mm_${widthMm}x${heightMm}mm` : media.key;
  const dx = (widthPt - labelWidthPt) / 2 + mmToPt(media.offset?.x || 0), dy = mmToPt(media.offset?.y || 0);
  return { key, widthPt, heightPt, dx: fixed(dx), dy: fixed(dy), widthMm, heightMm, custom: Boolean(media.maxDots) || media.key.startsWith('custom_') };
}

// The dots across the head that the printer receives for a page: a named DYMO size is cut to its imageable area
// (2.88 pt on each side in lw5xl.ppd), a custom size is not; the driver pads each line to whole bytes.
export function dotsSent(media) {
  const page = printPage(media);
  return ceil8(Math.round((page.custom ? page.widthPt : page.widthPt - 5.76) * dpi / 72));
}

// How far inside each edge the test print's frame lines are (their outer edge): 5 mm on all but the smallest rolls.
export function calibrationMark(media) {
  const W = ptToMm(media.widthPt), H = ptToMm(media.heightPt);
  return Math.min(5, Math.floor((Math.min(W, H) / 2 - 2) * 2) / 2);
}

// The label is taken to be the size of its page (57 x 32 mm is 57.15 x 31.75 mm), as the chip and the drawing agree.
// distances: { left, right, top, bottom } from each edge of the label to the outer edge of that side's frame line,
// read on a test print made with the roll's current calibration (media.maxDots, media.offset).
// Answers either { shrink, scale, maxDots } when the printer shrank the print (print the test label again), or
// { scale, offset, margins } when the print was true to size.
export function evaluate(media, distances) {
  const R = calibrationMark(media), W = ptToMm(media.widthPt), H = ptToMm(media.heightPt);
  const page = printPage(media), Wp = ptToMm(page.widthPt), Hp = ptToMm(page.heightPt), tx = ptToMm(page.dx), ty = ptToMm(page.dy);
  const { left, right, top, bottom } = distances;
  // The two lines are W - 2R apart in the drawing and (label width - left - right) apart on paper.
  const scaleX = (W - left - right) / (W - 2 * R), scaleY = (H - top - bottom) / (H - 2 * R);
  if (scaleX < 0.98) {
    // Shrunk: send no more dots than the printer printed, with a little room, in whole bytes.
    const maxDots = Math.floor(dotsSent(media) * scaleX * 0.99 / 8) * 8;
    return { shrink: true, scale: fixed(scaleX), scaleY: fixed(scaleY), maxDots };
  }
  if (scaleX > 1.02 || scaleY < 0.98 || scaleY > 1.02) return { invalid: true, scale: fixed(scaleX), scaleY: fixed(scaleY) };
  // Where the drawing's edges land on paper, from the label's edges.
  const p0x = left - R, pWx = W - right + R, p0y = top - R, pHy = H - bottom + R;
  // Move the drawing by the mean error of its two edges.
  const offset = { x: fixed(round((media.offset?.x || 0) - (p0x + pWx - W) / 2, 0.05)), y: fixed(round((media.offset?.y || 0) - (p0y + pHy - H) / 2, 0.05)) };
  // The page reaches from (p0 - t) to (p0 - t + page size) on paper; outside that range nothing prints.
  const edges = { left: p0x - tx, right: W - (pWx - W + Wp - tx), top: p0y - ty, bottom: H - (pHy - H + Hp - ty) };
  const margins = Object.fromEntries(Object.entries(edges).map(([side, edge]) => [side, fixed(Math.min(10, up(Math.max(minimumEdgeMm, edge))))]));
  return { scale: fixed(scaleX), scaleY: fixed(scaleY), offset, margins };
}
