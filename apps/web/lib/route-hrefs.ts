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

/**
 * The audit trail, optionally narrowed.
 *
 * `action` and `domainId` are the two filters the API actually applies, so they
 * are the only two that travel. `outcome` is not one of them: the API has no
 * such filter, so it narrows the events already loaded rather than shaping the
 * request, and it stays out of the URL to keep that distinction visible.
 */
export function auditHref(filters: {
  action?: string;
  domain?: string;
  limit?: number;
} = {}): string {
  const query = new URLSearchParams();
  if (filters.action) query.set("action", filters.action);
  if (filters.domain) query.set("domain", filters.domain);
  if (filters.limit !== undefined) query.set("limit", String(filters.limit));
  const search = query.toString();
  return search ? `/settings/audit?${search}` : "/settings/audit";
}

/**
 * The forensics section, scoped to one domain and optionally one page of it.
 *
 * The domain travels in the query rather than the path because the section is
 * one page with a domain picker, not a route per domain: every forensic
 * endpoint except the single-report reads is domain-scoped, so the domain IS the
 * selection, and a path segment would imply a resource that does not exist.
 *
 * `cursor` is the API's own page cursor, taken from a previous response. It is
 * passed through untouched rather than reconstructed: the cursor is a report id
 * the API minted, and a page built from a guessed cursor would skip or repeat
 * rows in a list of evidence. Changing the domain drops it, because page two of
 * one domain says nothing about another.
 */
export function forensicsHref(
  filters: { domain?: string; cursor?: string } = {},
): string {
  const query = new URLSearchParams();
  if (filters.domain) query.set("domain", filters.domain);
  if (filters.cursor) query.set("cursor", filters.cursor);
  const search = query.toString();
  return search ? `/settings/forensics?${search}` : "/settings/forensics";
}

/** The RENDERED public share page — the document a client contact opens. The
 *  API's own /api/reports/share/:token serves the same data as JSON for the
 *  page to render; linking customers to that raw endpoint shows them a wall of
 *  JSON instead of a report. Customers get this path. */
export function shareHref(token: string): string {
  return `/share/${encodeURIComponent(token)}`;
}
