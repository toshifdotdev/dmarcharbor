import { prisma } from '../../database/prisma.js';
import { recordAuditEvent } from '../audit.service.js';
import { domainGraceDays } from '../inventory/inventory.service.js';
import { accountOrganizationIds, resolveEntitlements } from './entitlement.service.js';

/**
 * Keeps the domains an account monitors within its plan.
 *
 * The domain limit was only checked when a domain was added. An account that
 * bought a larger plan, added its domains and then cancelled, was refunded or
 * stopped paying kept every one of them monitored on the free plan, for good.
 *
 * Now, while an account has more counted domains than its plan allows, the
 * newest of them are paused: their history stays readable and nothing is
 * deleted, but new reports for them are not stored (report.service.ts,
 * forensic-report.service.ts, tls-report.service.ts) and they stop counting.
 * When the plan has room again, the oldest domains the plan paused are resumed
 * first. A domain the owner paused to make room for another stays paused until
 * the owner resumes it.
 *
 * "Counted" is the quota's own rule (inventory.service.ts countCountedDomainsIn):
 * a report in the plan's window, or added within the grace period. A parked
 * domain that sends nothing is never paused, because it costs nothing.
 *
 * Run after every plan change (plan-change-effects.ts afterPlanChange) and on
 * the billing reconciliation schedule (dunning.ts), which catches a paid period
 * that simply ran out.
 */

export const PAUSE_REASON = { planLimit: 'plan_limit', owner: 'owner' } as const;
export type PauseReason = (typeof PAUSE_REASON)[keyof typeof PAUSE_REASON];

export interface MonitoringChange {
  paused: Array<{ id: string; name: string; organizationId: string }>;
  resumed: Array<{ id: string; name: string; organizationId: string }>;
}

function countedFilter(windowDays: number, now: Date) {
  const activeSince = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const graceSince = new Date(now.getTime() - domainGraceDays * 24 * 60 * 60 * 1000);
  return {
    OR: [{ dmarcReports: { some: { receivedAt: { gte: activeSince } } } }, { createdAt: { gte: graceSince } }],
  };
}

const domainSelect = { id: true, name: true, client: { select: { organizationId: true } } } as const;

