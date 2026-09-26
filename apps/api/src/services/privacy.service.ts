import { createHmac } from 'node:crypto';
import { env } from '../config/env.js';

export const forensicRedactionVersion = 1;

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeAddress(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim().replace(/^<|>$/g, '').trim();
  return trimmed || undefined;
}

export function pseudonymizeAddress(value: string | undefined): string | undefined {
  const address = normalizeAddress(value);
  return address ? pseudonymize(`address:${address}`) : undefined;
}

export function pseudonymize(value: string): string {
  const normalized = normalize(value);
  if (!normalized) {
    return '';
  }

  return createHmac('sha256', env.FORENSIC_PSEUDONYM_SECRET)
    .update(`ruf-v${forensicRedactionVersion}\n${normalized}`)
    .digest('hex');
}

export function forensicRetentionDays(): number {
  return Math.min(Math.max(env.FORENSIC_RETENTION_DAYS, 1), 365);
}

export function forensicRetentionExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + forensicRetentionDays() * 24 * 60 * 60 * 1000);
}
