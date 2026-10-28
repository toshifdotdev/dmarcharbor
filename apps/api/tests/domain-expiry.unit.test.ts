import { afterEach, describe, expect, it } from 'vitest';
import type { GuardedRequestInput, GuardedResult } from '../src/services/net/guarded-request.js';
import {
  lookupRegistration,
  parseBootstrap,
  parseRdapDomain,
  rdapBootstrapUrl,
  setRdapRequesterForTests,
} from '../src/services/monitoring/rdap.js';
import {
  daysUntil,
  expirySentence,
  severityFor,
  thresholdFor,
} from '../src/services/monitoring/domain-expiry.service.js';
import { domainExpiryEmail } from '../src/email/templates.js';

/**
 * RDAP parsing and the warning ladder, with recorded registry answers.
 * Nothing here reaches the network.
 */

function ok(body: unknown, statusCode = 200): GuardedResult {
  return { status: 'ok', statusCode, headers: {}, body: Buffer.from(JSON.stringify(body), 'utf8') };
}

const bootstrapBody = {
  services: [
    [['com', 'net'], ['https://rdap.verisign.com/com/v1/']],
    [['org'], ['http://rdap.publicinterestregistry.org/rdap', 'https://rdap.publicinterestregistry.org/rdap']],
    [['plain'], ['http://only-plain.example/']],
  ],
};

/** The shape Verisign returns for a .com, trimmed to what is read. */
const verisignAnswer = {
  objectClassName: 'domain',
  ldhName: 'EXAMPLE.COM',
  events: [
    { eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' },
    { eventAction: 'expiration', eventDate: '2027-08-13T04:00:00Z' },
    { eventAction: 'last update of RDAP database', eventDate: '2026-11-25T10:00:00Z' },
  ],
  entities: [
    {
      objectClassName: 'entity',
      roles: ['registrar'],
      vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'RESERVED-Internet Assigned Numbers Authority']]],
    },
  ],
};

let calls: GuardedRequestInput[] = [];

function useRegistry(answer: (input: GuardedRequestInput) => GuardedResult): void {
  calls = [];
  setRdapRequesterForTests(async (input) => {
    calls.push(input);
    if (input.url === rdapBootstrapUrl) return ok(bootstrapBody);
    return answer(input);
  });
}

afterEach(() => setRdapRequesterForTests(null));

describe('RDAP bootstrap', () => {
  it('maps every TLD to its https base, and skips http-only services', () => {
    const services = parseBootstrap(bootstrapBody);
    expect(services.get('com')).toBe('https://rdap.verisign.com/com/v1/');
    expect(services.get('net')).toBe('https://rdap.verisign.com/com/v1/');
    expect(services.get('org')).toBe('https://rdap.publicinterestregistry.org/rdap/');
    expect(services.has('plain')).toBe(false);
  });

  it('survives a file that is not the expected shape', () => {
    expect(parseBootstrap(null).size).toBe(0);
    expect(parseBootstrap({ services: 'nope' }).size).toBe(0);
  });
});

