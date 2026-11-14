import Razorpay from 'razorpay';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { BillingProviderError, SignatureVerificationError } from './provider.js';
import { PROVIDER_TIMEOUT_MS, withTimeout } from './provider-timeout.js';
import type { MandateMethod } from './recurring-terms.js';

/**
 * The Razorpay calls billing makes, behind one timeout and one error shape.
 *
 * Shared by the provider adapter, the webhook handler and the renewal job, so
 * none of them holds its own client or reads the SDK's error object.
 *
 * Every amount is in paise. Nothing here handles a decimal amount, because a
 * rounding error is a real charge to a real customer.
 */

let client: Razorpay | null = null;

function razorpay(): Razorpay {
  if (client) {
    return client;
  }
  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new BillingProviderError(
      'Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.',
      'PROVIDER_NOT_CONFIGURED',
      503,
    );
  }
  client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  return client;
}

export function razorpayConfigured(): boolean {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

/**
 * Wraps an SDK call so a vendor error becomes our own shape.
 *
 * Bounded because the SDK's HTTP client has no timeout: a provider that
 * accepts the connection and then stalls would otherwise hold the request,
 * and the process's capacity with it. A not found is passed through as 404
 * because callers tell "gone" from "broken"; everything else is a 502 with
 * Razorpay's own sentence, so the screen can say what to fix.
 */
async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await withTimeout(operation, PROVIDER_TIMEOUT_MS, 'Razorpay');
  } catch (error) {
    if (error instanceof BillingProviderError) {
      throw error;
    }
    const statusCode = readStatusCode(error);
    if (statusCode === 404) {
      throw new BillingProviderError('Razorpay has no such record.', 'NOT_FOUND', 404);
    }
    throw new BillingProviderError(`Razorpay rejected the request: ${readDescription(error)}`, 'RAZORPAY_ERROR', 502, {
      razorpayCode: readCode(error),
      // Razorpay's own HTTP status, when it answered. A 4xx is a refusal of the
      // request itself; anything else (no answer, a 5xx) leaves open whether
      // the call took effect, which matters for a charge.
      razorpayStatus: statusCode,
    });
  }
}

/**
 * True when Razorpay answered and refused the request, so nothing was created.
 * False for a timeout, a dropped connection or a server error, after which a
 * charge may or may not exist.
 */
export function razorpayRefused(error: unknown): boolean {
  if (!(error instanceof BillingProviderError) || error.code !== 'RAZORPAY_ERROR') {
    return false;
  }
  const status = (error.detail as { razorpayStatus?: unknown } | undefined)?.razorpayStatus;
  return typeof status === 'number' && status >= 400 && status < 500;
}

export interface RegistrationLink {
  id: string;
  orderId: string;
  shortUrl: string;
}

/**
 * A hosted page that takes a payment and registers a mandate in the same step.
 *
 * Card and UPI charge `amountMinor` on the page. eNACH cannot carry the charge
 * as the link amount (Razorpay requires zero), so it goes as
 * `first_payment_amount`, which the bank takes with the mandate. Either way the
 * customer pays once and leaves a mandate behind.
 */
