import { Resend } from 'resend';
import { env } from '../config/env.js';
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
    const result = await resend.emails.send(
      {
        from: env.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      },
      message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : undefined,
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
 * Queues a message without waiting for it.
 *
 * A notification is never worth failing a request over, so delivery problems
 * are logged and swallowed. The alternative is a customer whose card was
 * declined being shown an error page because an email provider was down.
 */
export function queueEmail(rendered: RenderedEmail, to: string, idempotencyKey?: string): void {
  void sendEmail({
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  }).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : 'Unknown email delivery error.';
    console.error(`[email] ${detail}`);
  });
}

/** Kept so the auth flow's existing import keeps working. */
export function queueAuthEmail(message: { to: string; subject: string; text: string }): void {
  void sendEmail({
    to: message.to,
    subject: message.subject,
    html: `<p style="font-family:sans-serif;font-size:15px;line-height:1.6;">${message.text
      .split('\n\n')
      .map((line) => `<p style="margin:0 0 12px;">${escapeAuthText(line)}</p>`)
      .join('')}</p>`,
    text: message.text,
  }).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : 'Unknown email delivery error.';
    console.error(`[auth-email] ${detail}`);
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