describe('RDAP domain answers', () => {
  it('reads the expiration event and the registrar name', () => {
    const parsed = parseRdapDomain(verisignAnswer);
    expect(parsed.expiresAt?.toISOString()).toBe('2027-08-13T04:00:00.000Z');
    expect(parsed.registrar).toBe('RESERVED-Internet Assigned Numbers Authority');
  });

  it('asks the registry the bootstrap names, with the strict policy defaults', async () => {
    useRegistry(() => ok(verisignAnswer));
    const result = await lookupRegistration('Example.COM.');
    expect(result).toMatchObject({ status: 'ok', registrar: 'RESERVED-Internet Assigned Numbers Authority' });
    expect(calls[1]!.url).toBe('https://rdap.verisign.com/com/v1/domain/example.com');
    expect(calls[1]!.policy).toBeUndefined();
    expect(calls[1]!.method).toBe('GET');
  });

  it('says so in words when the registry publishes no expiry', async () => {
    useRegistry(() => ok({ objectClassName: 'domain', events: [{ eventAction: 'registration', eventDate: '2001-01-01T00:00:00Z' }] }));
    expect(await lookupRegistration('example.org')).toMatchObject({ status: 'no_expiry', expiresAt: null });
  });

  it('separates an unsupported TLD, an unknown name and a failed request', async () => {
    useRegistry(() => ok({}, 404));
    expect(await lookupRegistration('example.zz')).toMatchObject({ status: 'unsupported' });
    expect(await lookupRegistration('nobody.com')).toMatchObject({ status: 'not_found' });

    useRegistry(() => ({ status: 'error', failure: 'timeout', detail: 'The server did not answer in time.' }));
    const failed = await lookupRegistration('example.com');
    expect(failed.status).toBe('error');
    expect(failed.error).toContain('could not be reached');

    useRegistry(() => ok({}, 429));
    expect((await lookupRegistration('example.com')).error).toContain('rate limiting');
  });

  it('reads the bootstrap once and reuses it', async () => {
    useRegistry(() => ok(verisignAnswer));
    await lookupRegistration('a.com');
    await lookupRegistration('b.com');
    expect(calls.filter((call) => call.url === rdapBootstrapUrl)).toHaveLength(1);
  });
});

describe('the warning ladder', () => {
  const now = new Date('2026-11-25T12:00:00Z');
  const inDays = (days: number) => new Date(now.getTime() + days * 24 * 60 * 60 * 1000 + 60_000);

  it('counts whole days and lands on the tightest rung reached', () => {
    expect(daysUntil(inDays(30), now)).toBe(30);
    expect(thresholdFor(45)).toBeNull();
    expect(thresholdFor(30)).toBe(30);
    expect(thresholdFor(20)).toBe(30);
    expect(thresholdFor(14)).toBe(14);
    expect(thresholdFor(10)).toBe(14);
    // First seen at 5 days left: the 7-day warning, not every rung skipped.
    expect(thresholdFor(5)).toBe(7);
    expect(thresholdFor(1)).toBe(1);
    expect(thresholdFor(0)).toBe(0);
    expect(thresholdFor(-3)).toBe(0);
  });

  it('is critical from seven days, a warning before', () => {
    expect(severityFor(30)).toBe('WARNING');
    expect(severityFor(14)).toBe('WARNING');
    expect(severityFor(7)).toBe('CRITICAL');
    expect(severityFor(0)).toBe('CRITICAL');
  });

  it('says the date in words, and names the registrable domain for a subdomain', () => {
    const expiresAt = new Date('2026-12-09T00:00:00Z');
    expect(expirySentence({ domainName: 'acme.com', registrableDomain: 'acme.com', expiresAt, daysLeft: 14 })).toBe(
      'acme.com: The registration expires in 14 days, on 9 December 2026.',
    );
    expect(
      expirySentence({ domainName: 'mail.acme.com', registrableDomain: 'acme.com', expiresAt, daysLeft: 1 }),
    ).toBe('mail.acme.com: The registration of acme.com expires in 1 day, on 9 December 2026.');
    expect(expirySentence({ domainName: 'acme.com', registrableDomain: 'acme.com', expiresAt, daysLeft: 0 })).toContain(
      'expires today',
    );
    expect(expirySentence({ domainName: 'acme.com', registrableDomain: 'acme.com', expiresAt, daysLeft: -2 })).toContain(
      'expired on 9 December 2026, 2 days ago',
    );
  });

  it('builds one email listing every domain, with what lapsing means', () => {
    const email = domainExpiryEmail({
      workspaceName: 'Acme MSP',
      appUrl: 'https://app.example.test',
      domains: [
        { domainSlug: 'acme-com-1', sentence: 'acme.com: The registration expires in 7 days, on 2 December 2026.', registrar: 'Example Registrar' },
        { domainSlug: 'beta-com-2', sentence: 'beta.com: The registration expires in 30 days, on 25 December 2026.', registrar: null },
      ],
    });
    expect(email.subject).toBe('2 domain registrations need renewing in Acme MSP');
    expect(email.text).toContain('Registrar: Example Registrar.');
    expect(email.text).toContain('stops resolving');
    expect(email.html).not.toContain('<script');
  });
});
