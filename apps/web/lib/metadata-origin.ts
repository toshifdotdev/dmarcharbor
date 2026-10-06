import { headers } from "next/headers";

/**
 * metadata-origin.ts — the public origin a canonical URL is built against.
 *
 * This app serves its own domain AND branded custom domains from the same
 * build, so a hardcoded origin is wrong on every custom domain: the canonical
 * for an agency's page is the agency's host, not ours. The request Host header
 * is the truth here (the same read the brand layer uses), with a configured
 * fallback for builds where no request exists.
 */

export const DEFAULT_PUBLIC_ORIGIN = "https://dmarcharbor.com";

/** The origin of the request being served: scheme + host, no path. */
export async function requestOrigin(): Promise<string> {
  let h: Awaited<ReturnType<typeof headers>>;
  try {
    h = await headers();
  } catch {
    return DEFAULT_PUBLIC_ORIGIN;
  }
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return DEFAULT_PUBLIC_ORIGIN;
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}
