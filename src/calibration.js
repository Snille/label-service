// Roll calibration from the test print (decision B12). The DYMO 5XL shrinks a print made with one of the named page
// sizes of DYMO's lw5xl.ppd (w162h90 and the like) to about 88-92 %, the same in both directions, while the same label
// on a custom page size prints at true size (measured with a calliper in 2026-10; CUPS and the driver do not scale, so
// the cause is the named size). It also puts the image a little off the label, against its left edge. So a named roll
// prints on a custom page a little wider than the label, with the drawing at its left edge; CUPS takes a custom size
// within a few points of a named one for the named one (164 x 286 pt became w167h288), so the page is 20 pt wider. The test print has a frame of lines
// a known distance inside the edges; the admin measures, on each side, the distance from the label's edge to its
// line. From the four distances follow the printer's scale, the image's offset and the edges that do not print.
// Should a roll still shrink, it gets a narrower image (maxDots). Everything here is in millimetres on the label as it
// reads in its natural direction.
import { mmToPt } from './label-media.js';

export const minimumEdgeMm = 1;
const dpi = 300;
const ptToMm = pt => pt * 25.4 / 72;
const round = (value, step = 0.01) => Math.round(value / step) * step;
const up = (value, step = 0.1) => Math.ceil(value / step - 1e-9) * step;
const fixed = value => +value.toFixed(2);
const ceil8 = dots => Math.ceil(dots / 8) * 8;

// The page CUPS prints for a roll. A named size becomes a wider custom page (paddedWidth), drawn from its left edge, on a
// printer with a 4-inch head (wideHead); a narrow head keeps the named size. A roll with maxDots gets a narrower
// custom page with the label centred on it. offset moves the drawing to make up for where the printer puts it.
// The named sizes of lw5xl.ppd (PaperDimension, points). CUPS takes a custom page within a few points of one of them
// for it (164 x 286 became 166.56 x 288, 74 x 144 became 70.32 x 144), so the wider page keeps 9 pt from all of them.
const namedSizes = [[36, 135.12], [54, 144], [56.4, 247.44], [62.4, 418.56], [64.8, 90], [70.32, 144], [72, 153.36], [72.96, 85.44], [78.48, 252],
  [78.96, 252], [79.2, 144], [81.12, 247.44], [101.28, 251.04], [101.52, 250.56], [108, 538.56], [111.36, 126], [117.12, 252], [130.56, 220.56],
  [138.96, 220.56], [144, 168.72], [153.12, 198], [153.36, 285.84], [153.6, 63.12], [162, 90], [166.32, 187.2], [166.56, 288], [167.04, 252],
  [175.44, 291.6], [252, 76.56], [288, 166.56], [295.92, 451.92]];
const clear = (w, h) => namedSizes.every(([nw, nh]) => Math.abs(w - nw) > 9 || Math.abs(h - nh) > 9);
export const paddedWidth = (widthPt, heightPt) => { for (let pad = 10; ; pad += 2) if (clear(widthPt + pad, heightPt)) return widthPt + pad; };
export function printPage(media, { wideHead = true } = {}) {
  const labelWidthPt = media.widthPt, heightPt = media.heightPt, named = !media.key.startsWith('custom_'), padded = named && wideHead && !media.maxDots;
  const widthPt = media.maxDots ? media.maxDots * 72 / dpi : padded ? paddedWidth(labelWidthPt, heightPt) : labelWidthPt;
  const widthMm = fixed(ptToMm(widthPt)), heightMm = fixed(ptToMm(heightPt));
  const custom = !named || padded || Boolean(media.maxDots);
  const key = media.maxDots || padded ? `custom_${widthMm}x${heightMm}mm_${widthMm}x${heightMm}mm` : media.key;
  const dx = (media.maxDots ? (widthPt - labelWidthPt) / 2 : 0) + mmToPt(media.offset?.x || 0), dy = mmToPt(media.offset?.y || 0);
  return { key, widthPt, heightPt, dx: fixed(dx), dy: fixed(dy), widthMm, heightMm, custom };
}

// The dots across the head that the printer receives for a page: a named DYMO size is cut to its imageable area
// (2.88 pt on each side in lw5xl.ppd), a custom size is not; the driver pads each line to whole bytes.
export function dotsSent(media, options) {
  const page = printPage(media, options);
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
// { scale, offset, margins } when the print was true to size. options: { wideHead } of the printer it was made on.
export function evaluate(media, distances, options) {
  const R = calibrationMark(media), W = ptToMm(media.widthPt), H = ptToMm(media.heightPt);
  const page = printPage(media, options), Wp = ptToMm(page.widthPt), Hp = ptToMm(page.heightPt), tx = ptToMm(page.dx), ty = ptToMm(page.dy);
  const { left, right, top, bottom } = distances;
  // The two lines are W - 2R apart in the drawing and (label width - left - right) apart on paper.
  const scaleX = (W - left - right) / (W - 2 * R), scaleY = (H - top - bottom) / (H - 2 * R);
  if (scaleX < 0.98) {
    // Shrunk: send no more dots than the printer printed, with a little room, in whole bytes.
    const maxDots = Math.floor(dotsSent(media, options) * scaleX * 0.99 / 8) * 8;
    return { shrink: true, scale: fixed(scaleX), scaleY: fixed(scaleY), maxDots };
  }
  // The printer scales both ways alike, so the width decides; a die-cut label may be up to about a millimetre longer
  // than its page (S0722540 measured 20.65 mm between the lines along it, 21.75 drawn), so the length only catches
  // readings that cannot be right.
  if (scaleX > 1.02 || scaleY < 0.93 || scaleY > 1.07) return { invalid: true, scale: fixed(scaleX), scaleY: fixed(scaleY) };
  // Where the drawing's edges land on paper, from the label's edges.
  const p0x = left - R, pWx = W - right + R, p0y = top - R, pHy = H - bottom + R;
  // Move the drawing by the mean error of its two edges.
  const offset = { x: fixed(round((media.offset?.x || 0) - (p0x + pWx - W) / 2, 0.05)), y: fixed(round((media.offset?.y || 0) - (p0y + pHy - H) / 2, 0.05)) };
  // The page reaches from (p0 - t) to (p0 - t + page size) on paper; outside that range nothing prints.
  const edges = { left: p0x - tx, right: W - (pWx - W + Wp - tx), top: p0y - ty, bottom: H - (pHy - H + Hp - ty) };
  const margins = Object.fromEntries(Object.entries(edges).map(([side, edge]) => [side, fixed(Math.min(10, up(Math.max(minimumEdgeMm, edge))))]));
  return { scale: fixed(scaleX), scaleY: fixed(scaleY), offset, margins };
}
