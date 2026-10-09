import { Resend } from 'resend';
import { env } from '../config/env.js';
import { enqueueEmail } from '../services/email-queue.service.js';
import { EMAIL_SEND_TIMEOUT_MS, withGenericTimeout } from '../billing/provider-timeout.js';
import type { RenderedEmail } from './templates.js';

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
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  if (env.EMAIL_PROVIDER === 'resend') {
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
    const result = await withGenericTimeout(
      () =>
        resend.emails.send(
          {
            from: env.EMAIL_FROM,
            to: message.to,
            subject: message.subject,
            html: message.html,
            text: message.text,
          },
          message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : undefined,
        ),
      EMAIL_SEND_TIMEOUT_MS,
      'Resend',
    );

    if (result.error) {
      throw new Error(`Resend email delivery failed: ${result.error.message}`);
    }

    return;
  }

  if (env.NODE_ENV === 'production') {
    throw new Error('Console email delivery is disabled in production.');
  }

  console.info(`[email] ${message.subject} for ${message.to}\n${message.text}`);
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
export function queueEmail(rendered: RenderedEmail, to: string, idempotencyKey?: string): void {
  void enqueueEmail({
    kind: 'notification',
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

/** Kept so the auth flow's existing import keeps working. */
export function queueAuthEmail(message: { to: string; subject: string; text: string }): void {
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
    html: `<p style="font-family:sans-serif;font-size:15px;line-height:1.6;">${message.text
      .split('\n\n')
      .map((line) => `<p style="margin:0 0 12px;">${escapeAuthText(line)}</p>`)
      .join('')}</p>`,
    text: message.text,
  });
}

export async function sendAuthEmail(message: { to: string; subject: string; text: string }): Promise<void> {
  await sendEmail({
    to: message.to,
    subject: message.subject,
    html: `<p style="font-family:sans-serif;font-size:15px;line-height:1.6;">${message.text
      .split('\n\n')
      .map((line) => `<p style="margin:0 0 12px;">${escapeAuthText(line)}</p>`)
      .join('')}</p>`,
    text: message.text,
  });
}

function escapeAuthText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
