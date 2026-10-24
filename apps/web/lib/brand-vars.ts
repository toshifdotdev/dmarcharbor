/**
 * brand-vars.ts — a tenant's two colours as the Chart system's custom
 * properties, and the contrast arithmetic behind them.
 *
 * Pure, so the server (BrandApplier, the portal frame) and the browser (the
 * white-label preview) compute exactly the same thing: the preview a person
 * approves is the rendering a client gets.
 *
 * The API's field names are kept: `primaryColor` is the brand colour (links,
 * focus, primary buttons); `accentColor` is the text set ON that colour. When
 * no text colour is set, black or white is chosen for contrast.
 */

export const HEX = /^#[0-9a-f]{6}$/i;

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two #rrggbb colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on the given #rrggbb. */
export function contrastInk(hex: string): string {
  // Measured against the real ink. The earlier shortcut divided by a constant
  // that is not the ink's luminance, which picked dark text on mid blues
  // (3.1:1 on #2266dd, where white reads at 5.0:1).
  return contrastRatio(hex, "#ffffff") >= contrastRatio(hex, "#13212c") ? "#ffffff" : "#13212c";
}

export function chartBrandVars(primaryColor: string | null, accentColor: string | null): Record<string, string> {
  const primary = primaryColor && HEX.test(primaryColor) ? primaryColor : null;
  const ink = accentColor && HEX.test(accentColor) ? accentColor : null;
  if (!primary) return ink ? { "--color-accent-ink": ink } : {};
  const onPrimary = ink ?? contrastInk(primary);
  return {
    "--color-accent": primary,
    "--color-accent-ink": onPrimary,
    "--hb-primary": primary,
    "--hb-primary-ink": onPrimary,
  };
}
