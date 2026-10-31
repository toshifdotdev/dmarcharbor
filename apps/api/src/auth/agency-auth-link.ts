import { prisma } from '../database/prisma.js';
import { agencyFromHeader } from '../email/sender.js';
import { appOrigin } from '../services/client-origin.js';
import { agencyForOrigin, type AgencyHost } from './agency-origin.js';

/**
 * Puts an emailed password reset or verification link on the agency's domain.
 *
 * Better Auth builds these links on BETTER_AUTH_URL, our API host, with the
 * page to land on in a `callbackURL` query parameter. A client who started on
 * `reports.wistholm.example` sent that host as the callback. Opening our API
 * host instead showed them an address they had never seen, and the session
 * cookie the verify step sets landed on our host, not the agency's, so they
 * arrived signed out.
 *
 * When the callback's origin is a verified agency domain the link is rebuilt on
 * that origin with the same path and query. The web app proxies `/api/auth/*`
 * there, so the path still works, and the cookie is set on the host the client
 * is using.
 *
 * Only for an account the agency already controls: an active portal contact of
 * one of its clients, with no portal access at any other agency and no seat in
 * any workspace. The callback was checked against the request's trusted
 * origins, but the headers that check reads are the caller's to choose when the
 * caller is not a browser, and the agency, not we, decides where its domain
 * points. So the token in the link can reach the agency. For its own client's
 * portal account that gives it nothing it lacks (it grants and revokes that
 * access already). For a team member, who may hold a seat in another workspace,
 * or for a contact another agency also serves, it would hand over an account
 * the agency does not own. For everyone but its own clients the callback is
 * moved to our app origin with the same path, so the link keeps working and the
 * token goes only to us. Staff links are on our address anyway.
 */

export interface AuthLink {
  url: string;
  /** The agency the link was rebuilt for, or null when it was left on our host. */
  agency: AgencyHost | null;
  /** The agency's From header, when the link was rebuilt for one. */
  from?: string;
}

/** True when this account's only access anywhere is this agency's client portal. */
async function onlyThisAgencysClient(organizationId: string, user: { id: string; email: string }): Promise<boolean> {
  const email = user.email.trim().toLowerCase();
  const contactOf = { revokedAt: null, OR: [{ email }, { userId: user.id }] };
  const [here, elsewhere, seat] = await Promise.all([
    prisma.clientPortalAccess.findFirst({ where: { organizationId, ...contactOf }, select: { id: true } }),
    prisma.clientPortalAccess.findFirst({
      where: { organizationId: { not: organizationId }, ...contactOf },
      select: { id: true },
    }),
    prisma.member.findFirst({ where: { userId: user.id }, select: { id: true } }),
  ]);
  return Boolean(here) && !elsewhere && !seat;
}

/** Never throws: anything unexpected leaves the link exactly as Better Auth built it. */
export async function agencyAuthLink(url: string, user: { id: string; email: string }): Promise<AuthLink> {
  try {
    const link = new URL(url);
    const callback = link.searchParams.get('callbackURL');
    // A relative callback ("/") stays on whichever host serves the link.
    if (!callback || !/^https?:\/\//i.test(callback)) {
      return { url, agency: null };
    }

    const found = await agencyForOrigin(callback);
    if (!found) {
      return { url, agency: null };
    }

    if (await onlyThisAgencysClient(found.agency.organizationId, user)) {
      const from = agencyFromHeader(found.agency.workspaceName);
      return {
        url: `${found.origin}${link.pathname}${link.search}`,
        agency: found.agency,
        ...(from ? { from } : {}),
      };
    }

    const moved = new URL(callback);
    link.searchParams.set('callbackURL', `${appOrigin()}${moved.pathname}${moved.search}${moved.hash}`);
    return { url: link.toString(), agency: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown error.';
    console.error(`[auth] could not place an emailed link on an agency domain: ${detail}`);
    return { url, agency: null };
  }
}
