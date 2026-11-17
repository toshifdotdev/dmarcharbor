import { prisma } from '../../database/prisma.js';
import { sendDomainsPausedEmail } from '../../email/mailer.js';
import { recordAuditEvent } from '../audit.service.js';
import { countedDomainWhere } from '../inventory/inventory.service.js';
import { accountOrganizationIds, resolveEntitlements, withWorkspaceLock } from './entitlement.service.js';

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
 * "Counted" is the quota's own rule (inventory.service.ts countedDomainWhere):
 * a report in the plan's window, or added or resumed within the grace period.
 * A parked domain that sends nothing is never paused, because it costs
 * nothing. If it starts receiving reports while the plan is full, the report
 * is refused and the domain paused when it arrives (admitAggregateReport), so
 * a plan for two domains stores reports for two domains.
 *
 * Run after every plan change (plan-change-effects.ts afterPlanChange, which
 * mails the owners itself), on the billing reconciliation (dunning.ts) and
 * daily for every account (alert-scheduler.ts), which mail the owners here.
 */

export const PAUSE_REASON = { planLimit: 'plan_limit', owner: 'owner' } as const;
export type PauseReason = (typeof PAUSE_REASON)[keyof typeof PAUSE_REASON];

export interface MonitoringChange {
  paused: Array<{ id: string; name: string; organizationId: string }>;
  resumed: Array<{ id: string; name: string; organizationId: string }>;
}

const domainSelect = { id: true, name: true, client: { select: { organizationId: true } } } as const;
const order = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

/**
 * Pauses or resumes domains so the account's counted domains fit its plan.
 *
 * `notify` mails the owners about domains paused here. The plan-change path
 * passes false because its own email already lists them with the other
 * effects of the change.
 */
export async function reconcileDomainMonitoring(
  organizationId: string,
  now = new Date(),
  options: { notify?: boolean } = {},
): Promise<MonitoringChange> {
  const entitlements = await resolveEntitlements(organizationId, now);
  const limit = entitlements.maxActiveDomains;
  const scope = await accountOrganizationIds(organizationId);
  const inScope = { client: { organizationId: { in: scope } } };

  const change: MonitoringChange = { paused: [], resumed: [] };

  await withWorkspaceLock(organizationId, async (tx) => {
    const counted = await tx.domain.findMany({
      where: { ...inScope, ...countedDomainWhere(entitlements.activeDomainWindowDays, now) },
      select: domainSelect,
      // Oldest first: the domains an account set up first are the ones it keeps.
      orderBy: order,
    });

    if (Number.isFinite(limit) && counted.length > limit) {
      const over = counted.slice(limit);
      await tx.domain.updateMany({
        where: { id: { in: over.map((d) => d.id) }, monitoringPausedAt: null },
        data: { monitoringPausedAt: now, monitoringPausedReason: PAUSE_REASON.planLimit },
      });
      change.paused = over.map((d) => ({ id: d.id, name: d.name, organizationId: d.client.organizationId }));
    } else if (counted.length < limit) {
      const room = Number.isFinite(limit) ? limit - counted.length : 10_000;
      const waiting = await tx.domain.findMany({
        where: { ...inScope, monitoringPausedReason: PAUSE_REASON.planLimit },
        select: domainSelect,
        orderBy: order,
        take: Math.min(room, 10_000),
      });
      if (waiting.length > 0) {
        await tx.domain.updateMany({
          where: { id: { in: waiting.map((d) => d.id) }, monitoringPausedReason: PAUSE_REASON.planLimit },
          // The resume date makes each one take its place at once (countedDomainWhere).
          data: { monitoringPausedAt: null, monitoringPausedReason: null, monitoringResumedAt: now },
        });
        change.resumed = waiting.map((d) => ({ id: d.id, name: d.name, organizationId: d.client.organizationId }));
      }
    }
  });

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
        detail: { reason: PAUSE_REASON.planLimit, plan: entitlements.plan, limit: Number.isFinite(limit) ? limit : null },
      });
    }
  }

  if (options.notify && change.paused.length > 0 && Number.isFinite(limit)) {
    await sendDomainsPausedEmail({
      organizationId,
      plan: entitlements.plan,
      limit,
      domains: change.paused.map((d) => d.name),
      idempotencyKey: `domains-paused:${organizationId}:${now.toISOString().slice(0, 10)}:${change.paused.map((d) => d.id).sort().join(',')}`,
    });
  }

  return change;
}

