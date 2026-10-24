// Explicit CUPS keys/nominal geometry. Physical acceptance is per format.
// Default text sizes are the owner-accepted values for each format (S0722550 needs a 6-point description).
// Orientation names the direction of the text: landscape runs along the label's long side, portrait across it.
// Each default is the orientation the format was accepted in, so text is never rotated unless chosen.
export const labelOrientations = ['portrait', 'landscape'];
export const naturalOrientation = media => media.widthPt > media.heightPt ? 'landscape' : 'portrait';
const preset = (key, sku, widthMm, heightMm, widthPt, heightPt, sizes = {}) => {
  const media = { key, sku, name: `${sku} · ${widthMm} × ${heightMm} mm`, widthPt, heightPt, widthMm, heightMm };
  return { ...media, style: { titleSize: 11, descriptionSize: 8, locationSize: 8, locationLabelSize: 16, ...sizes, orientation: naturalOrientation(media) } };
};
export const labelMediaPresets = [
  preset('w162h90', 'S0722540', 57, 32, 162, 90),
  preset('w54h144', 'S0722550', 19, 51, 54, 144, { descriptionSize: 6 }),
  preset('w72h154', 'S0722520', 25, 54, 72, 154),
  preset('w154h286', 'S0722430', 54, 101, 154, 286),
  // Shipping labels: no named size in lw5xl.ppd, so CUPS uses the PPD's custom page size through the PWG
  // self-describing media name. Size measured by the owner (102 x 210 mm); the roll reports article 2166659.
  preset('custom_102x210mm_102x210mm', '2166659', 102, 210, 289.13, 595.28, { titleSize: 16, descriptionSize: 12, locationSize: 14 })
];
export const labelSizeKeys = ['titleSize', 'descriptionSize', 'locationSize', 'locationLabelSize'];
export const defaultLabelStyles = () => Object.fromEntries(labelMediaPresets.map(p => [p.key, { ...p.style }]));
