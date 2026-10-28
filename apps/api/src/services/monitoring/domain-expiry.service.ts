import { createHash } from 'node:crypto';
import type { DomainRegistration, NotificationSeverity } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { domainExpiryEmail } from '../../email/templates.js';
import { queueEmail } from '../../email/email.service.js';
import { isWithinQuietHours } from '../alert.service.js';
import { organizationalDomain } from '../alignment.service.js';
import { domainRef } from '../domain-ref.js';
import { resolveEntitlements } from '../entitlements/entitlement.service.js';
import { deliverSlackAlert, hasEnabledSlackDestination } from '../slack.service.js';
import { deliverTeamsAlert, hasEnabledTeamsDestination } from '../teams.service.js';
import { lookupRegistration, type RdapResult } from './rdap.js';

/**
 * Domain-expiry alerts.
 *
 * A domain whose registration lapses stops resolving: mail to and from it
 * fails, its DMARC, SPF and DKIM records vanish with it, and reports stop
 * arriving. It is the one DNS failure no record change can fix, and it is
 * entirely predictable, so the workspace is told at 30, 14, 7 and 1 days, and
 * once on the day it lapses.
 *
 * Two halves, both in one hourly pass:
 *
 * 1. Lookups. Each verified domain is read over RDAP about once a day, a batch
 *    per pass. The date is stored even on plans without alerts, because the
 *    domain page shows it to everyone.
 * 2. Warnings. Every stored expiry inside 30 days is compared with the ladder.
 *    A warning is claimed by a conditional update on the row before anything is
 *    sent, so two replicas cannot both send it, and a renewal (a new expiry
 *    date) starts the ladder again.
 */

export const expiryThresholds = [30, 14, 7, 1, 0] as const;
const dayMs = 24 * 60 * 60 * 1000;
/** How long a lookup is trusted before the domain is read again. */
const recheckMs = dayMs;

export interface DomainExpiryOutcome {
  checked: number;
  failed: number;
  warned: number;
  notifications: number;
  emails: number;
  slack: number;
  teams: number;
}

export interface DomainRegistrationView {
  registrableDomain: string;
  status: string;
  expiresAt: string | null;
  daysLeft: number | null;
  registrar: string | null;
  checkedAt: string;
  lastError: string | null;
}

/** Whole days from now to the expiry; negative once it has passed. */
export function daysUntil(expiresAt: Date, now: Date): number {
  return Math.floor((expiresAt.getTime() - now.getTime()) / dayMs);
}

/**
 * The tightest rung of the ladder the domain has reached, or null.
 *
 * 0 means expired or expiring today. A domain first seen at 5 days left gets
 * the 7-day warning, not every rung it skipped.
 */
export function thresholdFor(daysLeft: number): number | null {
  const reached = expiryThresholds.filter((threshold) => daysLeft <= threshold);
  return reached.length > 0 ? Math.min(...reached) : null;
}

/** 7 days and less is critical: renewing can take a registrar a few days. */
export function severityFor(threshold: number): NotificationSeverity {
  return threshold <= 7 ? 'CRITICAL' : 'WARNING';
}