export async function createRegistrationLink(input: {
  method: MandateMethod;
  amountMinor: number;
  maxAmountMinor: number;
  customer: { name: string; email: string; contact: string };
  description: string;
  receipt: string;
  expireBy: Date;
  mandateExpiresAt: Date;
  notes: Record<string, string>;
}): Promise<RegistrationLink> {
  const registration =
    input.method === 'emandate'
      ? {
          method: 'emandate',
          max_amount: input.maxAmountMinor,
          expire_at: Math.floor(input.mandateExpiresAt.getTime() / 1000),
          first_payment_amount: input.amountMinor,
        }
      : {
          method: input.method,
          max_amount: input.maxAmountMinor,
          expire_at: Math.floor(input.mandateExpiresAt.getTime() / 1000),
          frequency: 'as_presented',
        };
  const link = (await call(() =>
    razorpay().subscriptions.createRegistrationLink({
      customer: input.customer,
      type: 'link',
      amount: input.method === 'emandate' ? 0 : input.amountMinor,
      currency: 'INR',
      description: input.description.slice(0, 2048),
      subscription_registration: registration,
      receipt: input.receipt.slice(0, 40),
      // We send our own emails, in the agency's words; Razorpay's would be a
      // second message about the same payment.
      email_notify: false,
      sms_notify: false,
      expire_by: Math.floor(input.expireBy.getTime() / 1000),
      notes: input.notes,
    } as never),
  )) as unknown as { id?: string; order_id?: string; short_url?: string };
  if (!link.id || !link.order_id || !link.short_url) {
    throw new BillingProviderError('Razorpay did not return a payment page.', 'RAZORPAY_NO_URL', 502);
  }
  return { id: link.id, orderId: link.order_id, shortUrl: link.short_url };
}

/** Closes a registration link so it can no longer be paid. Quiet when it is already closed. */
export async function cancelRegistrationLink(invoiceId: string): Promise<void> {
  await call(() => razorpay().invoices.cancel(invoiceId)).catch(() => undefined);
}

/**
 * An order for one renewal.
 *
 * For a card or UPI mandate the order carries the pre-debit notification:
 * Razorpay tells the customer's bank the amount and date, and a debit is only
 * accepted once `paymentAfter` has passed (at least 36 hours and 5 minutes
 * after the notice is delivered). An eNACH mandate needs no such notice.
 */
export async function createRenewalOrder(input: {
  amountMinor: number;
  receipt: string;
  notes: Record<string, string>;
  notification: { tokenId: string; paymentAfter: Date } | null;
}): Promise<{ id: string }> {
  const order = (await call(() =>
    razorpay().orders.create({
      amount: input.amountMinor,
      currency: 'INR',
      payment_capture: true,
      receipt: input.receipt.slice(0, 40),
      notes: input.notes,
      ...(input.notification
        ? {
            notification: {
              token_id: input.notification.tokenId,
              payment_after: Math.floor(input.notification.paymentAfter.getTime() / 1000),
            },
          }
        : {}),
    } as never),
  )) as unknown as { id?: string };
  if (!order.id) {
    throw new BillingProviderError('Razorpay did not return an order.', 'RAZORPAY_ERROR', 502);
  }
  return { id: order.id };
}

/** The pre-debit notice on an order: whether it reached the bank, and when. */
export async function fetchOrderNotification(
  orderId: string,
): Promise<{ status: string | null; deliveredAt: Date | null; paymentAfter: Date | null }> {
  const order = (await call(() => razorpay().orders.fetch(orderId))) as unknown as {
    notification?: { status?: string; delivered_at?: number | null; payment_after?: number | null } | null;
  };
  const n = order.notification ?? null;
  return {
    status: n?.status ?? null,
    deliveredAt: n?.delivered_at ? new Date(n.delivered_at * 1000) : null,
    paymentAfter: n?.payment_after ? new Date(n.payment_after * 1000) : null,
  };
}

/** Charges a renewal on the saved mandate. The result arrives by webhook. */
export async function chargeToken(input: {
  orderId: string;
  customerId: string;
  tokenId: string;
  amountMinor: number;
  email: string;
  contact: string;
  description: string;
  notes: Record<string, string>;
}): Promise<{ paymentId: string | null }> {
  const result = (await call(() =>
    razorpay().payments.createRecurringPayment({
      email: input.email,
      contact: input.contact,
      amount: input.amountMinor,
      currency: 'INR',
      order_id: input.orderId,
      customer_id: input.customerId,
      token: input.tokenId,
      recurring: '1',
      description: input.description.slice(0, 255),
      notes: input.notes,
    } as never),
  )) as unknown as { razorpay_payment_id?: string };
  return { paymentId: result.razorpay_payment_id ?? null };
}

