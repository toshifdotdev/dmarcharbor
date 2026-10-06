/**
 * route-hrefs.ts — the ONE place internal ids are put into app URLs.
 *
 * ID-IN-URL POLICY (phase 7 sweep): clicking a domain currently puts a cuid
 * in the address bar — a database primary key where customers see, share,
 * screenshot and paste into support emails. The fix is a server-side slug
 * (landing in apps/api), and until it is green the app keeps building on ids.
 *
 * This module exists so the switch is one file: when slugs land, every helper
 * here takes a slug and resolves it server-side — no client-side slug
 * generation, because a slug minted in the browser breaks the first time a
 * name changes. NOTHING outside this module may build one of these paths by
 * hand; if you find a `router.push('/domains/' + id)` anywhere else, move it
 * here first.
 */

/** Domain detail — the operator's evidence screen. */
export function domainHref(domainId: string): string {
  return `/domains/${domainId}`;
}

/** Domain setup — ownership, DMARC record, shares. */
export function onboardingHref(domainId: string): string {
  return `/onboarding/${domainId}`;
}

/** Client portal's domain view — the contact-facing document. */
export function portalDomainHref(domainId: string): string {
  return `/portal/domain/${domainId}`;
}

/** Compliance section scoped to a client. The client picker carries the id in
 *  a query parameter today; it becomes a client slug when the server exposes
 *  one the routes can resolve. */
export function complianceHref(clientId: string): string {
  return `/settings/compliance?client=${encodeURIComponent(clientId)}`;
}

/** The RENDERED public share page — the document a client contact opens. The
 *  API's own /api/reports/share/:token serves the same data as JSON for the
 *  page to render; linking customers to that raw endpoint shows them a wall of
 *  JSON instead of a report. Customers get this path. */
export function shareHref(token: string): string {
  return `/share/${encodeURIComponent(token)}`;
}
