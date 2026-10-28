import type { PlanTier } from '@prisma/client';
import { prisma } from '../../database/prisma.js';
import { sendPlanPausedFeaturesEmail } from '../../email/mailer.js';
import { resolveEntitlements } from './entitlement.service.js';

/**
 * How long existing members can keep signing in through a workspace's SSO
 * connection after its plan stops including single sign-on.
 *
 * People who joined through SSO have no password. Switching their connection
 * off on the day of a downgrade would lock them out with no warning, so they
 * get a month to sign in once and set a password, which Forgot password does
 * for an account that has never had one.
 */
export const SSO_DOWNGRADE_GRACE_DAYS = 30;

const dayMs = 24 * 60 * 60 * 1000;

/** The last moment existing members can sign in through SSO, counted from when the plan lost it. */
export function ssoSignInUntil(unlicensedSince: Date): Date {
  return new Date(unlicensedSince.getTime() + SSO_DOWNGRADE_GRACE_DAYS * dayMs);
}

/**
 * Records, or clears, the day a workspace's SSO connections stopped being in its
 * plan. Only an unset date is written, so repeated calls never move the start of
 * the grace period. Returns the date in force, or null when SSO is included.
 */
export async function syncSsoLicence(organizationId: string, licensed: boolean, now = new Date()): Promise<Date | null> {
  if (licensed) {
    await prisma.ssoConnection.updateMany({
      where: { organizationId, unlicensedSince: { not: null } },
      data: { unlicensedSince: null },
    });
    return null;
  }

  await prisma.ssoConnection.updateMany({
    where: { organizationId, unlicensedSince: null },
    data: { unlicensedSince: now },
  });
  const earliest = await prisma.ssoConnection.findFirst({
    where: { organizationId, unlicensedSince: { not: null } },
    orderBy: { unlicensedSince: 'asc' },
    select: { unlicensedSince: true },
  });
  return earliest?.unlicensedSince ?? null;
}

const hostedKinds = [
  { feature: 'dns.hosted', one: 'hosted DMARC record', many: 'hosted DMARC records' },
  { feature: 'dns.managedSpf', one: 'managed SPF record', many: 'managed SPF records' },
  { feature: 'dns.hostedBimi', one: 'hosted BIMI record', many: 'hosted BIMI records' },
  { feature: 'dns.hostedMtaSts', one: 'hosted MTA-STS policy', many: 'hosted MTA-STS policies' },
] as const;

async function countHosted(feature: (typeof hostedKinds)[number]['feature'], organizationId: string): Promise<number> {
  const where = { organizationId, status: { not: 'RELEASED' as const } };
  switch (feature) {
    case 'dns.hosted':
      return prisma.hostedDmarcRecord.count({ where });
    case 'dns.managedSpf':
      return prisma.hostedSpfRecord.count({ where });
    case 'dns.hostedBimi':
      return prisma.hostedBimiRecord.count({ where });
    case 'dns.hostedMtaSts':
      return prisma.hostedMtaStsRecord.count({ where });
  }
}

/**
 * What every plan change does once it has been written.
 *
 * Called after the change commits, by every path that changes a plan: billing
 * webhooks and reconciliation, a due pending downgrade, dunning, a self-serve
 * change applied at once, and staff. Rows are never removed here. The workspace
 * keeps what it set up; this records when SSO stopped being included and tells
 * the owners, once, about anything still running that the new plan no longer
 * lets them change.
 *
 * Never throws. A plan change that has already been written must not be
 * reported as failed because a follow-up could not run.
 */
export async function afterPlanChange(
  organizationId: string,
  change: { from: PlanTier | null; to: PlanTier },
  now = new Date(),
): Promise<void> {
  try {
    const entitlements = await resolveEntitlements(organizationId, now);
    const features = entitlements.features as Record<string, boolean>;

    const ssoSince = await syncSsoLicence(organizationId, features['auth.sso'] === true, now);

    if (change.from === change.to) {
      return;
    }

    const hostedRecords: string[] = [];
    for (const kind of hostedKinds) {
      if (features[kind.feature]) continue;
      const count = await countHosted(kind.feature, organizationId);
      if (count > 0) hostedRecords.push(`${count} ${count === 1 ? kind.one : kind.many}`);
    }

    const ssoConnections = ssoSince
      ? await prisma.ssoConnection.count({ where: { organizationId, enabled: true } })
      : 0;
    const sso = ssoSince && ssoConnections > 0 ? { connections: ssoConnections, signInUntil: ssoSignInUntil(ssoSince) } : null;

    if (hostedRecords.length === 0 && !sso) {
      return;
    }

    await sendPlanPausedFeaturesEmail({
      organizationId,
      plan: entitlements.plan,
      hostedRecords,
      sso,
      // One message per change to a plan per day. A webhook and the
      // reconciliation that follows it describe the same change.
      idempotencyKey: `plan-paused:${organizationId}:${change.from ?? 'none'}:${change.to}:${now.toISOString().slice(0, 10)}`,
    });
  } catch (error) {
    console.error(`[billing] after-plan-change follow-up failed for ${organizationId}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
