import type { PlanTier, Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma.js';
import { emitEvent } from '../webhook.service.js';
import { countCountedDomainsIn } from '../inventory/inventory.service.js';
import {
  alwaysAllowedEntitlements,
  catalogOrder,
  entitlementLabels,
  nextTier,
  planCatalog,
  planOrder,
  quotaLabel,
  quotaLimitFor,
  type EntitlementKey,
  type QuotaKey,
} from './plan-catalog.js';

export interface ResolvedEntitlements {
  plan: PlanTier;
  label: string;
  status: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED' | 'NONE';
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  maxClients: number;
  maxActiveDomains: number;
  maxMembers: number;
  /** Quota rule, not retention: see PlanDefinition.activeDomainWindowDays. */
  activeDomainWindowDays: number;
  features: Record<EntitlementKey, boolean>;
  overrides: LiveOverride[];
}

export class EntitlementError extends Error {
  readonly status = 402;
  readonly code: 'PLAN_LIMIT_REACHED' | 'FEATURE_NOT_IN_PLAN';
  readonly details: Record<string, unknown>;

  constructor(code: 'PLAN_LIMIT_REACHED' | 'FEATURE_NOT_IN_PLAN', message: string, details: Record<string, unknown>) {
    super(message);
    this.name = 'EntitlementError';
    this.code = code;
    this.details = details;
  }
}

interface LiveOverride {
  entitlement: string;
  enabled: boolean;
  expiresAt: string | null;
  reason: string | null;
}

function liveOverrides(
  overrides: { entitlement: string; enabled: boolean; expiresAt: Date | null; reason: string | null }[],
  now: Date,
): LiveOverride[] {
  return overrides
    .filter((override) => override.expiresAt === null || override.expiresAt.getTime() > now.getTime())
    .map((override) => ({
      entitlement: override.entitlement,
      enabled: override.enabled,
      expiresAt: override.expiresAt?.toISOString() ?? null,
      reason: override.reason,
    }));
}

/**
 * The plan a workspace actually gets.
 *
 * This is `Organization.plan` and nothing else. It used to be computed from
 * `Subscription.plan`, which is the mirror of what the provider last told us,
 * and the two records were written by different code paths, so they drifted: a
 * scheduled downgrade cleared the marker and wrote the organisation but left the
 * subscription on the old tier, which meant every quota stayed at the price the
 * customer had just stopped paying while the billing page, the compliance pack,
 * the erasure inventory and the Trust Center all read the organisation and
 * correctly reported the new one. A workspace could be Admiralty for capacity
 * and Fairway for retention in the same request.
 *
 * `applyBillingEvent` resolves the plan once, against the persisted paid period,
 * and writes both records in one transaction, so there is a single answer to
 * read. The subscription is still selected for the fields below, which are
 * genuinely provider state rather than plan state.
 */
export async function resolveEntitlements(
  organizationId: string,
  now = new Date(),
  // The client to read through. `withQuota` takes FOR UPDATE on the organization
  // row and then has to make its decision from the same snapshot, not from a
  // separate connection that can see either side of a concurrent plan write:
  // passing the transaction client is what makes the lock cover the plan check
  // rather than just the counter increment.
  client: Pick<typeof prisma, 'organization'> = prisma,
): Promise<ResolvedEntitlements> {
  const organization = await client.organization.findUnique({
    where: { id: organizationId },
    select: {
      plan: true,
      preferredCurrency: true,
      subscription: {
        select: { status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
      },
      entitlementOverrides: {
        select: { entitlement: true, enabled: true, expiresAt: true, reason: true },
      },
      // The owner is the account. `members` is the only route from a workspace to
      // the person who paid for it, because a plan is a thing a person holds and
      // a workspace is a container they own.
        members: {
          where: { role: 'owner' },
          select: {
            user: {
              select: {
                plan: true,
                // The subscription the account paid through. A workspace the
                // account never checked out on has no row of its own, which is not
                // a missing subscription: the status is read from the account's,
                // wherever it was started.
                subscriptions: {
                  select: { status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
                  take: 1,
                  orderBy: { id: 'desc' },
                },
              },
            },
          },
          take: 1,
        },
    },
  });

  if (!organization) {
    throw new EntitlementError('FEATURE_NOT_IN_PLAN', 'Workspace not found.', { organizationId });
  }

  // The account's plan, and the subscription attached to the workspace the
  // account paid through. `members` can be empty only for a workspace whose owner
  // row was removed, which has no plan to read; the workspace's own shadow column
  // is the last resort rather than a crash.
  const owner = organization.members?.[0]?.user;
  const plan = (owner?.plan ?? organization.plan) as PlanTier;
  const subscription = owner?.subscriptions?.[0] ?? organization.subscription;

  const definition = planCatalog[plan];
  const overrides = liveOverrides(organization.entitlementOverrides, now);

  const features = { ...definition.features } as Record<EntitlementKey, boolean>;
  for (const override of overrides) {
    if (override.enabled) {
      features[override.entitlement as EntitlementKey] = true;
    } else {
      delete features[override.entitlement as EntitlementKey];
    }
  }

  for (const required of alwaysAllowedEntitlements) {
    features[required] = true;
  }

  const bumped: ResolvedEntitlements = {
    plan,
    label: definition.label,
    status: subscription?.status ?? 'NONE',
    currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    maxClients: definition.maxClients,
    maxActiveDomains: definition.maxActiveDomains,
    maxMembers: definition.maxMembers,
    activeDomainWindowDays: definition.activeDomainWindowDays,
    features,
    overrides,
  };

  return bumped;
}

export { countCountedDomains } from '../inventory/inventory.service.js';

/**
 * Counts, checks and inserts under one lock, so a quota cannot be exceeded by racing.
 *
 * `assertQuota` on its own is a check followed by an act, with the insert left to the
 * caller. Two requests that arrive together both read "one domain left", both pass,
 * and both insert: the customer ends up on three domains of a two domain plan. No
 * error, no log line, just a plan limit that quietly does not hold.
 *
 * Taking a row lock on the workspace first makes the count and the insert one
 * serialised unit per workspace. Different workspaces still run concurrently, which
 * is the only concurrency that matters here since the quota is per workspace.
 *
 * This has to wrap the insert, not just the check, which is why it takes a callback
 * rather than returning a boolean. The alternative - a database constraint - is not
 * expressible for "at most N rows of this kind, where N is in another table".
 */
export async function withQuota<T>(
  organizationId: string,
  quota: QuotaKey,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { requested?: number; now?: Date } = {},
): Promise<T> {
  const requested = options.requested ?? 1;

  return prisma.$transaction(async (tx) => {
    /**
     * `FOR UPDATE` serialises every other writer that goes through here for this
     * workspace. It is the workspace row because it exists for exactly this purpose
     * and is never deleted while the transaction holds it.
     */
    await tx.$queryRaw`SELECT id FROM "organization" WHERE id = ${organizationId} FOR UPDATE`;

    const entitlements = await resolveEntitlements(organizationId, options.now, tx);
    const usage = await quotaUsage(organizationId, quota, entitlements.plan, options.now, tx);

    if (usage.used + requested > usage.limit) {
      throw await quotaExceeded(organizationId, entitlements, quota, usage, requested);
    }

    return work(tx);
  });
}

/**
 * Workspaces the account behind this organization owns.
 *
 * Used wherever a limit has to be counted across the account rather than inside
 * one workspace. A quota that is a property of the plan the person bought has to
 * be counted where the plan applies, which is every container they hold, not one
 * of them.
 */
async function accountOrganizationIds(organizationId: string): Promise<string[]> {
  const memberships = await prisma.member.findMany({
    where: { organizationId, role: 'owner' },
    select: {
      userId: true,
    },
  });

  const ownerIds = memberships.map((membership) => membership.userId);
  if (ownerIds.length === 0) return [organizationId];

  return prisma.member
    .findMany({
      where: { userId: { in: ownerIds }, role: 'owner' },
      select: { organizationId: true },
      distinct: ['organizationId'],
    })
    .then((rows) => rows.map((row) => row.organizationId));
}

export async function quotaUsage(
  organizationId: string,
  quota: QuotaKey,
  plan: PlanTier,
  now = new Date(),
  /**
   * Pass the transaction client when counting inside `withQuota`, or the count runs
   * on a different connection than the insert it is meant to be serialised against,
   * which would reintroduce the exact race this exists to close.
   */
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{ used: number; limit: number }> {
  const definition = planCatalog[plan];

  if (quota === 'member') {
    // People are counted inside the workspace, because a member is someone on that
    // workspace's team rather than a unit of the client portfolio. Everywhere else
    // the limit follows the account, so a portfolio cannot be split across
    // containers to fit under a plan twice.
    return { used: await client.member.count({ where: { organizationId } }), limit: definition.maxMembers };
  }

  const scope = await accountOrganizationIds(organizationId);

  if (quota === 'activeDomain') {
    const used = await countCountedDomainsIn(scope, definition.activeDomainWindowDays, now, client);
    return { used, limit: definition.maxActiveDomains };
  }

  return { used: await client.client.count({ where: { organizationId: { in: scope } } }), limit: definition.maxClients };
}

/**
 * Room for one more person on a workspace's team: members plus invitations that
 * are still open, against the plan's member limit.
 *
 * The limit was published on every plan and checked only on a downgrade, so a
 * free workspace could invite a hundred people. Open invitations count, because
 * each one becomes a member the moment it is accepted, and counting only members
 * would let a workspace send twenty invitations against a three-person plan.
 */
export async function memberAllowance(
  organizationId: string,
  now = new Date(),
): Promise<{ limit: number; members: number; pending: number; plan: PlanTier; planLabel: string }> {
  const entitlements = await resolveEntitlements(organizationId, now);
  const [members, pending] = await Promise.all([
    prisma.member.count({ where: { organizationId } }),
    prisma.invitation.count({ where: { organizationId, status: 'pending', expiresAt: { gt: now } } }),
  ]);
  return { limit: entitlements.maxMembers, members, pending, plan: entitlements.plan, planLabel: entitlements.label };
}

/** The sentence a refused invitation or sign-in shows. */
export function memberLimitMessage(allowance: { limit: number; members: number; pending: number; plan: PlanTier; planLabel: string }): string {
  const upgradeTo = nextTier(allowance.plan);
  const waiting = allowance.pending > 0 ? ` and ${allowance.pending} open invitation${allowance.pending === 1 ? '' : 's'}` : '';
  return (
    `${allowance.planLabel} includes ${allowance.limit} team member${allowance.limit === 1 ? '' : 's'} and this workspace has ${allowance.members}${waiting}. ` +
    (upgradeTo
      ? `Remove someone or cancel an invitation, or upgrade to ${planCatalog[upgradeTo].label} for ${planCatalog[upgradeTo].maxMembers}.`
      : 'Remove someone or cancel an invitation, or contact us to add more.')
  );
}

/** The first rung of the ladder that grants a feature, or null when none does. */
export function requiredPlanFor(feature: EntitlementKey): PlanTier | null {
  // Ladder order, not price order. A per-domain unit price is not a rung and
  // must never become the answer to "upgrade to what?".
  return planOrder.find((tier) => planCatalog[tier].features[feature]) ?? null;
}

/** The sentence a refused feature shows, in one place so it can be snapshotted. */
export function entitlementRefusalMessage(feature: EntitlementKey, planLabel: string): string {
  const requiredBy = requiredPlanFor(feature);
  return `${entitlementLabels[feature] ?? feature} is not included in ${planLabel}. Upgrade to ${requiredBy ? planCatalog[requiredBy].label : 'a higher plan'} to use it.`;
}

export async function assertFeature(organizationId: string, feature: EntitlementKey, now = new Date()): Promise<void> {
  const entitlements = await resolveEntitlements(organizationId, now);

  if (entitlements.features[feature]) {
    return;
  }

  const upgradeTo = nextTier(entitlements.plan);
  const requiredBy = requiredPlanFor(feature);

  throw new EntitlementError(
    'FEATURE_NOT_IN_PLAN',
    entitlementRefusalMessage(feature, entitlements.label),
    {
      feature,
      plan: entitlements.plan,
      planLabel: entitlements.label,
      requiredIn: requiredBy ?? null,
      upgradeTo,
    },
  );
}

export async function assertQuota(
  organizationId: string,
  quota: QuotaKey,
  requested = 1,
  now = new Date(),
): Promise<void> {
  const entitlements = await resolveEntitlements(organizationId, now);
  const usage = await quotaUsage(organizationId, quota, entitlements.plan, now);

  if (usage.used + requested <= usage.limit) {
    return;
  }

  throw await quotaExceeded(organizationId, entitlements, quota, usage, requested);
}

/**
 * The one place a quota refusal is built.
 *
 * Shared with `withQuota` so a customer gets the same message, the same payload and
 * the same analytics event whether the limit was caught by the plain check or under
 * the lock. Returns rather than throws so the caller decides where it surfaces.
 */
async function quotaExceeded(
  organizationId: string,
  entitlements: Awaited<ReturnType<typeof resolveEntitlements>>,
  quota: QuotaKey,
  usage: { used: number; limit: number },
  requested: number,
): Promise<EntitlementError> {
  const label = quotaLabel(quota);
  const upgradeTo = nextTier(entitlements.plan);
  const upgradeName = upgradeTo ? planCatalog[upgradeTo].label : null;

  await emitEvent(organizationId, 'entitlement.exceeded', {
    quota,
    label,
    used: usage.used,
    limit: usage.limit,
    plan: entitlements.plan,
    planLabel: entitlements.label,
    upgradeTo,
    occurredAt: new Date().toISOString(),
  });

  return new EntitlementError(
    'PLAN_LIMIT_REACHED',
    `${entitlements.label} includes ${usage.limit} ${label} and you have ${usage.used}. ` +
      // The upgrade names the limit that was hit; it used to quote active
      // domains whichever quota (clients, members) had been reached.
      (upgradeName
        ? `Upgrade to ${upgradeName} for ${quotaLimitFor(upgradeTo!, quota)} ${label}, or remove one.`
        : 'Contact us to add more.'),
    {
      quota,
      label,
      used: usage.used,
      requested,
      limit: usage.limit,
      plan: entitlements.plan,
      planLabel: entitlements.label,
      upgradeTo,
      upgradeToLabel: upgradeName,
    },
  );
}

/**
 * Sets the plan for the account that owns this workspace.
 *
 * The workspace id is still the argument, unchanged, because every caller names a
 * workspace: the billing controller holds one, the staff controller holds one, and
 * the test helper holds one. The plan itself moves to the account, so calling this
 * on any workspace the account owns sets it for all of them.
 *
 * The Subscription row stays keyed on the workspace. A provider webhook arrives
 * with the provider's own subscription id and is matched to the workspace that
 * started the checkout, so the row has to stay where the provider left it; the
 * shadow column on the workspace keeps that legible. Writing the plan to both in
 * one transaction is what keeps a plan read from the account and a period read
 * from the subscription from disagreeing.
 */
export async function setOrganizationPlan(
  organizationId: string,
  plan: PlanTier,
  options: { status?: 'ACTIVE' | 'TRIALING' | 'CANCELLED' | 'PAST_DUE' | 'EXPIRED'; currentPeriodEnd?: Date | null; provider?: 'NONE' | 'RAZORPAY' | 'PADDLE'; providerSubscriptionId?: string | null } = {},
): Promise<void> {
  const status = options.status ?? 'ACTIVE';

  const owner = await prisma.member.findFirst({
    where: { organizationId, role: 'owner' },
    select: { userId: true },
  });

  await prisma.$transaction([
    // No owner is not an error here. A workspace whose owner row has gone, or whose
    // owner has been demoted to admin, still needs its shadow plan written, because
    // that is what every other reader and the provider mapping use. Throwing turned a
    // plan change on such a workspace into a 500, which left the workspace on the old
    // tier with nothing recorded. The account write is skipped, and resolution falls
    // back to the shadow for exactly this case.
    ...(owner ? [prisma.user.update({ where: { id: owner.userId }, data: { plan } })] : []),
    // The shadow. Billing keeps matching provider ids against a workspace, so this
    // stays in step with the account's plan rather than being dropped and leaving
    // the mapping readable only through the owner.
    prisma.organization.update({ where: { id: organizationId }, data: { plan } }),
    prisma.subscription.upsert({
      where: { organizationId },
      create: {
        organizationId,
        // Written on both keys when the account is known: the workspace is how a
        // provider webhook finds the row, the account is where entitlement status is
        // read from. Leaving the account null would make the plan live on the user
        // while its period kept living on the workspace, and the two would drift the
        // first time one moved.
        ...(owner ? { userId: owner.userId } : {}),
        plan,
        status,
        provider: options.provider ?? 'NONE',
        currentPeriodEnd: options.currentPeriodEnd ?? null,
        providerSubscriptionId: options.providerSubscriptionId ?? null,
      },
      update: {
        plan,
        status,
        ...(owner ? { userId: owner.userId } : {}),
        ...(options.currentPeriodEnd !== undefined ? { currentPeriodEnd: options.currentPeriodEnd } : {}),
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.providerSubscriptionId !== undefined
          ? { providerSubscriptionId: options.providerSubscriptionId }
          : {}),
      },
    }),
  ]);
}

export interface OverrideInput {
  entitlement: string;
  enabled: boolean;
  reason?: string | null;
  expiresAt?: Date | null;
  createdById?: string | null;
}

export async function setOverride(organizationId: string, input: OverrideInput): Promise<void> {
  await prisma.entitlementOverride.upsert({
    where: { organizationId_entitlement: { organizationId, entitlement: input.entitlement } },
    create: {
      organizationId,
      entitlement: input.entitlement,
      enabled: input.enabled,
      reason: input.reason ?? null,
      expiresAt: input.expiresAt ?? null,
      createdById: input.createdById ?? null,
    },
    update: {
      enabled: input.enabled,
      reason: input.reason ?? null,
      expiresAt: input.expiresAt ?? null,
    },
  });
}

export async function removeOverride(organizationId: string, entitlement: string): Promise<boolean> {
  const deleted = await prisma.entitlementOverride.deleteMany({ where: { organizationId, entitlement } });
  return deleted.count > 0;
}

export function planCatalogResponse(): Prisma.InputJsonValue {
  return catalogOrder.map((tier) => ({
    ...planCatalog[tier],
    features: planCatalog[tier].features as unknown as Prisma.InputJsonValue,
  })) as unknown as Prisma.InputJsonValue;
}
