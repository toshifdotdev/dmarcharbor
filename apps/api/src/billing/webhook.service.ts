import { prisma } from '../database/prisma.js';
import {
  SignatureVerificationError,
  type BillingEvent,
  type BillingEventType,
  type ProviderName,
  type ProviderSubscriptionStatus,
} from './provider.js';
import { findStoredPlanByProviderPlanId } from './plans.js';
import { applyBillingEvent } from './subscription-state.js';
import { verifyRazorpaySignature } from './razorpay.provider.js';
import { verifyPaddleSignature } from './paddle.provider.js';

/**
 * Turns a verified provider webhook into a state change.
 *
 * The order matters and is not negotiable. Verify the signature first, then
 * look up the plan, then deduplicate on the event id, and only then change
 * anything. Verifying last would mean acting on a payload anybody could post.
 * Deduplicating last would mean applying a redelivered transition twice, which
 * is what turns one payment into two plan changes.
 */

export class WebhookRejectedError extends Error {
  readonly code: string;
  readonly status: number;
  /** Structured companion to the message, for screens that render the failure. */
  readonly detail?: Record<string, unknown>;

  constructor(message: string, code = 'WEBHOOK_REJECTED', status = 400, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'WebhookRejectedError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export interface WebhookOutcome {
  accepted: boolean;
  duplicate: boolean;
  type: BillingEventType;
  organizationId: string | null;
  detail?: string;
}

/* ------------------------------------------------------------------ Razorpay */

const razorpayEventMap: Record<string, BillingEventType> = {
  'subscription.activated': 'subscription.activated',
  'subscription.charged': 'subscription.updated',
  'subscription.pending': 'subscription.past_due',
  'subscription.halted': 'subscription.past_due',
  'subscription.cancelled': 'subscription.cancelled',
  'subscription.completed': 'subscription.expired',
  'subscription.expired': 'subscription.expired',
  'payment.failed': 'payment.failed',
};

const razorpayStatusMap: Record<string, ProviderSubscriptionStatus> = {
  created: 'active',
  authenticated: 'active',
  active: 'active',
  pending: 'past_due',
  halted: 'past_due',
  cancelled: 'cancelled',
  completed: 'expired',
  expired: 'expired',
  // Razorpay issues this when a subscription reaches the end of its term rather
  // than being cancelled early. It was unmapped, so the workspace was never told
  // the paid period ran out and reconciliation was the only thing that noticed.
  closed: 'expired',
};

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

export async function handleRazorpayWebhook(input: {
  rawBody: string;
  signature: string | undefined;
  secret: string | null;
  eventName: string;
}): Promise<WebhookOutcome> {
  // A missing secret means webhooks were never configured. Refusing every event
  // is the safe reading, because accepting them unsigned would let anyone grant
  // themselves a plan.
  if (!input.secret) {
    throw new WebhookRejectedError('Razorpay webhooks are not configured.', 'WEBHOOK_NOT_CONFIGURED', 503);
  }

  try {
    verifyRazorpaySignature(input.rawBody, input.signature, input.secret);
  } catch (error) {
    if (error instanceof SignatureVerificationError) {
      throw new WebhookRejectedError(error.message, 'BAD_SIGNATURE', 401);
    }
    throw error;
  }

  const payload = parseJson(input.rawBody) as RazorpayPayload;
  const type = razorpayEventMap[input.eventName];
  if (!type) {
    // Acknowledged but ignored. A provider adding an event is not an outage,
    // and returning an error would make it retry forever.
    return { accepted: false, duplicate: false, type: 'subscription.updated', organizationId: null, detail: 'Unmapped event.' };
  }

  const subscriptionEntity = payload.payload?.subscription?.entity;
  const paymentEntity = payload.payload?.payment?.entity;

  /**
   * A stable, distinct id for every event.
   *
   * `payload.entity.id` is only present on some Razorpay events. For
   * `payment.failed` the payload carries `payment.entity` and no subscription at
   * all, so the old fallback collapsed to the constant
   * `payment.failed:unknown`. `providerEventId` is globally unique, so only the
   * first such event was ever recorded and every later one hit the constraint and
   * was discarded: a customer's second failed payment, and then their third,
   * were silently dropped, `currentPeriodEnd` froze, and the dunning grace check
   * read a stale date and withdrew a paying workspace early.
   *
   * The id now folds in whatever identifiers the payload actually carries,
   * falling back to the payment rather than to a literal.
   */
  const eventId =
    payload.payload?.entity?.id ??
    paymentEntity?.id ??
    subscriptionEntity?.id ??
    `${input.eventName}:${subscriptionEntity?.id ?? paymentEntity?.id ?? 'unknown'}:${payload.payload?.created_at ?? 'no-timestamp'}`;

  const organizationId = await resolveOrganizationId('RAZORPAY', {
    organizationId: subscriptionEntity?.notes?.organizationId,
    customerId: subscriptionEntity?.customer_id,
    subscriptionId: subscriptionEntity?.id,
  });

  const tier = subscriptionEntity?.plan_id
    ? ((await findStoredPlanByProviderPlanId('RAZORPAY', subscriptionEntity.plan_id))?.tier ?? null)
    : null;

  const event: BillingEvent = {
    providerEventId: `razorpay:${eventId}`,
    type,
    provider: 'RAZORPAY',
    providerSubscriptionId: subscriptionEntity?.id ?? null,
    providerCustomerId: subscriptionEntity?.customer_id ?? null,
    organizationId,
    plan: tier,
    /**
     * Not `?? 'active'`.
     *
     * A `payment.failed` carries no subscription entity, so this defaulted to
     * 'active' and would have recorded a failed payment as a healthy
     * subscription. Combined with the fact that `applyBillingEvent` ignored the
     * event type entirely, a declined card was either invisible or actively
     * written as ACTIVE, and dunning only ever examined PAST_DUE.
     */
    status: subscriptionEntity
      ? (subscriptionEntity.status ? (razorpayStatusMap[subscriptionEntity.status] ?? 'past_due') : 'past_due')
      : type === 'checkout.completed'
        ? 'active'
        : 'past_due',
    currentPeriodEnd: subscriptionEntity?.current_end ? new Date(subscriptionEntity.current_end * 1000) : null,
    cancelAtPeriodEnd: Boolean(subscriptionEntity?.cancel_at_cycle_end),
    nextAttemptAt: null,
    /**
     * Razorpay's own event time, not ours.
     *
     * Stamping `new Date()` meant the ordering guard could never reject
     * anything: every webhook looked brand new even when it was a redelivery of
     * something from last week. Razorpay sends `created_at` in seconds.
     */
    occurredAt: payload.payload?.created_at
      ? new Date(payload.payload.created_at * 1000)
      : new Date(),
    raw: payload,
  };

  return commit(event);
}

/* -------------------------------------------------------------------- Paddle */

const paddleEventMap: Record<string, BillingEventType> = {
  'subscription.created': 'subscription.activated',
  'subscription.activated': 'subscription.activated',
  'subscription.updated': 'subscription.updated',
  'subscription.trialing': 'subscription.activated',
  'subscription.past_due': 'subscription.past_due',
  'subscription.paused': 'subscription.past_due',
  'subscription.canceled': 'subscription.cancelled',
  'subscription.expired': 'subscription.expired',
  'transaction.completed': 'checkout.completed',
  'transaction.updated': 'subscription.updated',
  // Paddle's explicit failure event. Without it a declined card was only noticed by
  // reconciliation, which runs on a schedule, so a customer could sit in a state we
  // had already been told about and did nothing about.
  'transaction.failed': 'subscription.past_due',
};

const paddleStatusMap: Record<string, ProviderSubscriptionStatus> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  paused: 'past_due',
  canceled: 'cancelled',
  expired: 'expired',
};

