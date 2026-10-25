import type { DnsChangeSeverity } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { dnsChangesEmail } from '../../email/templates.js';
import { queueEmail } from '../../email/email.service.js';
import { isWithinQuietHours } from '../alert.service.js';
import { resolveEntitlements } from '../entitlements/entitlement.service.js';
import { deliverSlackAlert, hasEnabledSlackDestination } from '../slack.service.js';

export interface DnsChangeDeliveryOutcome {
  claimed: number;
  notifications: number;
  emails: number;
  slack: number;
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
 * Delivers the changes recorded in this monitoring pass.
 *
 * The claim happens before any outbound work, so two replicas cannot send the
 * same change twice. A delivery failure never un-claims it: a missed
 * notification is better than a duplicate storm, and the history still shows
 * what changed.
 */
export async function deliverDnsChangeNotifications(
  now = new Date(),
): Promise<DnsChangeDeliveryOutcome> {
  // INFO is history only, but it is marked so it is never reconsidered.
  await prisma.dnsChange.updateMany({
    where: { severity: 'INFO', notifiedAt: null },
    data: { notifiedAt: now },
  });

  const candidates = await prisma.dnsChange.findMany({
    where: { severity: { in: ['WARNING', 'CRITICAL'] }, notifiedAt: null },
    select: { id: true, organizationId: true },
    orderBy: [{ organizationId: 'asc' }, { detectedAt: 'asc' }, { id: 'asc' }],
  });

  const byOrganization = new Map<string, string[]>();
  for (const candidate of candidates) {
    byOrganization.set(candidate.organizationId, [
      ...(byOrganization.get(candidate.organizationId) ?? []),
      candidate.id,
    ]);
  }

  const outcome: DnsChangeDeliveryOutcome = { claimed: 0, notifications: 0, emails: 0, slack: 0 };

  for (const [organizationId] of byOrganization) {
    /**
     * One conditional claim for the whole workspace.
     *
     * A per-row claim lets two concurrent passes split the rows between them,
     * which turns one pass into two emails. The workspace-scoped statement is
     * atomic: the loser re-evaluates after the winner's update and claims
     * nothing.
     */
    const claim = await prisma.dnsChange.updateMany({
      where: {
        organizationId,
        severity: { in: ['WARNING', 'CRITICAL'] },
        notifiedAt: null,
      },
      data: { notifiedAt: now },
    });

    if (claim.count === 0) {
      continue;
    }

    outcome.claimed += claim.count;

    const changes = await prisma.dnsChange.findMany({
      where: {
        organizationId,
        severity: { in: ['WARNING', 'CRITICAL'] },
        notifiedAt: now,
      },
      select: {
        id: true,
        severity: true,
        summary: true,
        domain: { select: { id: true, name: true, slug: true } },
        organization: { select: { id: true, name: true } },
      },
      orderBy: [{ detectedAt: 'asc' }, { id: 'asc' }],
    });

    const entitlements = await resolveEntitlements(organizationId, now);
    if (!entitlements.features['alerts.email']) {
      // History remains; notification is a paid feature and this workspace has
      // none. The rows stay claimed so nothing is retried later.
      continue;
    }

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

    if (members.length === 0) {
      continue;
    }

    const workspaceName = changes[0]?.organization.name ?? 'your workspace';

    try {
      const created = await prisma.notification.createMany({
        data: members.flatMap((member) =>
          changes.map((change) => ({
            userId: member.user.id,
            organizationId,
            kind: 'DNS_CHANGE' as const,
            severity: change.severity as DnsChangeSeverity,
            title: `${change.domain.name}: DNS changed`,
            body: change.summary,
            link: `/domains/${change.domain.slug}`,
            dnsChangeId: change.id,
          })),
        ),
        skipDuplicates: true,
      });
      outcome.notifications += created.count;
    } catch (error) {
      console.error(
        `[dns-monitor] in-app notifications failed for ${organizationId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    const appUrl = env.APP_URL;

    for (const member of members) {
      const preference = member.user.notificationPreference;
      if (preference && !preference.emailAlerts) {
        continue;
      }
      if (
        preference &&
        isWithinQuietHours(preference.quietHoursStart, preference.quietHoursEnd, now, preference.timezone)
      ) {
        continue;
      }

      const included = preference?.onlyHighRiskAlerts
        ? changes.filter((change) => change.severity === 'CRITICAL')
        : changes;
      if (included.length === 0) {
        continue;
      }

      try {
        const rendered = dnsChangesEmail({
          workspaceName,
          appUrl,
          changes: included.map((change) => ({
            domainName: change.domain.name,
            domainSlug: change.domain.slug,
            summary: change.summary,
          })),
        });
        queueEmail(
          rendered,
          member.user.email,
          `dns-changes:${organizationId}:${included[0]!.id}:${member.user.id}`,
        );
        outcome.emails += 1;
      } catch (error) {
        console.error(
          `[dns-monitor] email to ${member.user.email} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }

    try {
      if (await hasEnabledSlackDestination(organizationId)) {
        const listed = changes
          .slice(0, 10)
          .map((change) => `${change.domain.name}: ${change.summary}`);
        const more = changes.length > 10 ? [`and ${changes.length - 10} more`] : [];
        const result = await deliverSlackAlert({
          organizationId,
          message: {
            subject: `DNS changed on ${new Set(changes.map((change) => change.domain.name)).size} domain(s) in ${workspaceName}`,
            body: [...listed, ...more].join('\n'),
            domainName: changes[0]?.domain.name ?? 'your domains',
            risk: changes.some((change) => change.severity === 'CRITICAL') ? 'high' : 'medium',
          },
        });
        if (result.delivered) {
          outcome.slack += 1;
        }
      }
    } catch (error) {
      console.error(
        `[dns-monitor] Slack delivery failed for ${organizationId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  return outcome;
}
