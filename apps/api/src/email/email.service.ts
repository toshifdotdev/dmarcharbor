import { Resend } from 'resend';
import { env } from '../config/env.js';
import { enqueueEmail } from '../services/email-queue.service.js';
import { EMAIL_SEND_TIMEOUT_MS, withGenericTimeout } from '../billing/provider-timeout.js';
import { addressOf, sharedFromHeader } from './sender.js';
import { plainTextEmail, type BrandLook, type ContactLine, type RenderedEmail } from './templates.js';
import { UndeliverableRecipientError, undeliverableReason } from './reserved-recipient.js';

/**
 * Outbound email transport.
 *
 * Every message carries both an HTML and a plain text part. Resend sends
 * multipart when both are present, and a single-part HTML message is routinely
 * filtered by spam filters, which for a security notification means a customer
 * never learns their domain lost verification.
 *
 * Sending is fire and forget at the call site. A failed notification must never
 * roll back the action that triggered it: a domain that just verified stays
 * verified even if the email bounces. Errors are logged, not thrown, and there
 * is no retry queue, which is a known gap rather than an oversight.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Collapses identical alerts so a repeated event does not flood an inbox. */
  idempotencyKey?: string;
  /**
   * A From header for this message only, built by `email/sender.ts` for an
   * agency's client mail. Absent sends from EMAIL_FROM.
   */
  from?: string | null;
  /**
   * A Reply-To for this message only: the agency's published support address
   * on its client mail (`email/sender.ts`). Absent sends no Reply-To.
   */
  replyTo?: string | null;
}

/**
 * True when Resend refused a message because its From domain is not verified
 * in the account.
 *
 * Resend answers that case as a `validation_error` whose message reads "The
 * <domain> domain is not verified". Matched on the words rather than on the
 * status code, because the code (403) is shared with a dozen unrelated
 * refusals that a retry from another address would not fix.
 */
export function isUnverifiedSenderDomain(error: { message?: string | null; name?: string | null }): boolean {
  const message = error.message ?? '';
  /**
   * A sending key limited to our own domain refuses an agency's domain with
   * "This API key is not authorized to send emails from <domain>". The shared
   * address is what that key can send from, so it gets the same fallback
   * (session 14: the invite to a client contact was retried and never sent).
   */
  if (/not authori[sz]ed to send (e-?mails? )?from/i.test(message)) {
    return true;
  }
  if (!/domain/i.test(message)) {
    return false;
  }
  return /is not verified/i.test(message) || (error.name === 'validation_error' && /verif/i.test(message));
}

/** What left: the From header the provider accepted, which may be the shared one. */
export interface EmailSent {
  sentFrom: string;
  /** True when the agency's own address was refused and the shared one used. */
  fellBack: boolean;
}

export async function sendEmail(message: EmailMessage): Promise<EmailSent> {
  if (env.EMAIL_PROVIDER === 'resend') {
    // A reserved address has no mailbox behind it; handing it to the provider
    // only earns a bounce (reserved-recipient.ts). The queue records it as SKIPPED.
    const undeliverable = undeliverableReason(message.to);
    if (undeliverable) {
      throw new UndeliverableRecipientError(message.to, undeliverable);
    }

    if (!env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is not configured.');
    }

    const resend = new Resend(env.RESEND_API_KEY);
    /**
     * Bounded, because the SDK exposes no `signal` and its fetch therefore has no
     * deadline at all.
     *
     * This matters more here than anywhere else in the codebase, and not because
     * of the request that triggered it: the queue claims a row, sends it, and
     * marks the outcome. A provider that accepts the connection and then stalls
     * holds that claim for ever, so every pass after it claims the same row and
     * waits on the same socket. One hung provider response stops password
     * resets for every tenant on the system, and the heartbeat only reports the
     * email job stale after half an hour.
     */
    const attempt = (from: string, idempotencyKey: string | undefined) =>
      withGenericTimeout(
        () =>
          resend.emails.send(
            {
              from,
              to: message.to,
              subject: message.subject,
              html: message.html,
              text: message.text,
              ...(message.replyTo ? { replyTo: message.replyTo } : {}),
            },
            idempotencyKey ? { idempotencyKey } : undefined,
          ),
        EMAIL_SEND_TIMEOUT_MS,
        'Resend',
      );

    let sentFrom = message.from || env.EMAIL_FROM;
    let fellBack = false;
    let result = await attempt(sentFrom, message.idempotencyKey);

    /**
     * An agency's own sending domain that the provider no longer accepts.
     *
     * Client mail only leaves from an agency's domain once the provider has
     * reported it verified, but the agency can unpublish its records the next
     * day, and the provider then refuses every message from it. Losing a
     * client's monthly report over the agency's DNS is the wrong outcome, so
     * the message is sent once more from the shared address with the same
     * display name, which is exactly what the agency had before it set a domain.
     *
     * The retry gets its own idempotency key: Resend refuses a key it has seen
     * with a different payload, and the From line is part of the payload.
     */
    if (result.error && message.from && isUnverifiedSenderDomain(result.error)) {
      const fallback = sharedFromHeader(message.from);
      if (fallback) {
        const refused = addressOf(message.from)?.split('@')[1] ?? 'the sender';
        console.warn(
          `[email] the provider refused ${refused} (${result.error.message}); sending from the shared address instead.`,
        );
        result = await attempt(fallback, message.idempotencyKey ? `${message.idempotencyKey}:shared-from` : undefined);
        sentFrom = fallback;
        fellBack = true;
      }
    }

    if (result.error) {
      throw new Error(`Resend email delivery failed: ${result.error.message}`);
    }

    return { sentFrom, fellBack };
  }

  if (env.NODE_ENV === 'production') {
    throw new Error('Console email delivery is disabled in production.');
  }

  console.info(
    `[email] ${message.subject} for ${message.to}${message.from ? ` from ${message.from}` : ''}${
      message.replyTo ? ` reply-to ${message.replyTo}` : ''
    }\n${message.text}`,
  );
  return { sentFrom: message.from || env.EMAIL_FROM, fellBack: false };
}