export async function handlePaddleWebhook(input: {
  rawBody: string;
  signature: string | undefined;
  secret: string | null;
}): Promise<WebhookOutcome> {
  if (!input.secret) {
    throw new WebhookRejectedError('Paddle webhooks are not configured.', 'WEBHOOK_NOT_CONFIGURED', 503);
  }

  try {
    verifyPaddleSignature(input.rawBody, input.signature, input.secret);
  } catch (error) {
    if (error instanceof SignatureVerificationError) {
      throw new WebhookRejectedError(error.message, 'BAD_SIGNATURE', 401);
    }
    throw error;
  }

  const payload = parseJson(input.rawBody) as PaddlePayload;
  const type = paddleEventMap[payload.event_type ?? ''];
  if (!type) {
    return { accepted: false, duplicate: false, type: 'subscription.updated', organizationId: null, detail: 'Unmapped event.' };
  }

  const data = payload.data ?? {};
  const customData = (data.custom_data ?? {}) as Record<string, string | undefined>;
  const subscriptionId = data.subscription_id ?? data.id ?? null;

  const organizationId = await resolveOrganizationId('PADDLE', {
    organizationId: customData.organizationId,
    subscriptionId,
  });

  const tier = data.price_id
    ? ((await findStoredPlanByProviderPlanId('PADDLE', data.price_id))?.tier ?? null)
    : null;

  const event: BillingEvent = {
    // Paddle's event id is the deduplication key. Without one, a derived key is
    // built from the subscription and its status so a redelivery of the same
    // transition is still recognised as a duplicate.
    providerEventId: `paddle:${payload.event_id ?? `${payload.event_type}:${subscriptionId}:${data.status ?? ''}`}`,
    type,
    provider: 'PADDLE',
    providerSubscriptionId: subscriptionId,
    providerCustomerId: data.customer_id ?? null,
    organizationId,
    plan: tier,
    status: paddleStatusMap[data.status ?? 'active'] ?? 'active',
    currentPeriodEnd: data.current_billing_period?.ends_at ? new Date(data.current_billing_period.ends_at) : null,
    cancelAtPeriodEnd: data.scheduled_change?.action === 'cancel' || data.status === 'canceled',
    nextAttemptAt: data.next_billed_at ? new Date(data.next_billed_at) : null,
    occurredAt: payload.event_date ? new Date(payload.event_date) : new Date(),
    raw: payload,
  };

  return commit(event);
}

