import { describe, expect, it } from 'vitest';
import {
  decryptSensitive,
  decryptSensitiveList,
  encryptSensitive,
  encryptSensitiveList,
  forensicPiiRetentionDays,
  forensicPiiRetentionExpiry,
  forensicRetentionExpiry,
} from '../src/services/privacy.service.js';

describe('sensitive value encryption', () => {
  it('round trips a value', () => {
    const encrypted = encryptSensitive('alice@example.com');

    expect(encrypted).not.toContain('alice');
    expect(encrypted.startsWith('v1.')).toBe(true);
    expect(decryptSensitive(encrypted)).toBe('alice@example.com');
  });

  it('produces a different ciphertext each time for the same input', () => {
    expect(encryptSensitive('alice@example.com')).not.toBe(encryptSensitive('alice@example.com'));
  });

  it('refuses to decrypt tampered ciphertext', () => {
    const [version, initializationVector, ciphertext, tag] = encryptSensitive('alice@example.com').split('.');
    const tampered = `${version}.${initializationVector}.${ciphertext!.slice(0, -2)}xy.${tag}`;

    expect(decryptSensitive(tampered)).toBeUndefined();
  });

  it('returns undefined for malformed or missing values', () => {
    expect(decryptSensitive(undefined)).toBeUndefined();
    expect(decryptSensitive('')).toBeUndefined();
    expect(decryptSensitive('not-a-ciphertext')).toBeUndefined();
    expect(decryptSensitiveList('nope')).toEqual([]);
  });

  it('round trips a list of addresses', () => {
    const encrypted = encryptSensitiveList(['alice@example.com', 'bob@example.com']);

    expect(JSON.stringify(encrypted)).not.toContain('example.com');
    expect(decryptSensitiveList(encrypted)).toEqual(['alice@example.com', 'bob@example.com']);
  });
});

describe('retention windows', () => {
  it('keeps named data for a shorter window than pseudonymized data', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    expect(forensicPiiRetentionDays()).toBeLessThanOrEqual(7);
    expect(forensicPiiRetentionExpiry(now).getTime()).toBeLessThan(forensicRetentionExpiry(now).getTime());
  });
});
