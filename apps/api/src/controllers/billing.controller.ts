import type { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { providerFor } from '../billing/registry.js';
import { reconcileWithProvider } from '../billing/subscription-state.js';
import { runReconciliation } from '../billing/dunning.js';
import { BillingProviderError } from '../billing/provider.js';
import {
  CheckoutError,
  billingPortalUrl,
  billingCurrencyPreference,
  billingStatus,
  setBillingCurrencyPreference,
  cancelSubscription,
  changePlan,
  resumeSubscription,
  startCheckout,
  syncStatus,
} from '../billing/checkout.service.js';
import { WebhookRejectedError, handlePaddleWebhook, handleRazorpayWebhook } from '../billing/webhook.service.js';
import { razorpayWebhookSecret } from '../billing/razorpay.provider.js';
import { paddleWebhookSecret } from '../billing/paddle.provider.js';

const checkoutSchema = z.object({
  plan: z.enum(['FAIRWAY', 'HARBOR', 'ADMIRALTY']),
  interval: z.enum(['monthly', 'annual']).default('monthly'),
  currency: z.enum(['USD', 'INR']).default('INR'),
  contact: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email(),
    taxId: z.string().trim().max(32).nullable().optional(),
  }),
});

const planChangeSchema = z.object({
  plan: z.enum(['FAIRWAY', 'HARBOR', 'ADMIRALTY', 'MOORING']),
  interval: z.enum(['monthly', 'annual']).default('monthly'),
});

function sendBillingError(response: Response, error: unknown): void {
  if (error instanceof CheckoutError || error instanceof BillingProviderError || error instanceof WebhookRejectedError) {
    // detail is spread rather than omitted. A refusal like a downgrade that is
    // over quota carries the specific numbers the customer has to act on, and
    // serialising only { code, message } left the UI with a paragraph to parse
    // instead of a table to render.
    response.status(error.status).json({
      error: { code: error.code, message: error.message, ...(error.detail ?? {}) },
    });
    return;
  }
  response.status(500).json({ error: { code: 'INTERNAL', message: 'Billing could not complete that request.' } });
}

export async function startCheckoutController(request: Request, response: Response): Promise<void> {
  const body = checkoutSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: body.error.issues[0]?.message ?? 'A plan and contact are required.' } });
    return;
  }

  try {
    const summary = await startCheckout({
      organizationId: response.locals.organizationId,
      actorUserId: response.locals.session?.user?.id,
      plan: body.data.plan,
      interval: body.data.interval,
      currency: body.data.currency,
      contact: body.data.contact,
    });

    // The browser is sent to the provider's hosted page. No card data ever
    // reaches this server, which is why there is nothing to store or protect.
    response.status(201).json(summary);
  } catch (error) {
    sendBillingError(response, error);
  }
}

export async function changePlanController(request: Request, response: Response): Promise<void> {
  const body = planChangeSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: body.error.issues[0]?.message ?? 'A plan is required.' } });
    return;
  }

  // Downgrading to the free plan is a cancellation, not a plan change, and it
  // is treated as one so the customer keeps the period they already paid for.
  if (body.data.plan === 'MOORING') {
    await cancelSubscription({ organizationId: response.locals.organizationId, actorUserId: response.locals.session?.user?.id });
    response.json({ status: 'cancelling', effectiveAt: 'cycle_end' });
    return;
  }

  try {
    await changePlan({
      organizationId: response.locals.organizationId,
      actorUserId: response.locals.session?.user?.id,
      plan: body.data.plan,
      interval: body.data.interval,
    });

    response.json({ status: 'scheduled', effectiveAt: 'cycle_end' });
  } catch (error) {
    sendBillingError(response, error);
  }
}

export async function cancelSubscriptionController(request: Request, response: Response): Promise<void> {
  try {
    await cancelSubscription({ organizationId: response.locals.organizationId, actorUserId: response.locals.session?.user?.id });
    const status = await billingStatus(response.locals.organizationId);
    response.json({ status: 'cancelling', accessUntil: status.currentPeriodEnd });
  } catch (error) {
    sendBillingError(response, error);
  }
}

export async function resumeSubscriptionController(request: Request, response: Response): Promise<void> {
  try {
    await resumeSubscription({ organizationId: response.locals.organizationId, actorUserId: response.locals.session?.user?.id });
    response.json({ status: 'active' });
  } catch (error) {
    sendBillingError(response, error);
  }
}

export async function billingCurrencyController(request: Request, response: Response): Promise<void> {
  try {
    response.json(await billingCurrencyPreference(response.locals.organizationId));
  } catch (error) {
    sendBillingError(response, error);
  }
}