/** Pauses or resumes domains so the account's counted domains fit its plan. */
export async function reconcileDomainMonitoring(organizationId: string, now = new Date()): Promise<MonitoringChange> {
  const entitlements = await resolveEntitlements(organizationId, now);
  const limit = entitlements.maxActiveDomains;
  const scope = await accountOrganizationIds(organizationId);
  const inScope = { client: { organizationId: { in: scope } } };

  const counted = await prisma.domain.findMany({
    where: { ...inScope, monitoringPausedAt: null, ...countedFilter(entitlements.activeDomainWindowDays, now) },
    select: domainSelect,
    // Oldest first: the domains an account set up first are the ones it keeps.
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const change: MonitoringChange = { paused: [], resumed: [] };

  if (Number.isFinite(limit) && counted.length > limit) {
    const over = counted.slice(limit);
    await prisma.domain.updateMany({
      where: { id: { in: over.map((d) => d.id) }, monitoringPausedAt: null },
      data: { monitoringPausedAt: now, monitoringPausedReason: PAUSE_REASON.planLimit },
    });
    change.paused = over.map((d) => ({ id: d.id, name: d.name, organizationId: d.client.organizationId }));
  } else if (counted.length < limit) {
    const room = Number.isFinite(limit) ? limit - counted.length : Number.MAX_SAFE_INTEGER;
    const waiting = await prisma.domain.findMany({
      where: { ...inScope, monitoringPausedReason: PAUSE_REASON.planLimit },
      select: domainSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.min(room, 10_000),
    });
    if (waiting.length > 0) {
      await prisma.domain.updateMany({
        where: { id: { in: waiting.map((d) => d.id) }, monitoringPausedReason: PAUSE_REASON.planLimit },
        data: { monitoringPausedAt: null, monitoringPausedReason: null },
      });
      change.resumed = waiting.map((d) => ({ id: d.id, name: d.name, organizationId: d.client.organizationId }));
    }
  }

  for (const [action, rows] of [
    ['DOMAIN_MONITORING_PAUSED', change.paused],
    ['DOMAIN_MONITORING_RESUMED', change.resumed],
  ] as const) {
    for (const row of rows) {
      await recordAuditEvent({
        organizationId: row.organizationId,
        domainId: row.id,
        action,
        targetType: 'domain',
        targetId: row.id,
        detail: { reason: PAUSE_REASON.planLimit, plan: entitlements.plan, limit },
      });
    }
  }

  return change;
}

/**
 * Reconciles every account that has a domain, once per account.
 *
 * One failure is counted and the loop goes on: a problem in one account must not
 * leave every other account over its plan.
 */
export async function reconcileAllDomainMonitoring(now = new Date()): Promise<{ accounts: number; paused: number; resumed: number; failed: number }> {
  const organizations = await prisma.organization.findMany({
    where: { clients: { some: { domains: { some: {} } } } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  const seen = new Set<string>();
  const outcome = { accounts: 0, paused: 0, resumed: 0, failed: 0 };
  for (const { id } of organizations) {
    if (seen.has(id)) continue;
    try {
      for (const member of await accountOrganizationIds(id)) seen.add(member);
      const change = await reconcileDomainMonitoring(id, now);
      outcome.accounts += 1;
      outcome.paused += change.paused.length;
      outcome.resumed += change.resumed.length;
    } catch (error) {
      outcome.failed += 1;
      console.error(`[domain-allowance] reconciling ${id} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  return outcome;
}

export class MonitoringChangeError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'NOT_FOUND' | 'PLAN_LIMIT_REACHED',
    message: string,
  ) {
    super(message);
    this.name = 'MonitoringChangeError';
  }
}

/** Monitoring state of one domain, as the domain page shows it. */
export interface DomainMonitoring {
  paused: boolean;
  reason: PauseReason | null;
  pausedAt: string | null;
  /** Counted domains against the plan's limit, across the account. */
  used: number;
  limit: number | null;
}

export async function domainMonitoring(organizationId: string, domainId: string, now = new Date()): Promise<DomainMonitoring | null> {
  const domain = await prisma.domain.findFirst({
    where: { id: domainId, client: { organizationId } },
    select: { monitoringPausedAt: true, monitoringPausedReason: true },
  });
  if (!domain) return null;
  const entitlements = await resolveEntitlements(organizationId, now);
  const scope = await accountOrganizationIds(organizationId);
  const used = await prisma.domain.count({
    where: { client: { organizationId: { in: scope } }, monitoringPausedAt: null, ...countedFilter(entitlements.activeDomainWindowDays, now) },
  });
  return {
    paused: domain.monitoringPausedAt !== null,
    reason: (domain.monitoringPausedReason as PauseReason | null) ?? null,
    pausedAt: domain.monitoringPausedAt?.toISOString() ?? null,
    used,
    limit: Number.isFinite(entitlements.maxActiveDomains) ? entitlements.maxActiveDomains : null,
  };
}

/**
 * The owner's choice of which domains are monitored.
 *
 * Pausing is always allowed and frees a place; resuming takes a place and is
 * refused when the plan has none left. Two resumes racing for the last place
 * can both succeed; the next reconciliation pauses the newer one again.
 */
export async function setDomainMonitoring(input: {
  organizationId: string;
  domainId: string;
  paused: boolean;
  actorUserId?: string | null;
  now?: Date;
}): Promise<DomainMonitoring> {
  const now = input.now ?? new Date();
  const domain = await prisma.domain.findFirst({
    where: { id: input.domainId, client: { organizationId: input.organizationId } },
    select: { id: true, monitoringPausedAt: true },
  });
  if (!domain) throw new MonitoringChangeError(404, 'NOT_FOUND', 'That domain is not in this workspace.');

  if (input.paused && domain.monitoringPausedAt === null) {
    await prisma.domain.update({
      where: { id: domain.id },
      data: { monitoringPausedAt: now, monitoringPausedReason: PAUSE_REASON.owner },
    });
    await recordAuditEvent({
      organizationId: input.organizationId,
      domainId: domain.id,
      actorUserId: input.actorUserId ?? undefined,
      action: 'DOMAIN_MONITORING_PAUSED',
      targetType: 'domain',
      targetId: domain.id,
      detail: { reason: PAUSE_REASON.owner },
    });
  }

  if (!input.paused && domain.monitoringPausedAt !== null) {
    const before = await domainMonitoring(input.organizationId, domain.id, now);
    if (before && before.limit !== null && before.used >= before.limit) {
      throw new MonitoringChangeError(
        402,
        'PLAN_LIMIT_REACHED',
        `The plan monitors ${before.limit} active domain${before.limit === 1 ? '' : 's'} and ${before.used} are in use. Pause another domain or choose a larger plan to resume this one.`,
      );
    }
    await prisma.domain.update({
      where: { id: domain.id },
      data: { monitoringPausedAt: null, monitoringPausedReason: null },
    });
    await recordAuditEvent({
      organizationId: input.organizationId,
      domainId: domain.id,
      actorUserId: input.actorUserId ?? undefined,
      action: 'DOMAIN_MONITORING_RESUMED',
      targetType: 'domain',
      targetId: domain.id,
      detail: { reason: PAUSE_REASON.owner },
    });
  }

  return (await domainMonitoring(input.organizationId, domain.id, now))!;
}