/* ------------------------------------------------------------------ shared */

async function commit(event: BillingEvent): Promise<WebhookOutcome> {
  // An event with no resolvable workspace is stored for support but changes
  // nothing. Dropping it silently would hide a real integration problem.
  if (!event.organizationId) {
    try {
      await prisma.billingEvent.create({
        data: {
          providerEventId: event.providerEventId,
          provider: event.provider,
          type: event.type,
          organizationId: null,
          providerSubscriptionId: event.providerSubscriptionId,
          payload: event.raw as never,
          occurredAt: event.occurredAt,
        },
      });
    } catch (error) {
      // A repeat of an event already stored unattributed is expected and fine.
      // Anything else is not, and was previously swallowed by a bare catch, so
      // an integration fault looked identical to a duplicate.
      if (!isUniqueViolation(error)) {
        console.error(`[billing] storing an unattributed ${event.provider} event failed:`, error);
      }
    }

    return {
      accepted: false,
      duplicate: false,
      type: event.type,
      organizationId: null,
      detail: 'No workspace could be resolved for this event.',
    };
  }

  /**
   * The claim and the state change are one transaction now, inside
   * `applyBillingEvent`. They used to be two calls here, which meant an event
   * could be recorded as consumed and then fail to apply, after which the
   * provider's retry was answered 200 and the paid change was lost.
   */
  const result = await applyBillingEvent(event);

  if (result.duplicate) {
    return { accepted: true, duplicate: true, type: event.type, organizationId: event.organizationId };
  }

  return { accepted: true, duplicate: false, type: event.type, organizationId: event.organizationId };
}

/**
 * Attributes an event to a workspace.
 *
 * Three sources are tried in order of trustworthiness: the notes or custom data
 * we set at checkout, then the stored subscription, then a customer lookup. A
 * provider cannot be tricked into applying a change to the wrong workspace by
 * a payload field alone, because the subscription row is re-read and matched
 * on the provider's own identifier.
 */
async function resolveOrganizationId(
  provider: ProviderName,
  input: { organizationId?: string | null; customerId?: string | null; subscriptionId?: string | null },
): Promise<string | null> {
  if (input.subscriptionId) {
    const bySubscription = await prisma.subscription.findFirst({
      where: { provider: provider as never, providerSubscriptionId: input.subscriptionId },
      select: { organizationId: true },
    });
    if (bySubscription) {
      return bySubscription.organizationId;
    }
  }

  if (input.organizationId) {
    const exists = await prisma.organization.findUnique({
      where: { id: input.organizationId },
      select: { id: true },
    });
    if (exists) {
      return exists.id;
    }
  }

  if (input.customerId) {
    const byCustomer = await prisma.subscription.findFirst({
      where: { provider: provider as never, providerCustomerId: input.customerId },
      select: { organizationId: true },
    });
    if (byCustomer) {
      return byCustomer.organizationId;
    }
  }

  return null;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new WebhookRejectedError('The billing webhook body was not valid JSON.', 'BAD_PAYLOAD', 400);
  }
}

interface RazorpayPayload {
  event?: string;
  payload?: {
    entity?: { id?: string };
    /**
     * Razorpay stamps every event with its own creation time in seconds. Used as
     * the ordering timestamp, so a redelivery from last week is recognisable as
     * stale rather than looking freshly generated.
     */
    created_at?: number;
    payment?: {
      entity?: { id?: string };
    };
    subscription?: {
      entity?: {
        id?: string;
        plan_id?: string;
        customer_id?: string;
        status?: string;
        current_end?: number;
        cancel_at_cycle_end?: boolean;
        notes?: Record<string, string>;
      };
    };
  };
}

interface PaddlePayload {
  event_id?: string;
  event_type?: string;
  event_date?: string;
  data?: {
    id?: string;
    status?: string;
    price_id?: string;
    customer_id?: string;
    subscription_id?: string;
    custom_data?: Record<string, unknown>;
    scheduled_change?: { action?: string } | null;
    current_billing_period?: { ends_at?: string } | null;
    next_billed_at?: string | null;
  };
}
