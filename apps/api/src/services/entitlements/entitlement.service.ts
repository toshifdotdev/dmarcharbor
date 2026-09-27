import type { PlanTier, Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma.js';
import { emitEvent } from '../webhook.service.js';
import { countCountedDomains } from '../inventory/inventory.service.js';
import {
  alwaysAllowedEntitlements,
  effectivePlan,
  nextTier,
  planCatalog,
  quotaLabel,
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
  dataRetentionDays: number;
  auditRetentionDays: number;
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

export async function resolveEntitlements(organizationId: string, now = new Date()): Promise<ResolvedEntitlements> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      plan: true,
      subscription: {
        select: { plan: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
      },
      entitlementOverrides: {
        select: { entitlement: true, enabled: true, expiresAt: true, reason: true },
      },
    },
  });

  if (!organization) {
    throw new EntitlementError('FEATURE_NOT_IN_PLAN', 'Workspace not found.', { organizationId });
  }

  const plan = effectivePlan(
    organization.subscription
      ? {
          plan: organization.subscription.plan,
          status: organization.subscription.status,
          currentPeriodEnd: organization.subscription.currentPeriodEnd,
        }
      : null,
    now,
  );

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
    status: organization.subscription?.status ?? 'NONE',
    currentPeriodEnd: organization.subscription?.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: organization.subscription?.cancelAtPeriodEnd ?? false,
    maxClients: definition.maxClients,
    maxActiveDomains: definition.maxActiveDomains,
    maxMembers: definition.maxMembers,
    dataRetentionDays: definition.dataRetentionDays,
    auditRetentionDays: definition.auditRetentionDays,
    features,
    overrides,
  };

  return bumped;
}

export { countCountedDomains } from '../inventory/inventory.service.js';

export async function quotaUsage(
  organizationId: string,
  quota: QuotaKey,
  plan: PlanTier,
  now = new Date(),
): Promise<{ used: number; limit: number }> {
  const definition = planCatalog[plan];

  if (quota === 'activeDomain') {
    return { used: await countCountedDomains(organizationId, definition.dataRetentionDays, now), limit: definition.maxActiveDomains };
  }

  if (quota === 'client') {
    return { used: await prisma.client.count({ where: { organizationId } }), limit: definition.maxClients };
  }

  return { used: await prisma.member.count({ where: { organizationId } }), limit: definition.maxMembers };
}

export async function assertFeature(organizationId: string, feature: EntitlementKey, now = new Date()): Promise<void> {
  const entitlements = await resolveEntitlements(organizationId, now);

  if (entitlements.features[feature]) {
    return;
  }

  const upgradeTo = nextTier(entitlements.plan);
  const requiredBy = Object.entries(planCatalog)
    .filter(([, definition]) => definition.features[feature])
    .map(([tier]) => tier)
    .sort(
      (left, right) =>
        planCatalog[left as PlanTier].prices.USD.monthlyMinor - planCatalog[right as PlanTier].prices.USD.monthlyMinor,
    )[0];

  throw new EntitlementError(
    'FEATURE_NOT_IN_PLAN',
    `${feature} is not included in ${entitlements.label}. Upgrade to ${requiredBy ? planCatalog[requiredBy as PlanTier].label : 'a higher plan'} to use it.`,
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

  throw new EntitlementError(
    'PLAN_LIMIT_REACHED',
    `${entitlements.label} includes ${usage.limit} ${label} and you have ${usage.used}. ` +
      (upgradeName
        ? `Upgrade to ${upgradeName} for ${planCatalog[upgradeTo!].maxActiveDomains} active domains, or remove one.`
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

export async function setOrganizationPlan(
  organizationId: string,
  plan: PlanTier,
  options: { status?: 'ACTIVE' | 'TRIALING' | 'CANCELLED' | 'PAST_DUE' | 'EXPIRED'; currentPeriodEnd?: Date | null; provider?: 'NONE' | 'RAZORPAY' | 'PADDLE'; providerSubscriptionId?: string | null } = {},
): Promise<void> {
  const status = options.status ?? 'ACTIVE';

  await prisma.$transaction([
    prisma.organization.update({ where: { id: organizationId }, data: { plan } }),
    prisma.subscription.upsert({
      where: { organizationId },
      create: {
        organizationId,
        plan,
        status,
        provider: options.provider ?? 'NONE',
        currentPeriodEnd: options.currentPeriodEnd ?? null,
        providerSubscriptionId: options.providerSubscriptionId ?? null,
      },
      update: {
        plan,
        status,
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
  return Object.values(planCatalog).map((plan) => ({
    ...plan,
    features: plan.features as unknown as Prisma.InputJsonValue,
  })) as unknown as Prisma.InputJsonValue;
}
