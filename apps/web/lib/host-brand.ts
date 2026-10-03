import { headers } from "next/headers";

/**
 * host-brand.ts — the agency's branding on a custom domain.
 *
 * middleware.ts resolves GET /api/branding/host (cached per host) and passes
 * the answer on request headers; this module is the app-side read of it. The
 * three states matter:
 *
 *   verified   — the agency's brand renders (logo, colours, name). A custom
 *                domain is an Admiralty feature: the shell is the surface that
 *                makes it real rather than a line in a contract.
 *   unverified — the domain is pointed at us but its record is not verified.
 *                Say so plainly and serve the default brand — half-branded
 *                looks like a bug in ours, and the agency must not think their
 *                branding is live when it is not.
 *   miss / default — ordinary hostnames render the default brand, unchanged.
 */

export type HostBrandState = "verified" | "unverified" | "miss" | "default";

export interface HostBrand {
  state: HostBrandState;
  workspaceName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
}

export const DEFAULT_BRAND: HostBrand = {
  state: "default",
  workspaceName: "DMARC Harbor",
  logoUrl: null,
  primaryColor: null,
  accentColor: null,
};

export async function readHostBrand(): Promise<HostBrand> {
  // No request store exists during static prerender (Next's synthetic error
  // pages, for one), where headers() throws. That is the default brand case:
  // no request means no custom Host to resolve.
  let h: Awaited<ReturnType<typeof headers>>;
  try {
    h = await headers();
  } catch {
    return DEFAULT_BRAND;
  }
  const state = (h.get("x-harbor-host-state") ?? "default") as HostBrandState;
  if (state === "verified") {
    const raw = h.get("x-harbor-brand");
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as {
          workspaceName?: string;
          logoUrl?: string | null;
          primaryColor?: string | null;
          accentColor?: string | null;
        };
        return {
          state,
          workspaceName: parsed.workspaceName ?? DEFAULT_BRAND.workspaceName,
          // Only a platform-served uploaded object ever reaches an <img>: a
          // user-typed logo URL is filtered out server-side, and rendering one
          // would be a security bug.
          logoUrl: parsed.logoUrl ?? null,
          primaryColor: parsed.primaryColor ?? null,
          accentColor: parsed.accentColor ?? null,
        };
      } catch {
        return DEFAULT_BRAND;
      }
    }
    return DEFAULT_BRAND;
  }
  return { ...DEFAULT_BRAND, state };
}
