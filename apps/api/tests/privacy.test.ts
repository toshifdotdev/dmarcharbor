import { describe, expect, it } from 'vitest';
import { extractMailtoTargets, readDmarcRecord } from '../src/scanner/dmarc-tags.js';
import {
  forensicRetentionDays,
  normalizeAddress,
  pseudonymize,
  pseudonymizeAddress,
} from '../src/services/privacy.service.js';

describe('DMARC record tags', () => {
  it('extracts aggregate and forensic mailto targets', () => {
    const record =
      'v=DMARC1; p=reject; rua=mailto:agg@reports.dmarcharbor.com; ruf=mailto:forensics@reports.dmarcharbor.com';

    const parsed = readDmarcRecord(record);

    expect(parsed.tags.p).toBe('reject');
    expect(parsed.aggregateTargets).toEqual(['agg@reports.dmarcharbor.com']);
    expect(parsed.forensicTargets).toEqual(['forensics@reports.dmarcharbor.com']);
  });

  it('handles multiple targets, casing, and query strings', () => {
    expect(extractMailtoTargets('MAILTO:One@Example.com, mailto:two@example.com?to=agg')).toEqual([
      'one@example.com',
      'two@example.com',
    ]);
  });

  it('treats an unknown tag value as not configured', () => {
    expect(readDmarcRecord('v=DMARC1; p=none; ruf=mailto:').forensicTargets).toEqual([]);
    expect(readDmarcRecord('v=DMARC1; p=none; ruf=not-a-mailto').forensicTargets).toEqual([]);
    expect(readDmarcRecord(null).forensicTargets).toEqual([]);
  });
});

describe('privacy pseudonyms', () => {
  it('is stable and case insensitive so repeat reports correlate', () => {
    expect(pseudonymizeAddress('Alice@Example.com')).toBe(pseudonymizeAddress(' <alice@example.com> '));
    expect(pseudonymize('Subject: Invoice')).toBe(pseudonymize('subject:   invoice  '));
  });

  it('does not reveal the original value', () => {
    const pseudonym = pseudonymizeAddress('alice@example.com');

    expect(pseudonym).toHaveLength(64);
    expect(pseudonym).toMatch(/^[0-9a-f]{64}$/);
    expect(pseudonym).not.toContain('alice');
    expect(pseudonym).not.toContain('example.com');
  });

  it('separates namespaces so an address and a subject never collide', () => {
    expect(pseudonymize('address:alice@example.com')).not.toBe(pseudonymize('subject:alice@example.com'));
  });

  it('normalizes addresses and ignores empty values', () => {
    expect(normalizeAddress(' <Bob@Example.com> ')).toBe('Bob@Example.com');
    expect(normalizeAddress('   ')).toBeUndefined();
    expect(pseudonymizeAddress(undefined)).toBeUndefined();
  });

  it('keeps the retention window inside the allowed range', () => {
    expect(forensicRetentionDays()).toBeGreaterThanOrEqual(1);
    expect(forensicRetentionDays()).toBeLessThanOrEqual(365);
  });
});
