import { Resend } from 'resend';
import { env } from '../config/env.js';

export interface AuthEmailMessage {
  to: string;
  subject: string;
  text: string;
}

export async function sendAuthEmail(message: AuthEmailMessage): Promise<void> {
  if (env.EMAIL_PROVIDER === 'resend') {
    if (!env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is not configured.');
    }

    const resend = new Resend(env.RESEND_API_KEY);
    const result = await resend.emails.send({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });

    if (result.error) {
      throw new Error(`Resend email delivery failed: ${result.error.message}`);
    }

    return;
  }

  if (env.NODE_ENV === 'production') {
    throw new Error('Console email delivery is disabled in production.');
  }

  console.info(`[auth-email] ${message.subject} for ${message.to}\n${message.text}`);
}

export function queueAuthEmail(message: AuthEmailMessage): void {
  void sendAuthEmail(message).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : 'Unknown email delivery error.';
    console.error(`[auth-email] ${detail}`);
  });
}
