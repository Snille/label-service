// Explicit CUPS keys/nominal geometry. Physical acceptance is per format.
// Default text sizes are the owner-accepted values for each format (S0722550 needs a 6-point description).
// Orientation names the direction of the text: landscape runs along the label's long side, portrait across it.
// Each default is the orientation the format was accepted in, so text is never rotated unless chosen.
export const labelOrientations = ['portrait', 'landscape'];
export const naturalOrientation = media => media.widthPt > media.heightPt ? 'landscape' : 'portrait';
const preset = (key, sku, widthMm, heightMm, widthPt, heightPt, sizes = {}, { wide = false } = {}) => {
  const media = { key, sku, name: `${sku} · ${widthMm} × ${heightMm} mm`, widthPt, heightPt, widthMm, heightMm, wide };
  return { ...media, style: { titleSize: 11, descriptionSize: 8, locationSize: 8, locationLabelSize: 16, ...sizes, orientation: naturalOrientation(media) } };
};
export const labelMediaPresets = [
  preset('w162h90', 'S0722540', 57, 32, 162, 90),
  preset('w54h144', 'S0722550', 19, 51, 54, 144, { descriptionSize: 6 }),
  preset('w72h154', 'S0722520', 25, 54, 72, 154),
  preset('w154h286', 'S0722430', 54, 101, 154, 286),
  // Shipping labels: no named size in lw5xl.ppd, so CUPS uses the PPD's custom page size through the PWG
  // self-describing media name. Size measured by the owner (102 x 210 mm); the roll reports article 2166659.
  preset('custom_102x210mm_102x210mm', '2166659', 102, 210, 289.13, 595.28, { titleSize: 16, descriptionSize: 12, locationSize: 14 }, { wide: true })
];
export const labelSizeKeys = ['titleSize', 'descriptionSize', 'locationSize', 'locationLabelSize'];
export const defaultLabelStyles = () => Object.fromEntries(labelMediaPresets.map(p => [p.key, { ...p.style }]));

// DYMO LabelWriter models. The 5xx models use the official LW5xx driver (raster2dymolw_v2); the 450 and 4XL use the
// CUPS DYMO driver (printer-driver-dymo). Only the wide models take 4-inch labels; the PPDs of all five name the
// four narrow formats the same way. Roll reading (ESC A / ESC U) exists only on the 5xx models, over the network.
export const printerModels = [
  { key: 'lw5xl', name: 'LabelWriter 5XL', wide: true, rollReader: true, ppd: 'lw5xl.ppd' },
  { key: 'lw550t', name: 'LabelWriter 550 Turbo', wide: false, rollReader: true, ppd: 'lw550t.ppd' },
  { key: 'lw550', name: 'LabelWriter 550', wide: false, rollReader: true, ppd: 'lw550.ppd' },
  { key: 'lw450', name: 'LabelWriter 450', wide: false, rollReader: false, ppd: 'lw450.ppd' },
  { key: 'lw4xl', name: 'LabelWriter 4XL', wide: true, rollReader: false, ppd: 'lw4xl.ppd' }
];
export const printerModel = key => printerModels.find(m => m.key === key);
export const mediaForModel = key => labelMediaPresets.filter(p => !p.wide || printerModel(key)?.wide);
export const mmToPt = mm => mm * 72 / 25.4;
