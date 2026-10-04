import { prisma } from '../database/prisma.js';
import { env } from '../config/env.js';
import { queueEmail } from './email.service.js';
import { planLabel } from '../services/entitlements/plan-catalog.js';
import { resolveBranding } from '../services/branding.service.js';
import {
  domainVerificationNotice,
  erasureCompletedEmail,
  erasureScheduledEmail,
  exportReadyEmail,
  paymentFailedEmail,
  planChangedEmail,
  portalAccessGranted,
  subscriptionCancelledEmail,
  type BrandLook,
} from './templates.js';

/**
 * One function per transactional email, each looking up its own recipients.
 *
 * Keeping the lookups here means a caller only says what happened, never who to
 * email. That is what stops a new notification being wired to the wrong
 * audience, and it means every send has a single place to test.
 *
 * Each sender is fire and forget. A notification never blocks or fails the
 * action that triggered it.
 */

function appUrl(path = ''): string {
  return `${env.BETTER_AUTH_URL.replace(/\/$/, '')}${path}`;
}

/**
 * Runs a sender without ever rejecting.
 *
 * Every sender is fire and forget, and the call sites use `void`, which means
 * a rejected promise is unhandled. Wrapping the whole sender, not just the
 * delivery, matters: a sender does database lookups first, and a database
 * blip would otherwise surface as an unhandled rejection in production and
 * could be taken down by a process level unhandled rejection handler.
 *
 * A notification is never worth failing the action that triggered it. A domain
 * that just verified stays verified even if the confirmation email never
 * leaves the building.
 */
function fireAndForget(work: Promise<void>, label: string): void {
  void work.catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : 'Unknown mailer error.';
    console.error(`[email] ${label} failed: ${detail}`);
  });
}

/**
 * Everyone who should receive a workspace level transactional email.
 *
 * The role values are the lowercase keys registered in auth/permissions.ts:70
 * and stored verbatim in `Member.role` by Better Auth's organization plugin.
 * Comparing against 'OWNER' and 'ADMIN' matches nothing, so this returned an
 * empty list and every sender built on it silently did nothing: no domain
 * verification, no payment failure, no export link, and neither of the two
 * erasure notices, which are the ones a data protection regulator asks about.
 * The failure was invisible because every sender is fire and forget.
 */
async function ownersOf(organizationId: string): Promise<string[]> {
  const members = await prisma.member.findMany({
    where: { organizationId, role: { in: ['owner', 'admin'] } },
    select: { user: { select: { email: true } } },
  });
  return members.map((member) => member.user.email);
}

async function workspaceName(organizationId: string): Promise<string> {
  const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
  return organization?.name ?? 'your workspace';
}

/**
 * Tells a client contact that an agency has granted them portal access.
 *
 * This is the one client facing message, so it carries the agency's branding
 * rather than DMARC Harbor's. A customer receiving "DMARC Harbor" here would
 * reasonably assume the whole service belongs to the agency.
 */
export async function sendPortalAccessGrantedEmailImpl(input: {
  organizationId: string;
  clientId: string;
  contactEmail: string;
}): Promise<void> {
  const [client, organizationId, brand] = await Promise.all([
    prisma.client.findUnique({ where: { id: input.clientId }, select: { name: true } }),
    Promise.resolve(input.organizationId),
    resolveBranding(input.organizationId).catch(() => null),
  ]);

  if (!client) {
    return;
  }

  const look: BrandLook = {
    workspaceName: brand?.workspaceName ?? (await workspaceName(organizationId)),
    logoUrl: brand?.logoUrl ?? null,
    primaryColor: brand?.primaryColor ?? null,
    accentColor: brand?.accentColor ?? null,
  };

  queueEmail(
    portalAccessGranted({
      brand: look,
      clientName: client.name,
      agencyName: look.workspaceName,
      signInUrl: appUrl('/portal'),
    }),
    input.contactEmail,
  );
}

async function sendDomainVerificationEmailImpl(input: {
  organizationId: string;
  domainId: string;
  verified: boolean;
}): Promise<void> {
  const domain = await prisma.domain.findUnique({ where: { id: input.domainId }, select: { name: true } });
  if (!domain) {
    return;
  }

  const name = await workspaceName(input.organizationId);

  for (const email of await ownersOf(input.organizationId)) {
    queueEmail(
      domainVerificationNotice({
        workspaceName: name,
        domainName: domain.name,
        verified: input.verified,
        appUrl: appUrl(`/app/domains/${input.domainId}`),
      }),
      email,
      // One notice per domain per outcome, so a repeated background re-check
      // does not produce a second identical message.
      `domain-verified:${input.domainId}:${input.verified ? 'yes' : 'no'}:${domain.name}`,
    );
  }
}

async function sendPaymentFailedEmailImpl(input: {
  organizationId: string;
  plan: Parameters<typeof planLabel>[0];
  graceEndsAt: Date;
}): Promise<void> {
  const name = await workspaceName(input.organizationId);
  const billingUrl = appUrl('/app/billing');

  for (const email of await ownersOf(input.organizationId)) {
    queueEmail(
      paymentFailedEmail({
        workspaceName: name,
        planLabel: planLabel(input.plan),
        graceEndsAt: input.graceEndsAt.toISOString(),
        billingUrl,
      }),
      email,
    );
  }
}

