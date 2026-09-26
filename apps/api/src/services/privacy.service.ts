import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

export const forensicRedactionVersion = 1;
const encryptionVersion = 'v1';

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

function encryptionKey(): Buffer {
  return createHash('sha256').update(env.FORENSIC_PII_ENCRYPTION_KEY).digest();
}

export function encryptSensitive(value: string): string {
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), initializationVector);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);

  return [
    encryptionVersion,
    initializationVector.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

export function decryptSensitive(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const [version, initializationVector, ciphertext, tag] = value.split('.');
  if (version !== encryptionVersion || !initializationVector || !ciphertext || !tag) {
    return undefined;
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(initializationVector, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

export function encryptSensitiveList(values: string[]): string[] {
  return values.map((value) => encryptSensitive(value));
}

export function decryptSensitiveList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => decryptSensitive(entry))
    .filter((entry): entry is string => Boolean(entry));
}

export function forensicRetentionDays(): number {
  return Math.min(Math.max(env.FORENSIC_RETENTION_DAYS, 1), 365);
}

export function forensicPiiRetentionDays(): number {
  return Math.min(Math.max(env.FORENSIC_PII_RETENTION_DAYS, 1), forensicRetentionDays());
}

export function forensicRetentionExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + forensicRetentionDays() * 24 * 60 * 60 * 1000);
}

export function forensicPiiRetentionExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + forensicPiiRetentionDays() * 24 * 60 * 60 * 1000);
}

export function reportRetentionDays(): number {
  return Math.min(Math.max(env.REPORT_RETENTION_DAYS, 7), 3650);
}

export function reportRetentionExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + reportRetentionDays() * 24 * 60 * 60 * 1000);
}