export interface PaymentFacts {
  id: string;
  status: string | null;
  method: string | null;
  amountMinor: number;
  tokenId: string | null;
  customerId: string | null;
  orderId: string | null;
  email: string | null;
  contact: string | null;
  /** Razorpay's reason for a failed payment, when it gives one. */
  errorDescription: string | null;
}

export async function fetchPayment(paymentId: string): Promise<PaymentFacts> {
  const p = (await call(() => razorpay().payments.fetch(paymentId))) as unknown as Record<string, unknown>;
  return {
    id: String(p.id),
    status: typeof p.status === 'string' ? p.status : null,
    method: typeof p.method === 'string' ? p.method : null,
    amountMinor: typeof p.amount === 'number' ? p.amount : 0,
    tokenId: typeof p.token_id === 'string' ? p.token_id : null,
    customerId: typeof p.customer_id === 'string' ? p.customer_id : null,
    orderId: typeof p.order_id === 'string' ? p.order_id : null,
    email: typeof p.email === 'string' ? p.email : null,
    contact: typeof p.contact === 'string' ? p.contact : null,
    errorDescription: typeof p.error_description === 'string' ? p.error_description : null,
  };
}

/**
 * Every payment made against an order, newest first.
 *
 * What the renewal job asks when a charge request had no clear answer: the
 * order id is ours and unique per charge, so its payments say whether the
 * debit was made, whatever happened to the response.
 */
export async function fetchOrderPayments(orderId: string): Promise<PaymentFacts[]> {
  const listed = (await call(() => razorpay().orders.fetchPayments(orderId))) as unknown as {
    items?: Array<Record<string, unknown>>;
  };
  const createdAt = (p: Record<string, unknown>) => (typeof p.created_at === 'number' ? p.created_at : 0);
  return [...(listed.items ?? [])]
    .sort((a, b) => createdAt(b) - createdAt(a))
    .map((p) => ({
      id: String(p.id),
      status: typeof p.status === 'string' ? p.status : null,
      method: typeof p.method === 'string' ? p.method : null,
      amountMinor: typeof p.amount === 'number' ? p.amount : 0,
      tokenId: typeof p.token_id === 'string' ? p.token_id : null,
      customerId: typeof p.customer_id === 'string' ? p.customer_id : null,
      orderId: typeof p.order_id === 'string' ? p.order_id : null,
      email: typeof p.email === 'string' ? p.email : null,
      contact: typeof p.contact === 'string' ? p.contact : null,
      errorDescription: typeof p.error_description === 'string' ? p.error_description : null,
    }));
}

export interface TokenFacts {
  id: string;
  method: string | null;
  /** The mandate's state, `recurring_details.status`: `initiated`, `confirmed`, `rejected`, `paused`, `cancelled`. */
  status: string | null;
  maxAmountMinor: number | null;
}

export async function fetchToken(customerId: string, tokenId: string): Promise<TokenFacts> {
  const t = (await call(() => razorpay().customers.fetchToken(customerId, tokenId))) as unknown as {
    id: string;
    method?: string;
    max_amount?: number;
    recurring_details?: { status?: string } | null;
  };
  return {
    id: t.id,
    method: t.method ?? null,
    status: t.recurring_details?.status ?? null,
    maxAmountMinor: typeof t.max_amount === 'number' ? t.max_amount : null,
  };
}

/**
 * Ends a mandate at Razorpay, so it can never be charged again. Quiet when it
 * is already gone.
 *
 * Deleting a token only removes Razorpay's record: a UPI or eNACH mandate stays
 * registered with NPCI and the bank until it is cancelled, and Razorpay refuses
 * to delete one that is still active. So the mandate is cancelled first (PUT
 * …/cancel, which the SDK does not wrap), then deleted. A card token has no
 * cancel step and is deleted directly. A UPI cancellation can sit in
 * `cancellation_initiated` until NPCI confirms it; the token is then left for
 * Razorpay to close, which is safe because no debit runs in that state.
 */
