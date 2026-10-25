import { describe, expect, it } from 'vitest';
import { attributeSender, attributeSourceIp, type AuthSignal, type CachedIntel } from '../src/services/senders/attribution.js';

function signal(type: 'DKIM' | 'SPF', domain: string, result = 'pass', messageCount = 100): AuthSignal {
  return { type, domain, result, messageCount };
}

function intel(overrides: Partial<CachedIntel> = {}): CachedIntel {
  return {
    ip: '203.0.113.10',
    ptr: null,
    ptrConfirmed: false,
    asn: null,
    asnName: null,
    ...overrides,
  };
}

describe('sender attribution', () => {
  it('names a service from a passing aligned DKIM domain', () => {
    const result = attributeSender({
      reportedDomain: 'example.com',
      signals: [signal('DKIM', 'sendgrid.net')],
      ipMessages: new Map([['203.0.113.10', 100]]),
      intel: new Map(),
      intelPending: true,
    });

    expect(result.service?.name).toBe('SendGrid');
    expect(result.confidence).toBe('confirmed');
    expect(result.evidence.some((line) => line.includes('DKIM d=sendgrid.net'))).toBe(true);
  });

  it('never names a service from a failing domain alone, which a spoofer can write', () => {
    const result = attributeSender({
      reportedDomain: 'example.com',
      signals: [signal('DKIM', 'google.com', 'fail'), signal('SPF', 'google.com', 'fail')],
      ipMessages: new Map([['203.0.113.10', 100]]),
      // Even with Google's ASN on the same IP, an unverified claim plus an ASN is not a name.
      intel: new Map([['203.0.113.10', intel({ asn: 15169, asnName: 'GOOGLE' })]]),
      intelPending: false,
    });

    expect(result.service).toBeNull();
    expect(result.confidence).toBe('network');
    expect(result.evidence.some((line) => line.includes('DKIM d=google.com (fail)'))).toBe(true);
  });

  it('calls a failing domain likely when confirmed reverse DNS backs it', () => {
    const result = attributeSender({
      reportedDomain: 'example.com',
      signals: [signal('DKIM', 'mailgun.org', 'fail')],
      ipMessages: new Map([['203.0.113.10', 100]]),
      intel: new Map([['203.0.113.10', intel({ ptr: 'm1.mailgun.org', ptrConfirmed: true })]]),
      intelPending: false,
    });

    expect(result.service?.name).toBe('Mailgun');
    expect(result.confidence).toBe('likely');
  });

  it('names a provider from confirmed reverse DNS when the customer uses custom DKIM', () => {
    const result = attributeSender({
      reportedDomain: 'example.com',
      signals: [signal('DKIM', 'example.com')],
      ipMessages: new Map([['203.0.113.10', 100]]),
      intel: new Map([
        [
          '203.0.113.10',
          intel({ ptr: 'o1.ptr1234.sendgrid.net', ptrConfirmed: true, asn: 11377, asnName: 'SENDGRID' }),
        ],
      ]),
      intelPending: false,
    });

    expect(result.service?.name).toBe('SendGrid');
    expect(result.confidence).toBe('likely');
    expect(result.evidence.some((line) => line.includes('Reverse DNS'))).toBe(true);
    expect(result.evidence.some((line) => line.includes('AS11377'))).toBe(true);
  });

  it('never names a service from an ASN alone', () => {
    const result = attributeSender({
      reportedDomain: 'example.com',
      signals: [],
      ipMessages: new Map([['203.0.113.10', 100]]),
      intel: new Map([['203.0.113.10', intel({ asn: 15169, asnName: 'GOOGLE' })]]),
      intelPending: false,
    });

    expect(result.service).toBeNull();
    expect(result.confidence).toBe('network');
    expect(result.network).toEqual({ asn: 15169, asnName: 'GOOGLE' });
  });

  it('recognises the domain’s own server', () => {
    const result = attributeSender({
      reportedDomain: 'mail.example.com',
      signals: [],
      ipMessages: new Map([['203.0.113.10', 100]]),
      intel: new Map([
        ['203.0.113.10', intel({ ptr: 'mx1.example.com', ptrConfirmed: true })],
      ]),
      intelPending: false,
    });

    expect(result.service).toBeNull();
    expect(result.confidence).toBe('own');
    expect(result.evidence[0]).toContain('mx1.example.com');
  });

  it('picks the service with the most messages and keeps the other in the evidence', () => {
    const result = attributeSender({
      reportedDomain: 'example.com',
      signals: [
        signal('DKIM', 'sendgrid.net', 'pass', 100),
        signal('SPF', 'mailgun.org', 'pass', 40),
      ],
      ipMessages: new Map(),
      intel: new Map(),
      intelPending: false,
    });

    expect(result.service?.name).toBe('SendGrid');
    expect(result.evidence.join(' ')).toContain('mailgun.org');
    expect(result.evidence.length).toBeLessThanOrEqual(5);
  });

  it('reports an IP-level service for the Sources table', () => {
    const result = attributeSourceIp({
      reportedDomain: 'example.com',
      ip: '203.0.113.10',
      messages: 50,
      signals: [signal('SPF', 'sendgrid.net', 'pass', 50)],
      intel: null,
    });

    expect(result.service?.name).toBe('SendGrid');
    expect(result.confidence).toBe('confirmed');
  });
});