export async function setBillingCurrencyController(request: Request, response: Response): Promise<void> {
  const parsed = z.object({ currency: z.enum(['USD', 'INR']) }).safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Choose a currency.' } });
    return;
  }

  try {
    response.json(
      await setBillingCurrencyPreference({
        organizationId: response.locals.organizationId,
        currency: parsed.data.currency,
      }),
    );
  } catch (error) {
    sendBillingError(response, error);
  }
}

export async function billingStatusController(request: Request, response: Response): Promise<void> {
  try {
    response.json(await billingStatus(response.locals.organizationId));
  } catch (error) {
    sendBillingError(response, error);
  }
}

export async function billingPortalController(request: Request, response: Response): Promise<void> {
  try {
    const url = await billingPortalUrl({
      organizationId: response.locals.organizationId,
      returnUrl: `${env.BETTER_AUTH_URL}/app/billing`,
    });
    response.json({ url });
  } catch (error) {
    sendBillingError(response, error);
  }
}

/** Operator view of which provider plans still need creating. */
export async function planSyncStatusController(request: Request, response: Response): Promise<void> {
  const provider = typeof request.query.provider === 'string' ? request.query.provider : 'RAZORPAY';
  const currency = request.query.currency === 'USD' ? 'USD' : 'INR';

  if (provider !== 'RAZORPAY' && provider !== 'PADDLE') {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'provider must be RAZORPAY or PADDLE.' } });
    return;
  }

  response.json({ provider, currency, plans: await syncStatus(provider, currency) });
}

/**
 * Runs reconciliation now, on demand.
 *
 * The scheduled reconciler exists so a missed webhook repairs itself within
 * six hours. This exists for the case where six hours is too long to answer a
 * question a customer is already asking, such as "I paid an hour ago and my plan
 * has not changed". Without it, support can only tell somebody to wait.
 *
 * A whole-workspace reconciliation is the common case and is a full sweep.
 * Passing an organization narrows it to that one subscription, which is what
 * support actually wants, and avoids a provider API call per customer.
 *
 * Staff only, on the same credential as plan changes. An endpoint that makes
 * outbound provider calls on demand is not something a workspace role should
 * reach.
 */
export async function reconcileController(request: Request, response: Response): Promise<void> {
  const organizationId = typeof request.query.organizationId === 'string' ? request.query.organizationId : undefined;

  if (organizationId) {
    const subscription = await prisma.subscription.findUnique({
      where: { organizationId },
      select: { provider: true, providerSubscriptionId: true },
    });

    if (!subscription?.providerSubscriptionId || subscription.provider === 'NONE') {
      response.status(404).json({
        error: { code: 'NO_SUBSCRIPTION', message: 'That workspace has no provider subscription to reconcile.' },
      });
      return;
    }

    const provider = providerFor(subscription.provider);
    const applied = await reconcileWithProvider(organizationId, provider);

    response.json({
      organizationId,
      matched: applied !== null,
      applied: applied?.applied ?? false,
      duplicate: applied?.duplicate ?? false,
      plan: applied?.plan ?? null,
      status: applied?.status ?? null,
    });
    return;
  }

  response.json(await runReconciliation());
}

/* ------------------------------------------------------------------ webhooks */

/**
 * Razorpay webhook.
 *
 * The raw body is required. A signature is computed over the exact bytes
 * Razorpay sent, so parsing and re-serialising the JSON before verifying it
 * changes those bytes and the check fails intermittently. That is the single
 * most common cause of a webhook that "sometimes" verifies.
 */
export async function razorpayWebhookController(request: Request, response: Response): Promise<void> {
  try {
    const outcome = await handleRazorpayWebhook({
      rawBody: readRawBody(request),
      signature: request.header('x-razorpay-signature'),
      secret: razorpayWebhookSecret(),
      eventName: request.header('x-razorpay-event') ?? '',
    });

    // Always 200 once the signature is trusted, including for a duplicate or an
    // unmapped event. Any other status makes the provider retry indefinitely for
    // something that will never change.
    response.status(200).json(outcome);
  } catch (error) {
    sendBillingError(response, error);
  }
}

export async function paddleWebhookController(request: Request, response: Response): Promise<void> {
  try {
    const outcome = await handlePaddleWebhook({
      rawBody: readRawBody(request),
      signature: request.header('paddle-signature'),
      secret: paddleWebhookSecret(),
    });

    response.status(200).json(outcome);
  } catch (error) {
    sendBillingError(response, error);
  }
}

function readRawBody(request: Request): string {
  const raw = (request as Request & { rawBody?: string }).rawBody;
  if (typeof raw === 'string') {
    return raw;
  }
  // Only reached if the raw body capture middleware is missing, which is a
  // deployment error rather than a bad request.
  return JSON.stringify(request.body ?? {});
}
