/**
 * site-config.ts — checks on the production settings that decide how this
 * site is addressed and verified: SITE_URL, NEXT_PUBLIC_APP_HOST and the
 * search-console tokens.
 *
 * Each of them fails quietly when wrong. A SITE_URL without its scheme is
 * ignored and every host becomes its own canonical again; an http one makes
 * every canonical point at the insecure address; a NEXT_PUBLIC_APP_HOST that
 * differs from SITE_URL sends our own host through the custom-domain lookup;
 * a pasted meta tag in place of the token renders a tag no console accepts.
 * So they are checked once, where a mistake is loud: next.config.ts at build
 * time and instrumentation.ts when the server starts.
 *
 * Pure, with no imports, so tests/site-config.test.ts covers it.
 */

/** Why a SITE_URL value is unusable, or null when it is fine or unset. */
export function siteUrlProblem(raw: string | undefined, production: boolean): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `SITE_URL "${value}" is not a URL. Write the scheme too, for example https://dmarcharbor.com.`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return `SITE_URL must be an http or https origin, not ${url.protocol}.`;
  if (production && url.protocol !== "https:") return "SITE_URL must be https in production: every canonical URL is built on it.";
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    return `SITE_URL must be an origin only, such as https://dmarcharbor.com, with no path, query or credentials (got "${value}").`;
  }
  return null;
}

/** Why a NEXT_PUBLIC_APP_HOST value is unusable, or null. It is compared
 *  with the request's hostname, so a scheme, port or path never matches. */
export function appHostProblem(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!/^[a-z0-9.-]+$/.test(value) || value.startsWith(".") || value.endsWith(".")) {
    return `NEXT_PUBLIC_APP_HOST must be a bare lowercase hostname such as dmarcharbor.com, with no scheme, port or path (got "${value}").`;
  }
  return null;
}

/**
 * Production advice that does not stop the server: settings that are missing
 * or disagree. The harness and CI run a production build without SITE_URL on
 * purpose, so its absence is a warning, not a refusal.
 */
export function siteConfigWarnings(env: {
  SITE_URL?: string;
  NEXT_PUBLIC_APP_HOST?: string;
  GOOGLE_SITE_VERIFICATION?: string;
  BING_SITE_VERIFICATION?: string;
}): string[] {
  const out: string[] = [];
  const site = env.SITE_URL?.trim();
  const appHost = env.NEXT_PUBLIC_APP_HOST?.trim();
  if (!site) {
    out.push("SITE_URL is not set: every host serving these pages is its own canonical and may be indexed. Set SITE_URL=https://dmarcharbor.com.");
  }
  if (!appHost) {
    out.push("NEXT_PUBLIC_APP_HOST was not set at build time: our own host goes through the custom-domain lookup on every cache expiry.");
  }
  if (site && appHost && !siteUrlProblem(site, false) && new URL(site).hostname !== appHost) {
    out.push(`NEXT_PUBLIC_APP_HOST (${appHost}) is not SITE_URL's hostname (${new URL(site).hostname}): set both to the same host.`);
  }
  for (const name of ["GOOGLE_SITE_VERIFICATION", "BING_SITE_VERIFICATION"] as const) {
    const raw = env[name]?.trim();
    if (raw && !verificationToken(raw)) out.push(`${name} is not a verification token and is ignored. Paste only the content value of the tag.`);
  }
  return out;
}

/**
 * A search-console token as the console expects to find it in the tag's
 * content. A whole pasted tag (`<meta name="..." content="abc" />`) is
 * reduced to its content; anything that is still not a plain token is null,
 * so nothing odd is rendered into <head>.
 */
export function verificationToken(raw: string | undefined): string | null {
  let value = raw?.trim();
  if (!value) return null;
  const tag = /content\s*=\s*["']([^"']+)["']/i.exec(value);
  if (tag) value = tag[1]!.trim();
  return /^[A-Za-z0-9_\-+/=.]{8,200}$/.test(value) ? value : null;
}

/**
 * The origin to send a request to when it arrived on the www. twin of our own
 * host (or on the bare host when SITE_URL is the www. one), else null. One
 * address for every page, rather than two that each say noindex on one.
 */
export function wwwTwinRedirect(input: { hostname: string | null; siteOrigin: string | null }): string | null {
  if (!input.hostname || !input.siteOrigin) return null;
  const site = new URL(input.siteOrigin).hostname;
  const twin = site.startsWith("www.") ? site.slice(4) : `www.${site}`;
  return input.hostname === twin ? input.siteOrigin : null;
}
