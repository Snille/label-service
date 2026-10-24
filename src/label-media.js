// Explicit CUPS keys/nominal geometry from the reference app. Physical acceptance is per format.
// Default text sizes are the owner-accepted values for each format (S0722550 needs a 6-point description).
// Orientation names the direction of the text: landscape runs along the label's long side, portrait across it.
// Each default is the orientation the format was accepted in, so text is never rotated unless chosen.
export const labelOrientations = ['portrait', 'landscape'];
export const naturalOrientation = media => media.widthPt > media.heightPt ? 'landscape' : 'portrait';
const preset = (key, sku, widthMm, heightMm, widthPt, heightPt, descriptionSize = 8) => {
  const media = { key, sku, name: `${sku} · ${widthMm} × ${heightMm} mm`, widthPt, heightPt, widthMm, heightMm };
  return { ...media, style: { titleSize: 11, descriptionSize, locationSize: 8, locationLabelSize: 16, orientation: naturalOrientation(media) } };
};
export const labelMediaPresets = [
  preset('w162h90', 'S0722540', 57, 32, 162, 90),
  preset('w54h144', 'S0722550', 19, 51, 54, 144, 6),
  preset('w72h154', 'S0722520', 25, 54, 72, 154),
  preset('w154h286', 'S0722430', 54, 101, 154, 286)
];
export const labelSizeKeys = ['titleSize', 'descriptionSize', 'locationSize', 'locationLabelSize'];
export const defaultLabelStyles = () => Object.fromEntries(labelMediaPresets.map(p => [p.key, { ...p.style }]));