async function sendSubscriptionCancelledEmailImpl(input: {
  organizationId: string;
  plan: Parameters<typeof planLabel>[0];
  accessUntil: Date;
}): Promise<void> {
  const name = await workspaceName(input.organizationId);

  for (const email of await ownersOf(input.organizationId)) {
    queueEmail(
      subscriptionCancelledEmail({
        workspaceName: name,
        planLabel: planLabel(input.plan),
        accessUntil: input.accessUntil.toISOString(),
        billingUrl: appUrl('/app/billing'),
      }),
      email,
    );
  }
}

async function sendPlanChangedEmailImpl(input: {
  organizationId: string;
  fromPlan: Parameters<typeof planLabel>[0];
  toPlan: Parameters<typeof planLabel>[0];
  effectiveAt: Date;
}): Promise<void> {
  const name = await workspaceName(input.organizationId);

  for (const email of await ownersOf(input.organizationId)) {
    queueEmail(
      planChangedEmail({
        workspaceName: name,
        fromLabel: planLabel(input.fromPlan),
        toLabel: planLabel(input.toPlan),
        effectiveAt: input.effectiveAt.toISOString(),
        billingUrl: appUrl('/app/billing'),
      }),
      email,
    );
  }
}

async function sendExportReadyEmailImpl(input: {
  organizationId: string;
  exportJobId: string;
  scopeLabel: string;
  downloadUrl: string;
  expiresAt: Date;
}): Promise<void> {
  const name = await workspaceName(input.organizationId);

  for (const email of await ownersOf(input.organizationId)) {
    queueEmail(
      exportReadyEmail({
        workspaceName: name,
        scopeLabel: input.scopeLabel,
        downloadUrl: input.downloadUrl,
        expiresAt: input.expiresAt.toISOString(),
      }),
      email,
    );
  }

  void input.exportJobId;
}

async function sendErasureScheduledEmailImpl(input: {
  organizationId: string;
  scopeLabel: string;
  executesAt: Date;
  cancelUrl: string;
}): Promise<void> {
  const name = await workspaceName(input.organizationId);

  for (const email of await ownersOf(input.organizationId)) {
    queueEmail(
      erasureScheduledEmail({
        workspaceName: name,
        scopeLabel: input.scopeLabel,
        executesAt: input.executesAt.toISOString(),
        cancelUrl: input.cancelUrl,
      }),
      email,
    );
  }
}

async function sendErasureCompletedEmailImpl(input: {
  organizationId: string;
  scopeLabel: string;
  completedAt: Date;
}): Promise<void> {
  const name = await workspaceName(input.organizationId);

  for (const email of await ownersOf(input.organizationId)) {
    queueEmail(
      erasureCompletedEmail({
        workspaceName: name,
        scopeLabel: input.scopeLabel,
        completedAt: input.completedAt.toISOString(),
      }),
      email,
    );
  }
}

/* --------------------------------------------------------- safe public API */

/**
 * Each sender is wrapped so a caller cannot get a rejected promise. The public
 * names are the ones other services import, and none of them can fail.
 */
export function sendPortalAccessGrantedEmail(input: Parameters<typeof sendPortalAccessGrantedEmailImpl>[0]): void {
  fireAndForget(sendPortalAccessGrantedEmailImpl(input), 'sendPortalAccessGrantedEmail');
}

export function sendDomainVerificationEmail(input: Parameters<typeof sendDomainVerificationEmailImpl>[0]): void {
  fireAndForget(sendDomainVerificationEmailImpl(input), 'sendDomainVerificationEmail');
}

export function sendPaymentFailedEmail(input: Parameters<typeof sendPaymentFailedEmailImpl>[0]): void {
  fireAndForget(sendPaymentFailedEmailImpl(input), 'sendPaymentFailedEmail');
}

export function sendSubscriptionCancelledEmail(input: Parameters<typeof sendSubscriptionCancelledEmailImpl>[0]): void {
  fireAndForget(sendSubscriptionCancelledEmailImpl(input), 'sendSubscriptionCancelledEmail');
}

export function sendPlanChangedEmail(input: Parameters<typeof sendPlanChangedEmailImpl>[0]): void {
  fireAndForget(sendPlanChangedEmailImpl(input), 'sendPlanChangedEmail');
}

export function sendExportReadyEmail(input: Parameters<typeof sendExportReadyEmailImpl>[0]): void {
  fireAndForget(sendExportReadyEmailImpl(input), 'sendExportReadyEmail');
}

export function sendErasureScheduledEmail(input: Parameters<typeof sendErasureScheduledEmailImpl>[0]): void {
  fireAndForget(sendErasureScheduledEmailImpl(input), 'sendErasureScheduledEmail');
}

export function sendErasureCompletedEmail(input: Parameters<typeof sendErasureCompletedEmailImpl>[0]): void {
  fireAndForget(sendErasureCompletedEmailImpl(input), 'sendErasureCompletedEmail');
}
