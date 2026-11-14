import { prisma } from '../database/prisma.js';
import { agencyFromHeader, clientEmailHeaders } from '../email/sender.js';
import type { BrandLook } from '../email/templates.js';
import { resolveBranding } from '../services/branding.service.js';
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
 * Only for an active portal contact of one of the agency's clients who holds no
 * seat in any workspace. The callback was checked against the request's trusted
 * origins, but the headers that check reads are the caller's to choose when the
 * caller is not a browser, and the agency, not we, decides where its domain
 * points. So the token in the link can reach the agency.
 *
 * For its own client contact that gives the agency nothing new: the contact
 * signs in on the agency's domain anyway, because every invitation and report
 * link the agency sends points there, so the agency already hosts the form the
 * password is typed into. That holds for a contact another agency also serves.
 * It does not hold for anyone with a seat (staff sign in on our address, and a
 * seat can reach other workspaces) or for a stranger. For them the callback is
 * moved to our app origin with the same path, so the link keeps working and the
 * token goes only to us.
 */

export interface AuthLink {
  url: string;
  /** The agency the link was rebuilt for, or null when it was left on our host. */
  agency: AgencyHost | null;
  /** The agency's From header, when the link was rebuilt for one. */
  from?: string;
  /** The agency's published support address as Reply-To, when it has one. */
  replyTo?: string;
  /** The same address, for the "Questions?" line at the end of the message. */
  supportEmail?: string;
  /**
   * The agency's look for the message's HTML, when the link was rebuilt for
   * one: its logo and colours under white label, its name alone otherwise.
   */
  brand?: BrandLook;
}

/**
 * True for a client contact of this agency only: no seat in any workspace and
 * no portal grant from another agency.
 *
 * The second condition matters because an agency can add any address as a
 * contact of one of its clients, and the agency controls the DNS of its own
 * domain. Had a contact of agency B been added by agency A as well, a reset
 * requested on A's domain would have put B's contact's reset link (and with it
 * B's client data) on infrastructure A controls. A link moves to an agency's
 * domain only when that agency is the one serving the person.
 */
async function agencyClientWithoutSeat(organizationId: string, user: { id: string; email: string }): Promise<boolean> {
  const email = user.email.trim().toLowerCase();
  const [contact, seat, elsewhere] = await Promise.all([
    prisma.clientPortalAccess.findFirst({
      where: { organizationId, revokedAt: null, OR: [{ email }, { userId: user.id }] },
      select: { id: true },
    }),
    prisma.member.findFirst({ where: { userId: user.id }, select: { id: true } }),
    prisma.clientPortalAccess.findFirst({
      where: { organizationId: { not: organizationId }, revokedAt: null, OR: [{ email }, { userId: user.id }] },
      select: { id: true },
    }),
  ]);
  return Boolean(contact) && !seat && !elsewhere;
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

    if (await agencyClientWithoutSeat(found.agency.organizationId, user)) {
      // The agency's verified sending address and published support contact,
      // read only once the contact has passed the check above. A branding read
      // that fails still sends the link in the agency's name from the shared
      // address, rather than losing the rebuilt link with it.
      const branding = await resolveBranding(found.agency.organizationId).catch(() => null);
      const headers: { from?: string; replyTo?: string } = branding?.branded
        ? clientEmailHeaders(branding)
        : { from: agencyFromHeader(found.agency.workspaceName) };
      // resolveBranding already withholds the logo and colours below white
      // label, and serves only a logo stored on our own origin.
      const brand: BrandLook = {
        workspaceName: found.agency.workspaceName,
        logoUrl: branding?.branded ? branding.logoUrl : null,
        primaryColor: branding?.branded ? branding.primaryColor : null,
        accentColor: branding?.branded ? branding.accentColor : null,
      };
      return {
        url: `${found.origin}${link.pathname}${link.search}`,
        agency: found.agency,
        ...(headers.from ? { from: headers.from } : {}),
        ...(headers.replyTo ? { replyTo: headers.replyTo, supportEmail: headers.replyTo } : {}),
        brand,
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
