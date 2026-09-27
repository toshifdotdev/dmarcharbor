import { Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma.js';
import { dataClasses, personalDataClasses, retainedClasses, type DataClass } from './data-classes.js';

export type InventoryScope =
  | { kind: 'ORGANIZATION'; organizationId: string }
  | { kind: 'CLIENT'; organizationId: string; clientId: string }
  | { kind: 'DOMAIN'; organizationId: string; domainId: string };

/**
 * A domain that has not produced a report for this long is treated as parked
 * and stops being metered. Agencies routinely hold hundreds of legacy domains
 * that no longer send mail, and billing for them is the single most common
 * complaint about competitor pricing.
 */
export const domainGraceDays = 14;

export interface Inventory {
  scope: InventoryScope;
  generatedAt: string;
  counts: Record<string, number>;
  personalData: { key: string; label: string; count: number }[];
  evidenceRetained: { key: string; label: string; count: number; reason: string; basis: string }[];
  metered: { activeDomains: number; countedDomains: number; retentionDays: number; graceDays: number };
}

function scopeFilter(scope: InventoryScope): Prisma.DomainWhereInput {
  if (scope.kind === 'ORGANIZATION') {
    return { client: { organizationId: scope.organizationId } };
  }
  if (scope.kind === 'CLIENT') {
    return { clientId: scope.clientId, client: { organizationId: scope.organizationId } };
  }
  return { id: scope.domainId, client: { organizationId: scope.organizationId } };
}

export async function countActiveDomains(
  organizationId: string,
  retentionDays: number,
  now = new Date(),
): Promise<number> {
  const activeSince = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  return prisma.domain.count({
    where: {
      client: { organizationId },
      dmarcReports: { some: { receivedAt: { gte: activeSince } } },
    },
  });
}

export async function countCountedDomains(
  organizationId: string,
  retentionDays: number,
  now = new Date(),
): Promise<number> {
  const activeSince = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const graceSince = new Date(now.getTime() - domainGraceDays * 24 * 60 * 60 * 1000);

  return prisma.domain.count({
    where: {
      client: { organizationId },
      OR: [{ dmarcReports: { some: { receivedAt: { gte: activeSince } } } }, { createdAt: { gte: graceSince } }],
    },
  });
}

export async function buildInventory(
  scope: InventoryScope,
  options: { retentionDays?: number; now?: Date } = {},
): Promise<Inventory> {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? 400;
  const domain = scopeFilter(scope);

  const org = scope.organizationId;
  const userScope: Prisma.UserWhereInput = { members: { some: { organizationId: org } } };
  const ruleScope: Prisma.AlertRecipientWhereInput = { rule: { organizationId: org } };
  const eventScope: Prisma.AlertDeliveryWhereInput = { event: { organizationId: org } };

  const named: Prisma.DmarcForensicReportWhereInput = { domain };

  const [
    clients,
    domains,
    scans,
    reports,
    reportRecords,
    authResults,
    forensic,
    forensicNamed,
    alertRules,
    alertEvents,
    alertRecipients,
    alertDeliveries,
    reportShares,
    reportDigests,
    notifications,
    members,
    invitations,
    sessions,
    accounts,
    users,
    auditEvents,
    subscriptions,
    overrides,
    activeDomains,
    countedDomains,
  ] = await Promise.all([
    scope.kind === 'ORGANIZATION'
      ? prisma.client.count({ where: { organizationId: org } })
      : scope.kind === 'CLIENT'
        ? prisma.client.count({ where: { id: scope.clientId, organizationId: org } })
        : prisma.client.count({ where: { id: '__none__' } }),

    prisma.domain.count({ where: domain }),

    prisma.scan.count({ where: { domain } }),

    prisma.dmarcReport.count({ where: { domain } }),

    prisma.dmarcReportRecord.count({ where: { report: { domain } } }),

    prisma.dmarcAuthResult.count({ where: { record: { report: { domain } } } }),

    prisma.dmarcForensicReport.count({ where: named }),

    prisma.dmarcForensicReport.count({
      where: { AND: [named, { recipientAddresses: { not: Prisma.DbNull } }] },
    }),

    scope.kind === 'DOMAIN' ? prisma.alertRule.count({ where: { domainId: scope.domainId } }) : prisma.alertRule.count({ where: { organizationId: org } }),
    scope.kind === 'DOMAIN' ? prisma.alertEvent.count({ where: { domainId: scope.domainId } }) : prisma.alertEvent.count({ where: { organizationId: org } }),
    prisma.alertRecipient.count({ where: ruleScope }),
    prisma.alertDelivery.count({ where: eventScope }),
    scope.kind === 'DOMAIN' ? prisma.reportShare.count({ where: { domainId: scope.domainId } }) : prisma.reportShare.count({ where: { organizationId: org } }),
    scope.kind === 'DOMAIN' ? prisma.reportDigest.count({ where: { domainId: scope.domainId } }) : prisma.reportDigest.count({ where: { organizationId: org } }),
    prisma.notification.count({ where: { organizationId: org } }),
    scope.kind === 'DOMAIN' ? prisma.member.count({ where: { organizationId: org } }) : prisma.member.count({ where: { organizationId: org } }),
    prisma.invitation.count({ where: { organizationId: org } }),
    prisma.session.count({ where: { user: userScope } }),
    prisma.account.count({ where: { user: userScope } }),
    prisma.user.count({ where: userScope }),
    scope.kind === 'DOMAIN'
      ? prisma.auditLog.count({ where: { domainId: scope.domainId } })
      : prisma.auditLog.count({ where: { organizationId: org } }),
    prisma.subscription.count({ where: { organizationId: org } }),
    prisma.entitlementOverride.count({ where: { organizationId: org } }),
    countActiveDomains(org, retentionDays, now),
    countCountedDomains(org, retentionDays, now),
  ]);

  const counts: Record<string, number> = {
    organization: 1,
    client: clients,
    domain: domains,
    scan: scans,
    report: reports,
    reportRecord: reportRecords,
    authResult: authResults,
    forensicEvidence: forensic,
    forensicPseudonym: forensic,
    forensicPersonalData: forensicNamed,
    alertRule: alertRules,
    alertEvent: alertEvents,
    alertRecipient: alertRecipients,
    alertDelivery: alertDeliveries,
    reportShare: reportShares,
    reportDigest: reportDigests,
    notification: notifications,
    notificationPreference: 0,
    member: members,
    invitation: invitations,
    session: sessions,
    account: accounts,
    user: users,
    auditLog: auditEvents,
    subscription: subscriptions,
    entitlementOverride: overrides,
  };

  return {
    scope,
    generatedAt: now.toISOString(),
    counts,
    personalData: personalDataClasses()
      .filter((entry) => (counts[entry.key] ?? 0) > 0)
      .map((entry) => ({ key: entry.key, label: entry.label, count: counts[entry.key] ?? 0 })),
    evidenceRetained: retainedClasses()
      .filter((entry) => (counts[entry.key] ?? 0) > 0)
      .map((entry) => ({
        key: entry.key,
        label: entry.label,
        count: counts[entry.key] ?? 0,
        reason: entry.retentionReason ?? '',
        basis: entry.retentionBasis ?? '',
      })),
    metered: { activeDomains, countedDomains, retentionDays, graceDays: domainGraceDays },
  };
}

export function describeClasses(): { key: string; label: string; personalData: boolean; erasure: string; basis: string }[] {
  return dataClasses.map((entry: DataClass) => ({
    key: entry.key,
    label: entry.label,
    personalData: entry.containsPersonalData,
    erasure: entry.erasure,
    basis: entry.retentionBasis ?? '',
  }));
}