export async function deleteToken(customerId: string, tokenId: string): Promise<void> {
  await cancelToken(customerId, tokenId);
  await call(() => razorpay().customers.deleteToken(customerId, tokenId)).catch((error: unknown) => {
    if (error instanceof BillingProviderError && error.status === 404) return;
    if (error instanceof BillingProviderError && /still active|cancel/i.test(error.message)) {
      // Cancellation is in transit at NPCI; the mandate can no longer be debited.
      return;
    }
    throw error;
  });
}

/** PUT /customers/:id/tokens/:id/cancel. Quiet for a card token, which has nothing to cancel. */
async function cancelToken(customerId: string, tokenId: string): Promise<void> {
  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new BillingProviderError('Razorpay is not configured.', 'PROVIDER_NOT_CONFIGURED', 503);
  }
  const url = `https://api.razorpay.com/v1/customers/${encodeURIComponent(customerId)}/tokens/${encodeURIComponent(tokenId)}/cancel`;
  const response = await withTimeout(
    () =>
      fetch(url, {
        method: 'PUT',
        headers: { authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` },
      }),
    PROVIDER_TIMEOUT_MS,
    'Razorpay',
  );
  if (response.ok || response.status === 404) {
    return;
  }
  // A card token, or one already cancelled, answers 400: nothing left to cancel.
  if (response.status === 400) {
    return;
  }
  const body = (await response.json().catch(() => null)) as { error?: { description?: string } } | null;
  throw new BillingProviderError(
    `Razorpay rejected the request: ${body?.error?.description ?? `HTTP ${response.status}`}`,
    'RAZORPAY_ERROR',
    502,
  );
}

/** Refunds a payment, in full when `amountMinor` is at least what was captured. */
export async function refundPayment(input: {
  paymentId: string;
  amountMinor: number;
  capturedMinor: number;
  notes: Record<string, string>;
}): Promise<{ id: string | null }> {
  const full = input.amountMinor >= input.capturedMinor;
  const refund = (await call(() =>
    razorpay().payments.refund(input.paymentId, {
      ...(full ? {} : { amount: Math.round(input.amountMinor) }),
      speed: 'optimum',
      notes: input.notes,
    }),
  )) as { id?: string };
  return { id: refund?.id ?? null };
}

function readStatusCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = (error as { statusCode?: unknown }).statusCode;
  return typeof candidate === 'number' ? candidate : null;
}

function readCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const inner = (error as { error?: { code?: unknown; reason?: unknown } }).error;
  if (inner && typeof inner.reason === 'string' && inner.reason) return inner.reason;
  return inner && typeof inner.code === 'string' ? inner.code : null;
}

/**
 * Razorpay's own reason. The SDK rejects with a plain object,
 * `{ statusCode, error: { code, description } }`, not an Error, so reading only
 * `Error.message` reported every refusal as "Unknown Razorpay error" (session 11).
 */
function readDescription(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const inner = (error as { error?: { description?: unknown } }).error;
    if (inner && typeof inner.description === 'string' && inner.description) {
      return inner.description;
    }
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Unknown Razorpay error.';
}

/**
 * Verifies a Razorpay webhook signature: HMAC-SHA256 of the raw body, hex.
 *
 * The signature covers the raw request body, so the body must be read before
 * any JSON parsing; re-serialising it changes the bytes. A replay is not a
 * separate risk because every event is deduplicated before it changes anything.
 *
 * Computed and compared here, in constant time, rather than through the SDK's
 * helper, which compares the two strings with `===` and so reveals how much of
 * a guessed signature was right.
 */
export function verifyRazorpaySignature(rawBody: string, signature: string | undefined, secret: string): void {
  if (!signature) {
    throw new SignatureVerificationError('The Razorpay webhook had no signature header.');
  }
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex'), 'utf8');
  const presented = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    throw new SignatureVerificationError('The Razorpay webhook signature did not match.');
  }
}

export function razorpayWebhookSecret(): string | null {
  return env.RAZORPAY_WEBHOOK_SECRET ?? null;
}
