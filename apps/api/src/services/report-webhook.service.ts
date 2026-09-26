import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

export function verifyReportWebhookSignature(rawEmail: string, signature: string | undefined): boolean {
  if (!env.REPORT_INGEST_SECRET || !signature) {
    return false;
  }

  const provided = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  const expected = createHmac('sha256', env.REPORT_INGEST_SECRET).update(rawEmail).digest('hex');

  if (provided.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
