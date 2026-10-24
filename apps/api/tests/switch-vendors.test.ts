import { describe, expect, it } from 'vitest';
import { detectVendor, reportVendors } from '../src/services/switch-kit/vendors.js';

describe('detecting the incumbent report vendor', () => {
  it('matches a suffix only on a label boundary', () => {
    expect(detectVendor('dmarcian.com', 'example.test')).toEqual({ id: 'dmarcian', label: 'dmarcian' });
    expect(detectVendor('ag.dmarcian.com', 'example.test')).toEqual({ id: 'dmarcian', label: 'dmarcian' });
    expect(detectVendor('notdmarcian.com', 'example.test')).toEqual({ id: 'other', label: 'notdmarcian.com' });
  });

  it('matches every listed suffix of a vendor', () => {
    expect(detectVendor('rua.easydmarc.us', 'example.test')).toEqual({ id: 'easydmarc', label: 'EasyDMARC' });
    expect(detectVendor('easydmarc.eu', 'example.test')).toEqual({ id: 'easydmarc', label: 'EasyDMARC' });
    expect(detectVendor('reports.ondmarc.com', 'example.test')).toEqual({
      id: 'redsift',
      label: 'Red Sift OnDMARC',
    });
  });

  it('recognises the customer own mail infrastructure in both directions', () => {
    expect(detectVendor('example.test', 'example.test')).toEqual({ id: 'self', label: 'Your own mailbox' });
    expect(detectVendor('mail.example.test', 'example.test')).toEqual({
      id: 'self',
      label: 'Your own mailbox',
    });
    expect(detectVendor('example.test', 'mail.example.test')).toEqual({
      id: 'self',
      label: 'Your own mailbox',
    });
  });

  it('labels an unknown provider with the host the operator must go and edit', () => {
    expect(detectVendor('dmarc.some-agency.test', 'example.test')).toEqual({
      id: 'other',
      label: 'dmarc.some-agency.test',
    });
  });

  it('normalises case and a trailing dot', () => {
    expect(detectVendor('RUA.DMARCian.COM.', 'example.test')).toEqual({
      id: 'dmarcian',
      label: 'dmarcian',
    });
  });

  it('carries the whole vendor list the workflow is written against', () => {
    expect(reportVendors.map((vendor) => vendor.id)).toEqual([
      'dmarcian',
      'easydmarc',
      'powerdmarc',
      'valimail',
      'redsift',
      'proofpoint',
      'agari',
      'mimecast',
      'cloudflare',
      'postmark',
      'uriports',
      'dmarcly',
      'sendmarc',
      'reporturi',
    ]);
  });
});