/**
 * Queues a message for durable delivery.
 *
 * A notification is never worth failing a request over, so nothing here throws. What
 * changed is that the message is written down first and delivered by the queue, rather
 * than being handed to the provider in a floating promise. The instinct was right and
 * the mechanism was wrong: for a password reset, a domain verification link or the
 * confirmation that an erasure completed, this message is the only copy, and a
 * thirty second provider outage used to destroy it with a line in a log nobody reads.
 *
 * Kept async so the signature does not change, but the write is awaited by the queue
 * rather than floated. A floating queue write can lose the row along with the request
 * that caused it.
 */
export function queueEmail(
  rendered: RenderedEmail,
  to: string,
  idempotencyKey?: string,
  options: { from?: string; replyTo?: string } = {},
): void {
  void enqueueEmail({
    kind: 'notification',
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(options.from ? { from: options.from } : {}),
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
  });
}

/**
 * A message written as text by its caller (account mail, alerts, digests).
 *
 * `html` is the themed part a template built. Without one, the text is set in
 * the same layout by `plainTextEmail`, with `kind`, `brand`, `whiteLabel` and
 * `contact` for its masthead and contact line. Nothing leaves as bare markup:
 * the HTML part used to be the text split into paragraphs nested inside one
 * more paragraph, which is not valid HTML, in a generic sans-serif with none of
 * the product's look.
 */
export interface TextEmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  kind?: string | null;
  brand?: BrandLook | null;
  whiteLabel?: boolean;
  contact?: ContactLine | null;
  from?: string;
  replyTo?: string;
}

function htmlFor(message: TextEmailMessage): string {
  return (
    message.html ??
    plainTextEmail({
      subject: message.subject,
      text: message.text,
      kind: message.kind ?? null,
      brand: message.brand ?? null,
      whiteLabel: message.whiteLabel ?? false,
      contact: message.contact ?? null,
    }).html
  );
}

/** Kept so the auth flow's existing import keeps working. */
export function queueAuthEmail(message: TextEmailMessage): void {
  /**
   * Auth email goes through the same durable queue as everything else.
   *
   * A password reset is the clearest case of a message that exists nowhere else: if it
   * is lost the customer cannot get in, and support has no way to resend it because
   * nothing recorded it. Treating it as more important than a notification, not less,
   * is what the earlier fire-and-forget path got backwards.
   */
  void enqueueEmail({
    kind: 'auth',
    to: message.to,
    subject: message.subject,
    html: htmlFor(message),
    text: message.text,
    ...(message.from ? { from: message.from } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  });
}

export async function sendAuthEmail(message: TextEmailMessage): Promise<void> {
  await sendEmail({
    to: message.to,
    subject: message.subject,
    html: htmlFor(message),
    text: message.text,
    ...(message.from ? { from: message.from } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  });
}
