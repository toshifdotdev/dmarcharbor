import { describe, expect, it } from 'vitest';
import {
  catalogueVersion,
  domainMatchesSuffix,
  entriesForAsn,
  entriesForDomain,
  entriesForPtr,
  serviceCatalogue,
} from '../src/services/senders/service-catalogue.js';

describe('service catalogue', () => {
  it('matches only whole labels, so notsendgrid.net is not SendGrid', () => {
    expect(domainMatchesSuffix('sendgrid.net', 'sendgrid.net')).toBe(true);
    expect(domainMatchesSuffix('o1.sendgrid.net.', 'sendgrid.net')).toBe(true);
    expect(domainMatchesSuffix('NOTSENDGRID.NET', 'sendgrid.net')).toBe(false);
    expect(domainMatchesSuffix('sendgrid.net.example', 'sendgrid.net')).toBe(false);
    expect(domainMatchesSuffix('example.com', '')).toBe(false);
  });

  it('has a stable id, name, category, signal and source on every entry', () => {
    expect(catalogueVersion).toBe('2026-10');
    const ids = new Set<string>();
    for (const entry of serviceCatalogue) {
      expect(entry.id).toMatch(/^[a-z0-9-]+$/);
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(entry.name.length).toBeGreaterThan(1);
      expect([
        'mailbox',
        'marketing',
        'transactional',
        'support',
        'crm',
        'security',
        'other',
      ]).toContain(entry.category);
      expect(
        entry.dkimDomains.length + entry.spfDomains.length + entry.ptrSuffixes.length + entry.asns.length,
      ).toBeGreaterThan(0);
      expect(entry.source).toMatch(/^https:\/\//);
      expect(typeof entry.name).toBe('string');
    }
  });

  it('finds entries by DKIM/SPF domain, PTR and ASN', () => {
    expect(entriesForDomain('o1.sendgrid.net', 'spf').map((entry) => entry.id)).toContain('sendgrid');
    expect(entriesForPtr('o1.sendgrid.net').map((entry) => entry.id)).toContain('sendgrid');
    expect(entriesForAsn(15169).map((entry) => entry.id)).toContain('google-workspace');
    expect(entriesForDomain('unrelated.example', 'dkim')).toHaveLength(0);
  });
});
