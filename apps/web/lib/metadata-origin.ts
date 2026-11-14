import { headers } from "next/headers";

/**
 * metadata-origin.ts — the origin the request arrived on.
 *
 * This is the address the visitor used, which is not always the address a
 * crawler should know the page by: canonical URLs, the sitemap and structured
 * data use canonicalOrigin() in lib/site-origin.ts, which names SITE_URL for
 * our pages on any of our hosts and this origin only on an agency's verified
 * domain. Use this one for links a person follows from where they are (a
 * client's sign-in address shown in settings, for one).
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
  // The first entry of each, checked: both headers can arrive from the client
  // as written, and either was reflected into canonical URLs and links whole
  // ("x-forwarded-proto: javascript" included).
  const forwarded = h.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = (forwarded || h.get("host") || "").trim().toLowerCase();
  if (!host || !/^[a-z0-9.-]+(?::\d{1,5})?$/.test(host)) return DEFAULT_PUBLIC_ORIGIN;
  const local = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  const claimed = h.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const proto = claimed === "http" || claimed === "https" ? claimed : local ? "http" : "https";
  return `${proto}://${host}`;
}
