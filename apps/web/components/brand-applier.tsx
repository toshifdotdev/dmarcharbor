/**
 * brand-applier.tsx — the agency's colours on a custom domain.
 *
 * SERVER component on purpose: it reads request headers via
 * lib/host-brand (which uses next/headers — server-only), and it emits a
 * <style> tag the browser simply applies. Nothing here runs client-side, so
 * there is no "use client" and no hook — putting one here made it a client
 * component importing a server-only module, which breaks the build exactly
 * where branding must be most reliable.
 *
 * Two rules it must never break:
 * - A typed logo URL is never rendered. Only a platform-served uploaded object
 *   (which the server already filtered to) reaches an <img>; the logo lives in
 *   the shell's header, not here.
 * - An unverified record renders NOTHING: the shell says so plainly instead,
 *   because half-branded looks like a bug in ours and the agency must not
 *   think their branding is live when it is not.
 *
 * TWO SELECTORS, ONE CONTRACT. The tenant's colours land on `:root`, exactly as
 * before, for every Monolith screen. They also land on `[data-harbor]`, the root
 * of every screen rebuilt on the Chart system, because that element sets its own
 * default accent and an inherited :root value would otherwise lose to it. This
 * <style> is in <body>, after the stylesheet, so at equal specificity it wins.
 *
 * On the Chart side a tenant who set a primary colour but no ink colour gets an
 * ink chosen for contrast against their primary, rather than our default white
 * on whatever they picked. The Monolith side is unchanged.
 */

import { readHostBrand } from "@/lib/host-brand";

const HEX = /^#[0-9a-f]{6}$/i;

/** Black or white, whichever reads better on the given #rrggbb. */
function contrastInk(hex: string): string {
  const channel = (offset: number) => {
    const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  // Contrast against white vs against near-black ink.
  const onWhite = 1.05 / (luminance + 0.05);
  const onInk = (luminance + 0.05) / 0.0155;
  return onWhite >= onInk ? "#ffffff" : "#13212c";
}

/**
 * The Chart-side custom properties for a tenant's two colours, for a surface
 * that receives its brand from the API rather than from the request host (the
 * client portal). Invalid values are dropped, exactly as above.
 */
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

export async function BrandApplier() {
  const brand = await readHostBrand();
  if (brand.state !== "verified") return null;

  // The API validates both as #rrggbb; anything else never reaches a <style>.
  const primary = brand.primaryColor && HEX.test(brand.primaryColor) ? brand.primaryColor : null;
  const ink = brand.accentColor && HEX.test(brand.accentColor) ? brand.accentColor : null;

  const root: string[] = [];
  if (primary) root.push(`--color-accent:${primary}`);
  if (ink) root.push(`--color-accent-ink:${ink}`);

  // On the Chart side the tenant's primary colour lands on the accent (links,
  // focus, active states) AND on the primary-action fill, which defaults to
  // ink for our own brand.
  const chart: string[] = [];
  if (primary) {
    const onPrimary = ink ?? contrastInk(primary);
    chart.push(`--color-accent:${primary}`);
    chart.push(`--color-accent-ink:${onPrimary}`);
    chart.push(`--hb-primary:${primary}`);
    chart.push(`--hb-primary-ink:${onPrimary}`);
  } else if (ink) {
    chart.push(`--color-accent-ink:${ink}`);
  }

  if (root.length === 0) return null;

  return (
    <style
      data-testid="host-brand-style"
      dangerouslySetInnerHTML={{
        __html: `:root{${root.join(";")}}[data-harbor]{${chart.join(";")}}`,
      }}
    />
  );
}
