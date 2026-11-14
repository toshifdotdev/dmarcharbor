import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { acceptableOrigin, candidateOrigins, lookupAgencyHost, type AgencyHost } from './agency-origin.js';

/**
 * Who may sign in on an agency's own domain.
 *
 * The agency, not we, decides where its domain points, so it can at any time
 * serve its own page there: the password typed in and the session cookie set on
 * that host are then the agency's to read. For the agency's own team and its
 * own client contacts that gives the agency nothing it does not already have.
 * For a person with a seat in another workspace, or a portal grant from another
 * agency, it would hand this agency a session that opens those too, because a
 * session is for the account and not for the host it was made on.
 *
 * So a session is made on agency A's domain only for an account whose seats
 * are all in A and whose portal grants are all from A. Anyone else is told to
 * sign in on our address, where the same account works as before.
 */

export const agencyDomainSignInMessage =
  // Shown on the agency's own domain, so it names no product.
  'This account is also used by another organisation, so it cannot sign in at this address. Sign in at the address you use for your own workspace instead.';

/** The verified agency domain these request headers came through, if any. Never throws. */
export async function agencyHostForHeaders(headers: Headers | null | undefined): Promise<AgencyHost | null> {
  try {
    if (!headers || typeof headers.get !== 'function') {
      return null;
    }
    for (const candidate of candidateOrigins(headers)) {
      const accepted = acceptableOrigin(candidate);
      if (!accepted || env.CORS_ORIGINS.includes(accepted.origin)) {
        continue;
      }
      const agency = await lookupAgencyHost(accepted.hostname);
      if (agency) {
        return agency;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** True when the account holds a seat or a live portal grant outside this agency. */
export async function servedOutsideAgency(organizationId: string, user: { id: string; email: string }): Promise<boolean> {
  const email = user.email.trim().toLowerCase();
  const [seat, grant] = await Promise.all([
    prisma.member.findFirst({ where: { userId: user.id, organizationId: { not: organizationId } }, select: { id: true } }),
    prisma.clientPortalAccess.findFirst({
      where: { organizationId: { not: organizationId }, revokedAt: null, OR: [{ email }, { userId: user.id }] },
      select: { id: true },
    }),
  ]);
  return Boolean(seat) || Boolean(grant);
}

/**
 * Null when a session may be made for this request, or the agency whose domain
 * refused it. A request with no context or no agency host (our own address,
 * server-side calls) is never refused here.
 */
export async function agencyDomainSessionRefusal(
  userId: string,
  headers: Headers | null | undefined,
): Promise<AgencyHost | null> {
  const agency = await agencyHostForHeaders(headers);
  if (!agency) {
    return null;
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user || !(await servedOutsideAgency(agency.organizationId, user))) {
    return null;
  }
  try {
    await recordAuditEvent({
      actorUserId: userId,
      action: 'AGENCY_DOMAIN_SIGN_IN_REFUSED',
      targetType: 'user',
      targetId: userId,
      detail: { agencyOrganizationId: agency.organizationId },
    });
  } catch (error) {
    console.error('[auth] could not record a refused agency-domain sign-in', error);
  }
  return agency;
}
