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
 */

import { readHostBrand } from "@/lib/host-brand";

export async function BrandApplier() {
  const brand = await readHostBrand();
  if (brand.state !== "verified") return null;

  const vars: Record<string, string> = {};
  if (brand.primaryColor) vars["--color-accent"] = brand.primaryColor;
  if (brand.accentColor) vars["--color-accent-ink"] = brand.accentColor;

  return (
    <style
      data-testid="host-brand-style"
      dangerouslySetInnerHTML={{
        __html: `:root{${Object.entries(vars)
          .map(([k, v]) => `${k}:${v}`)
          .join(";")}}`,
      }}
    />
  );
}
