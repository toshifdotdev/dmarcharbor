import type { PlanTier, Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { bandIndexFor, planCatalog } from '../services/entitlements/plan-catalog.js';
import { quotaUsage } from '../services/entitlements/entitlement.service.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { providerFor } from './registry.js';

/**
 * How many units a provider should bill for a plan, and in which price band.
 *
 * A flat plan always bills one, in band 0. A per-domain plan bills the active
 * domains counted across the owner's account, in the band that count falls in,
 * with that band's minimum as the floor. Measured here, server side: a quantity
 * sent by a client would be a number the customer controls.
 */
export async function billableQuantity(
  organizationId: string,
  plan: PlanTier,
  now = new Date(),
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{ quantity: number; activeDomains: number; minimum: number | null; band: number }> {
  const definition = planCatalog[plan];
  const activeDomains = (await quotaUsage(organizationId, 'activeDomain', plan, now, client)).used;

  if (definition.pricing !== 'per_domain') {
    return { quantity: 1, activeDomains, minimum: null, band: 0 };
  }

  const band = bandIndexFor(plan, activeDomains);
  const minimum = Math.max(1, definition.bands?.[band]?.minimumQuantity ?? definition.minimumQuantity ?? 1);
  return { quantity: Math.max(minimum, activeDomains), activeDomains, minimum, band };
}

/**
 * The quantity a stored subscription is billed at, for display and refunds.
 *
 * A per-domain subscription can never have been charged below its plan's
 * smallest minimum: checkout and every sync bill at least that many. The stored
 * column defaults to 1 and stays there when a provider event omits the
 * quantity, so reading it raw would show a Fleet customer a one-domain bill and
 * refund them a seventy-fifth of what they paid. The floor is the smallest true
 * answer. The band follows from the quantity (see `bandIndexFor`).
 */
export function billedQuantity(plan: PlanTier, storedQuantity: number | null | undefined): number {
  const definition = planCatalog[plan];
  if (definition.pricing !== 'per_domain') {
    return 1;
  }
  return Math.max(definition.minimumQuantity ?? 1, Math.trunc(storedQuantity ?? 1), 1);
}

export interface QuantitySyncOutcome {
  checked: number;
  updated: number;
  unchanged: number;
  failed: number;
}

/**
 * Pushes next period's per-domain quantity, and its band, to the provider
 * inside the 48 hour window before renewal.
 *
 * Each month is billed at the count measured just before it starts, with no
 * proration. A count that crosses into another band moves the subscription to
 * that band's provider plan at the same time, so the unit price and the count
 * always change together. The marker is claimed conditionally before the
 * provider call, so two instances cannot both push the same change; a failure
 * puts it back so the next run retries rather than silently skipping a period.
 */
export async function syncPerDomainQuantities(now = new Date()): Promise<QuantitySyncOutcome> {
  const windowEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  const rows = await prisma.subscription.findMany({
    where: {
      plan: 'FLEET',
      provider: { not: 'NONE' },
      providerSubscriptionId: { not: null },
      status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
      cancelAtPeriodEnd: false,
      pendingPlan: null,
      currentPeriodEnd: { gt: now, lte: windowEnd },
    },
    select: {
      id: true,
      organizationId: true,
      provider: true,
      providerSubscriptionId: true,
      quantity: true,
      quantitySyncedPeriodEnd: true,
      currentPeriodEnd: true,
    },
  });

  const due = rows.filter(
    (row) =>
      row.currentPeriodEnd !== null &&
      (row.quantitySyncedPeriodEnd === null ||
        row.quantitySyncedPeriodEnd.getTime() !== row.currentPeriodEnd.getTime()),
  );

  const outcome: QuantitySyncOutcome = { checked: due.length, updated: 0, unchanged: 0, failed: 0 };

  for (const row of due) {
    const periodEnd = row.currentPeriodEnd!;
    const previousMarker = row.quantitySyncedPeriodEnd;

    // Claim the period before doing anything outward. A second instance reads
    // the old marker, loses this conditional write, and does not call the
    // provider at all.
    const claim = await prisma.subscription.updateMany({
      where: {
        id: row.id,
        quantitySyncedPeriodEnd: previousMarker === null ? null : previousMarker,
      },
      data: { quantitySyncedPeriodEnd: periodEnd },
    });

    if (claim.count !== 1) {
      outcome.unchanged += 1;
      continue;
    }

    let quantity: number;
    let activeDomains: number;
    let minimum: number | null;
    let band: number;
    try {
      ({ quantity, activeDomains, minimum, band } = await billableQuantity(row.organizationId, 'FLEET', now));
    } catch (error) {
      await releaseClaim(row.id, periodEnd, previousMarker);
      outcome.failed += 1;
      await auditFailure(row.organizationId, row.providerSubscriptionId ?? row.organizationId, error);
      continue;
    }

    if (quantity === row.quantity) {
      outcome.unchanged += 1;
      continue;
    }

    const previousBand = bandIndexFor('FLEET', billedQuantity('FLEET', row.quantity));

    try {
      const provider = providerFor(row.provider as 'RAZORPAY' | 'PADDLE');
      await provider.updateQuantity({
        providerSubscriptionId: row.providerSubscriptionId!,
        plan: 'FLEET',
        quantity,
        band,
      });
    } catch (error) {
      await releaseClaim(row.id, periodEnd, previousMarker);
      outcome.failed += 1;
      await auditFailure(
        row.organizationId,
        row.providerSubscriptionId ?? row.organizationId,
        error,
        { from: row.quantity, to: quantity, activeDomains, minimum, band, effectiveAt: periodEnd.toISOString() },
      );
      continue;
    }

    await prisma.subscription.update({
      where: { id: row.id },
      data: { quantity },
    });

    outcome.updated += 1;

    await recordAuditEvent({
      organizationId: row.organizationId,
      action: 'BILLING_QUANTITY_UPDATED',
      targetType: 'subscription',
      targetId: row.providerSubscriptionId ?? row.organizationId,
      detail: {
        from: row.quantity,
        to: quantity,
        activeDomains,
        minimum,
        band,
        ...(band !== previousBand ? { fromBand: previousBand } : {}),
        effectiveAt: periodEnd.toISOString(),
      },
    });
  }

  return outcome;
}

/**
 * Puts a per-domain subscription bought through a provider's checkout back on
 * the count measured here.
 *
 * Paddle's checkout shows a quantity stepper for any price whose range allows
 * more than one unit, and a Fleet price has to allow 1 to 5,000 for the
 * monthly sync to work. A customer could therefore buy 320 domains' worth of
 * Fleet for the price of one (session 11). The count they typed is replaced by
 * `billableQuantity`, and the difference for the period already started is
 * billed or credited at once. Failure is audited, not thrown: the payment
 * itself stands, and the next sync before renewal corrects the count anyway.
 */
export async function correctCheckoutQuantity(
  input: {
    organizationId: string;
    provider: 'RAZORPAY' | 'PADDLE';
    providerSubscriptionId: string;
    plan: PlanTier;
    quantity: number | null;
  },
  now = new Date(),
): Promise<'unchanged' | 'corrected' | 'failed'> {
  if (planCatalog[input.plan].pricing !== 'per_domain' || input.quantity === null) {
    return 'unchanged';
  }

  let measured: Awaited<ReturnType<typeof billableQuantity>>;
  try {
    measured = await billableQuantity(input.organizationId, input.plan, now);
  } catch (error) {
    await auditFailure(input.organizationId, input.providerSubscriptionId, error, { reason: 'checkout_quantity' });
    return 'failed';
  }

  if (measured.quantity === input.quantity) {
    return 'unchanged';
  }

  try {
    await providerFor(input.provider).updateQuantity({
      providerSubscriptionId: input.providerSubscriptionId,
      plan: input.plan,
      quantity: measured.quantity,
      band: measured.band,
      prorateNow: true,
    });
  } catch (error) {
    await auditFailure(input.organizationId, input.providerSubscriptionId, error, {
      reason: 'checkout_quantity',
      from: input.quantity,
      to: measured.quantity,
    });
    return 'failed';
  }

  await prisma.subscription.updateMany({
    where: { organizationId: input.organizationId, providerSubscriptionId: input.providerSubscriptionId },
    data: { quantity: measured.quantity },
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    action: 'BILLING_QUANTITY_UPDATED',
    targetType: 'subscription',
    targetId: input.providerSubscriptionId,
    detail: {
      reason: 'checkout_quantity',
      from: input.quantity,
      to: measured.quantity,
      activeDomains: measured.activeDomains,
      minimum: measured.minimum,
      band: measured.band,
      effectiveAt: now.toISOString(),
    },
  });

  return 'corrected';
}

async function releaseClaim(
  subscriptionId: string,
  claimedPeriodEnd: Date,
  previousMarker: Date | null,
): Promise<void> {
  await prisma.subscription.updateMany({
    where: { id: subscriptionId, quantitySyncedPeriodEnd: claimedPeriodEnd },
    data: { quantitySyncedPeriodEnd: previousMarker },
  });
}

async function auditFailure(
  organizationId: string,
  targetId: string,
  error: unknown,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const message = error instanceof Error ? error.message : 'The quantity could not be updated at the provider.';
  await recordAuditEvent({
    organizationId,
    action: 'SUBSCRIPTION_UPDATED',
    targetType: 'subscription',
    targetId,
    detail: {
      event: 'quantity_sync_failed',
      message: message.slice(0, 240),
      ...detail,
    },
  });
}
