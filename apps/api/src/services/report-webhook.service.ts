import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

const maximumClockSkewSeconds = 300;

export function verifyReportWebhookSignature(
  rawEmail: string,
  signature: string | undefined,
  timestamp: string | undefined,
): boolean {
  if (!env.REPORT_INGEST_SECRET || !signature || !timestamp) {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > maximumClockSkewSeconds) {
    return false;
  }

  const provided = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  const expected = createHmac('sha256', env.REPORT_INGEST_SECRET)
    .update(`${timestamp}.${rawEmail}`)
    .digest('hex');

  if (provided.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