/**
 * Reconciles every account that has a domain, once per account, and mails the
 * owners about anything it paused.
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
      const change = await reconcileDomainMonitoring(id, now, { notify: true });
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

/**
 * Whether an aggregate report for this domain may be stored.
 *
 * A domain that already takes a place on the plan is admitted without another
 * query. One that does not (parked: no report in the window, added before the
 * grace period) would take a place by storing this report, so it is admitted
 * only if the account has a free place; otherwise it is paused for the plan
 * limit and the report refused. Two such reports racing for the last place can
 * both be stored; the next reconciliation pauses the newer domain.
 */
export async function admitAggregateReport(organizationId: string, domainId: string, now = new Date()): Promise<'admitted' | 'paused'> {
  const entitlements = await resolveEntitlements(organizationId, now);
  const limit = entitlements.maxActiveDomains;
  if (!Number.isFinite(limit)) return 'admitted';

  const window = countedDomainWhere(entitlements.activeDomainWindowDays, now);
  const alreadyCounted = await prisma.domain.count({ where: { id: domainId, ...window } });
  if (alreadyCounted > 0) return 'admitted';

  const scope = await accountOrganizationIds(organizationId);
  const used = await prisma.domain.count({ where: { client: { organizationId: { in: scope } }, ...window } });
  if (used < limit) return 'admitted';

  const paused = await prisma.domain.updateMany({
    where: { id: domainId, monitoringPausedAt: null },
    data: { monitoringPausedAt: now, monitoringPausedReason: PAUSE_REASON.planLimit },
  });
  if (paused.count > 0) {
    const domain = await prisma.domain.findUnique({ where: { id: domainId }, select: { name: true } });
    await recordAuditEvent({
      organizationId,
      domainId,
      action: 'DOMAIN_MONITORING_PAUSED',
      targetType: 'domain',
      targetId: domainId,
      detail: { reason: PAUSE_REASON.planLimit, plan: entitlements.plan, limit, trigger: 'report_received' },
    });
    if (domain) {
      await sendDomainsPausedEmail({
        organizationId,
        plan: entitlements.plan,
        limit,
        domains: [domain.name],
        idempotencyKey: `domains-paused:${organizationId}:${now.toISOString().slice(0, 10)}:${domainId}`,
      });
    }
  }
  return 'paused';
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
    where: { client: { organizationId: { in: scope } }, ...countedDomainWhere(entitlements.activeDomainWindowDays, now) },
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
 * Pausing is always allowed and frees a place; resuming takes a place at once
 * (the resume date counts, countedDomainWhere) and is refused when the plan has
 * none left. The count and the resume run under the workspace lock, the same
 * lock adding a domain takes, so they cannot both take the last place.
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
    const entitlements = await resolveEntitlements(input.organizationId, now);
    const limit = entitlements.maxActiveDomains;
    const scope = await accountOrganizationIds(input.organizationId);
    await withWorkspaceLock(input.organizationId, async (tx) => {
      if (Number.isFinite(limit)) {
        const used = await tx.domain.count({
          where: { client: { organizationId: { in: scope } }, ...countedDomainWhere(entitlements.activeDomainWindowDays, now) },
        });
        if (used >= limit) {
          throw new MonitoringChangeError(
            402,
            'PLAN_LIMIT_REACHED',
            `Your plan monitors ${limit} active domain${limit === 1 ? '' : 's'} and ${used} ${used === 1 ? 'is' : 'are'} in use. Pause another domain or choose a larger plan to resume this one.`,
          );
        }
      }
      await tx.domain.update({
        where: { id: domain.id },
        data: { monitoringPausedAt: null, monitoringPausedReason: null, monitoringResumedAt: now },
      });
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
