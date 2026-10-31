import { headers } from "next/headers";
import { supportEmailOrNull, supportUrlOrNull } from "./agency-contact";

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
 *
 * The agency's client contact (support email and page) travels in the same
 * header. Each is checked again here (lib/agency-contact.ts) and dropped if it
 * is not one plain address or a full https address, so a bad value never
 * becomes an href.
 */

export type HostBrandState = "verified" | "unverified" | "miss" | "default";

export interface HostBrand {
  state: HostBrandState;
  workspaceName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  /** The agency's support address for its clients, checked; null when absent or malformed. */
  supportEmail: string | null;
  /** The agency's https help page for its clients, checked; null when absent or not https. */
  supportUrl: string | null;
}

export const DEFAULT_BRAND: HostBrand = {
  state: "default",
  workspaceName: "DMARC Harbor",
  logoUrl: null,
  primaryColor: null,
  accentColor: null,
  supportEmail: null,
  supportUrl: null,
};

/**
 * The verified host's brand from the proxy's x-harbor-brand JSON, or the
 * default brand when it is missing or unreadable. Exported for the tests.
 */
export function parseHostBrand(raw: string | null): HostBrand {
  if (!raw) return DEFAULT_BRAND;
  try {
    const parsed = JSON.parse(raw) as {
      workspaceName?: string;
      logoUrl?: string | null;
      primaryColor?: string | null;
      accentColor?: string | null;
      supportEmail?: unknown;
      supportUrl?: unknown;
    };
    return {
      state: "verified",
      workspaceName: parsed.workspaceName ?? DEFAULT_BRAND.workspaceName,
      // Only a platform-served uploaded object ever reaches an <img>: a
      // user-typed logo URL is filtered out server-side, and rendering one
      // would be a security bug.
      logoUrl: parsed.logoUrl ?? null,
      primaryColor: parsed.primaryColor ?? null,
      accentColor: parsed.accentColor ?? null,
      supportEmail: supportEmailOrNull(parsed.supportEmail),
      supportUrl: supportUrlOrNull(parsed.supportUrl),
    };
  } catch {
    return DEFAULT_BRAND;
  }
}

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
  if (state === "verified") return parseHostBrand(h.get("x-harbor-brand"));
  return { ...DEFAULT_BRAND, state };
}