function dateLabel(value: Date): string {
  return value.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** One plain sentence about one domain, used by every channel. */
export function expirySentence(input: {
  domainName: string;
  registrableDomain: string;
  expiresAt: Date;
  daysLeft: number;
}): string {
  const subject =
    input.registrableDomain === input.domainName
      ? 'The registration'
      : `The registration of ${input.registrableDomain}`;
  const when = dateLabel(input.expiresAt);
  if (input.daysLeft < 0) {
    const ago = -input.daysLeft;
    return `${input.domainName}: ${subject} expired on ${when}, ${ago} day${ago === 1 ? '' : 's'} ago.`;
  }
  if (input.daysLeft === 0) {
    return `${input.domainName}: ${subject} expires today, ${when}.`;
  }
  return `${input.domainName}: ${subject} expires in ${input.daysLeft} day${input.daysLeft === 1 ? '' : 's'}, on ${when}.`;
}

export function registrationView(row: DomainRegistration, now: Date = new Date()): DomainRegistrationView {
  return {
    registrableDomain: row.registrableDomain,
    status: row.status,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    daysLeft: row.expiresAt ? daysUntil(row.expiresAt, now) : null,
    registrar: row.registrar,
    checkedAt: row.checkedAt.toISOString(),
    lastError: row.lastError,
  };
}

/** The view for one domain in a workspace, or undefined when the domain is not there. */
export async function getDomainRegistration(
  organizationId: string,
  domainIdOrSlug: string,
): Promise<DomainRegistrationView | null | undefined> {
  const domain = await prisma.domain.findFirst({
    where: { client: { organizationId }, ...domainRef(domainIdOrSlug) },
    select: { id: true, registration: true },
  });
  if (!domain) return undefined;
  return domain.registration ? registrationView(domain.registration) : null;
}

// ─── lookups ────────────────────────────────────────────────────────────────

/**
 * Writes one lookup to the row.
 *
 * A failed lookup keeps the last good date: "the registry did not answer
 * today" is not "the domain has no expiry", and wiping the date would silence
 * the ladder on exactly the day a registry is having trouble.
 */
async function storeLookup(domainId: string, registrableDomain: string, result: RdapResult, now: Date) {
  const keepPrevious = result.status === 'error';
  await prisma.domainRegistration.upsert({
    where: { domainId },
    create: {
      domainId,
      registrableDomain,
      status: result.status,
      expiresAt: result.expiresAt,
      registrar: result.registrar,
      checkedAt: now,
      lastError: result.error,
    },
    update: keepPrevious
      ? { registrableDomain, checkedAt: now, lastError: result.error }
      : {
          registrableDomain,
          status: result.status,
          expiresAt: result.expiresAt,
          registrar: result.registrar,
          checkedAt: now,
          lastError: result.error,
        },
  });
}

async function runLookups(now: Date, outcome: DomainExpiryOutcome): Promise<void> {
  // Never-checked domains first, then the stalest, so a big backlog drains in
  // a predictable order. Two reads, because ordering by a relation that does
  // not exist yet would put the never-checked ones last.
  const limit = env.DOMAIN_EXPIRY_BATCH_SIZE;
  const unchecked = await prisma.domain.findMany({
    where: { status: 'VERIFIED', registration: { is: null } },
    select: { id: true, name: true },
    orderBy: { id: 'asc' },
    take: limit,
  });
  const stale =
    unchecked.length < limit
      ? await prisma.domainRegistration.findMany({
          where: { checkedAt: { lt: new Date(now.getTime() - recheckMs) }, domain: { status: 'VERIFIED' } },
          select: { domain: { select: { id: true, name: true } } },
          orderBy: [{ checkedAt: 'asc' }, { id: 'asc' }],
          take: limit - unchecked.length,
        })
      : [];
  const due = [...unchecked, ...stale.map((row) => row.domain)];

  // `mail.acme.com` and `acme.com` are one registration: asked once per pass.
  const results = new Map<string, RdapResult>();
  for (const domain of due) {
    const registrable = organizationalDomain(domain.name) || domain.name;
    let result = results.get(registrable);
    if (!result) {
      result = await lookupRegistration(registrable, now);
      results.set(registrable, result);
    }
    try {
      await storeLookup(domain.id, registrable, result, now);
      if (result.status === 'error') outcome.failed += 1;
      else outcome.checked += 1;
    } catch (error) {
      outcome.failed += 1;
      console.warn(
        `[domain-expiry] could not store the lookup for ${domain.name}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}

// ─── warnings ───────────────────────────────────────────────────────────────

interface ClaimedWarning {
  registrationId: string;
  organizationId: string;
  organizationName: string;
  domainName: string;
  domainSlug: string;
  registrableDomain: string;
  registrar: string | null;
  expiresAt: Date;
  daysLeft: number;
  threshold: number;
}

/** Finds every rung newly reached and claims it, once, across replicas. */
async function claimWarnings(now: Date): Promise<ClaimedWarning[]> {
  const rows = await prisma.domainRegistration.findMany({
    where: {
      expiresAt: { not: null, lte: new Date(now.getTime() + (expiryThresholds[0] + 1) * dayMs) },
      domain: { status: 'VERIFIED' },
    },
    select: {
      id: true,
      expiresAt: true,
      registrableDomain: true,
      registrar: true,
      warnedThreshold: true,
      warnedForExpiry: true,
      domain: {
        select: {
          name: true,
          slug: true,
          client: { select: { organizationId: true, organization: { select: { name: true } } } },
        },
      },
    },
  });

  const claimed: ClaimedWarning[] = [];
  for (const row of rows) {
    const expiresAt = row.expiresAt!;
    const daysLeft = daysUntil(expiresAt, now);
    const threshold = thresholdFor(daysLeft);
    if (threshold === null) continue;

    const sameExpiry = row.warnedForExpiry?.getTime() === expiresAt.getTime();
    if (sameExpiry && row.warnedThreshold !== null && row.warnedThreshold <= threshold) continue;

    // The claim is the send decision. Conditional on what was read, so a
    // second replica (or a second pass) reading the same row claims nothing.
    const claim = await prisma.domainRegistration.updateMany({
      where: {
        id: row.id,
        expiresAt,
        warnedThreshold: row.warnedThreshold,
        warnedForExpiry: row.warnedForExpiry,
      },
      data: { warnedThreshold: threshold, warnedForExpiry: expiresAt },
    });
    if (claim.count !== 1) continue;

    claimed.push({
      registrationId: row.id,
      organizationId: row.domain.client.organizationId,
      organizationName: row.domain.client.organization.name,
      domainName: row.domain.name,
      domainSlug: row.domain.slug,
      registrableDomain: row.registrableDomain,
      registrar: row.registrar,
      expiresAt,
      daysLeft,
      threshold,
    });
  }
  return claimed;
}

interface Recipient {
  user: {
    id: string;
    email: string;
    notificationPreference: {
      emailAlerts: boolean;
      quietHoursStart: string | null;
      quietHoursEnd: string | null;
      onlyHighRiskAlerts: boolean;
      timezone: string;
    } | null;
  };
}

/**
 * Tells one workspace about the warnings claimed for it.
 *
 * The same people and the same plan gate as DNS-change alerts: owners and
 * admins, on a plan with alerts. One email, one Slack post and one Teams post
 * per workspace per pass, listing every domain, rather than one per domain.
 * Each channel fails on its own; none of them un-claims the warning, because a
 * missed message is better than the same one every hour.
 */
async function deliverWarnings(
  organizationId: string,
  warnings: ClaimedWarning[],
  now: Date,
  outcome: DomainExpiryOutcome,
): Promise<void> {
  const entitlements = await resolveEntitlements(organizationId, now);
  if (!entitlements.features['alerts.email']) return;

  const members = (await prisma.member.findMany({
    where: { organizationId, role: { in: ['owner', 'admin'] } },
    select: {
      user: {
        select: {
          id: true,
          email: true,
          notificationPreference: {
            select: {
              emailAlerts: true,
              quietHoursStart: true,
              quietHoursEnd: true,
              onlyHighRiskAlerts: true,
              timezone: true,
            },
          },
        },
      },
    },
  })) as Recipient[];

  const workspaceName = warnings[0]?.organizationName ?? 'your workspace';
  const sentences = warnings.map((warning) => ({ warning, sentence: expirySentence(warning) }));

  if (members.length > 0) {
    try {
      const created = await prisma.notification.createMany({
        data: members.flatMap((member) =>
          sentences.map(({ warning, sentence }) => ({
            userId: member.user.id,
            organizationId,
            kind: 'DOMAIN_EXPIRY' as const,
            severity: severityFor(warning.threshold),
            title:
              warning.daysLeft < 0
                ? `${warning.domainName}: registration expired`
                : `${warning.domainName}: registration expires soon`,
            body: `${sentence}${warning.registrar ? ` Registrar: ${warning.registrar}.` : ''}`,
            link: `/domains/${warning.domainSlug}`,
            domainRegistrationId: warning.registrationId,
          })),
        ),
      });
      outcome.notifications += created.count;
    } catch (error) {
      console.error(
        `[domain-expiry] in-app notifications failed for ${organizationId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  for (const member of members) {
    const preference = member.user.notificationPreference;
    if (preference && !preference.emailAlerts) continue;
    if (
      preference &&
      isWithinQuietHours(preference.quietHoursStart, preference.quietHoursEnd, now, preference.timezone)
    ) {
      continue;
    }
    const included = preference?.onlyHighRiskAlerts
      ? sentences.filter(({ warning }) => severityFor(warning.threshold) === 'CRITICAL')
      : sentences;
    if (included.length === 0) continue;

    try {
      queueEmail(
        domainExpiryEmail({
          workspaceName,
          appUrl: env.APP_URL,
          domains: included.map(({ warning, sentence }) => ({
            domainSlug: warning.domainSlug,
            sentence,
            registrar: warning.registrar,
          })),
        }),
        member.user.email,
        // One per set of rungs per person: a retry of the same pass is the same
        // email, a later rung is a new one.
        `domain-expiry:${createHash('sha256')
          .update(included.map(({ warning }) => `${warning.registrationId}.${warning.threshold}.${warning.expiresAt.toISOString()}`).join(','))
          .digest('hex')
          .slice(0, 32)}:${member.user.id}`,
      );
      outcome.emails += 1;
    } catch (error) {
      console.error(
        `[domain-expiry] email to ${member.user.email} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  const listed = sentences.slice(0, 10).map(({ sentence }) => sentence);
  const more = sentences.length > 10 ? [`and ${sentences.length - 10} more`] : [];
  const subject =
    sentences.length === 1
      ? warnings[0]!.daysLeft < 0
        ? `${warnings[0]!.domainName}: registration expired`
        : `${warnings[0]!.domainName}: registration expires in ${warnings[0]!.daysLeft} day${warnings[0]!.daysLeft === 1 ? '' : 's'}`
      : `${sentences.length} domain registrations expire soon in ${workspaceName}`;
  const body = [...listed, ...more, 'Renew with the registrar, or confirm auto-renew is on.'].join('\n');
  const risk = warnings.some((warning) => severityFor(warning.threshold) === 'CRITICAL') ? 'high' : 'medium';

  try {
    if (await hasEnabledSlackDestination(organizationId)) {
      const result = await deliverSlackAlert({
        organizationId,
        message: { subject, body, domainName: warnings[0]!.domainName, risk },
      });
      if (result.delivered) outcome.slack += 1;
    }
  } catch (error) {
    console.error(
      `[domain-expiry] Slack delivery failed for ${organizationId}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  try {
    if (await hasEnabledTeamsDestination(organizationId)) {
      const result = await deliverTeamsAlert({
        organizationId,
        message: {
          subject,
          body,
          domainName: warnings[0]!.domainName,
          workspaceName,
          risk,
          linkPath: `/domains/${warnings[0]!.domainSlug}`,
        },
      });
      if (result.delivered) outcome.teams += 1;
    }
  } catch (error) {
    console.error(
      `[domain-expiry] Teams delivery failed for ${organizationId}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

/** One pass: a batch of lookups, then every newly reached warning. */
export async function runDomainExpiryPass(now: Date = new Date()): Promise<DomainExpiryOutcome> {
  const outcome: DomainExpiryOutcome = {
    checked: 0,
    failed: 0,
    warned: 0,
    notifications: 0,
    emails: 0,
    slack: 0,
    teams: 0,
  };
  if (!env.DOMAIN_EXPIRY_ENABLED) return outcome;

  await runLookups(now, outcome);

  const claimed = await claimWarnings(now);
  outcome.warned = claimed.length;

  const byOrganization = new Map<string, ClaimedWarning[]>();
  for (const warning of claimed) {
    byOrganization.set(warning.organizationId, [...(byOrganization.get(warning.organizationId) ?? []), warning]);
  }
  for (const [organizationId, warnings] of byOrganization) {
    warnings.sort((a, b) => a.daysLeft - b.daysLeft || a.domainName.localeCompare(b.domainName));
    try {
      await deliverWarnings(organizationId, warnings, now, outcome);
    } catch (error) {
      console.error(
        `[domain-expiry] delivery failed for ${organizationId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  return outcome;
}
