import { env } from '../config/env.js';
import { resolveBranding, type ResolvedBranding } from './branding.service.js';

/**
 * The origin an agency's clients are sent to.
 *
 * Every link a client receives (the portal invitation, an approval request, a
 * monthly report, a share link, a Trust Center, a prospect report) is built on
 * this. On a workspace that serves its clients on its own verified domain it is
 * that domain, so a client who has only ever seen the agency's brand is never
 * handed our address. Everywhere else it is APP_URL.
 *
 * Links for the agency's own staff (alerts, billing, team invitations, exports,
 * erasure) stay on APP_URL, because staff use our app and not the white label.
 */

/** APP_URL without a trailing slash, so a path can be appended to it. */
export function appOrigin(): string {
  return env.APP_URL.replace(/\/+$/, '');
}

/**
 * The same answer from branding already resolved, for callers that need the
 * branding anyway and should not read it twice.
 *
 * `customDomain` is only set by `resolveBranding` when the plan includes the
 * custom domain and its DNS record has been verified, so nothing else needs
 * checking here.
 */
export function clientOriginFor(branding: Pick<ResolvedBranding, 'customDomain'> | null | undefined): string {
  return branding?.customDomain ? `https://${branding.customDomain}` : appOrigin();
}

export async function clientOrigin(organizationId: string): Promise<string> {
  return clientOriginFor(await resolveBranding(organizationId));
}
