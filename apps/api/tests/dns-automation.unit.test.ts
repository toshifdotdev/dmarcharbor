import { describe, expect, it, vi } from 'vitest';
import {
  createCloudflareClient,
  DnsAutomationError,
  zoneCandidates,
} from '../src/services/dns-automation/cloudflare.client.js';
import {
  addReportAddress,
  chooseDnsAction,
  currentValues,
  rewriteDmarcPolicy,
  fingerprintValues,
  matchingRecords,
  normaliseTxtValue,
} from '../src/services/dns-automation/records.js';

const token = ['cf', 'unit', 'token', '1234'].join('-');

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function txt(id: string, content: string) {
  return { id, name: '_dmarc.example.com', content, ttl: 1, comment: null };
}

describe('Cloudflare zone lookup', () => {
  it('walks parents and stops at the registrable domain', () => {
    expect(zoneCandidates('mail.sub.example.com')).toEqual([
      'mail.sub.example.com',
      'sub.example.com',
      'example.com',
    ]);
    expect(zoneCandidates('example.co.uk')).toEqual(['example.co.uk']);
    expect(zoneCandidates('mail.example.co.uk')).toEqual(['mail.example.co.uk', 'example.co.uk']);
  });

  it('queries each candidate until the first zone, never the public suffix', async () => {
    const queried: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      const name = parsed.searchParams.get('name') ?? '';
      queried.push(name);
      if (name === 'example.com') {
        return response({ success: true, errors: [], result: [{ id: 'zone-1', name: 'example.com', account: { name: 'Acme' } }] });
      }
      return response({ success: true, errors: [], result: [] });
    });

    const client = createCloudflareClient({ token, fetchImpl: fetchImpl as unknown as typeof fetch });
    const zone = await client.findZone('mail.sub.example.com');

    expect(zone).toMatchObject({ id: 'zone-1', name: 'example.com', accountName: 'Acme' });
    expect(queried).toEqual(['mail.sub.example.com', 'sub.example.com', 'example.com']);
  });
});

describe('Cloudflare errors', () => {
  const cases: Array<{ status: number; codes: number[]; expected: string }> = [
    { status: 401, codes: [10000], expected: 'TOKEN_INVALID' },
    { status: 403, codes: [9109], expected: 'MISSING_PERMISSION' },
    { status: 429, codes: [], expected: 'RATE_LIMITED' },
    { status: 503, codes: [], expected: 'PROVIDER_UNAVAILABLE' },
  ];

  it.each(cases)('maps HTTP $status / $codes to $expected without leaking the token', async ({ status, codes, expected }) => {
    const fetchImpl = vi.fn(async () =>
      response({ success: false, errors: codes.map((code) => ({ code, message: 'provider refused' })) }, status),
    );
    const client = createCloudflareClient({ token, fetchImpl: fetchImpl as unknown as typeof fetch });

    let caught: unknown;
    try {
      await client.verifyToken();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DnsAutomationError);
    expect((caught as DnsAutomationError).code).toBe(expected);
    expect((caught as DnsAutomationError).message).not.toContain(token);
    expect(JSON.stringify(caught)).not.toContain(token);
  });

  it('treats a non-active token as inactive rather than saving it', async () => {
    const fetchImpl = vi.fn(async () => response({ success: true, errors: [], result: { status: 'expired' } }));
    const client = createCloudflareClient({ token, fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.verifyToken()).resolves.toEqual({ status: 'expired' });
  });
});

describe('merging into a published DMARC record', () => {
  const ours = 'dmarc-reports+abcdef012345@reports.dmarcharbor.com';
  const existing = '"v=DMARC1; p=reject; sp=quarantine; adkim=s; rua=mailto:agg@ag.dmarcian.com; ruf=mailto:f@ag.dmarcian.com"';

  it('adds only our address, first, and keeps every other tag', () => {
    expect(addReportAddress(existing, ours)).toBe(
      `v=DMARC1; p=reject; sp=quarantine; adkim=s; rua=mailto:${ours},mailto:agg@ag.dmarcian.com; ruf=mailto:f@ag.dmarcian.com`,
    );
  });

  it('changes the policy tags and nothing else', () => {
    const testing = rewriteDmarcPolicy(existing, ours, { policy: 'quarantine', testing: true, np: null });
    expect(testing).toBe(
      `v=DMARC1; p=quarantine; sp=quarantine; adkim=s; rua=mailto:${ours},mailto:agg@ag.dmarcian.com; ruf=mailto:f@ag.dmarcian.com; t=y; pct=0`,
    );

    // Leaving testing drops t= and pct=, and np= is added only when asked for.
    const final = rewriteDmarcPolicy(testing, ours, { policy: 'reject', testing: false, np: 'reject' });
    expect(final).toBe(
      `v=DMARC1; p=reject; sp=quarantine; adkim=s; rua=mailto:${ours},mailto:agg@ag.dmarcian.com; ruf=mailto:f@ag.dmarcian.com; np=reject`,
    );
  });
});

describe('TXT matching and preview actions', () => {
  it('compares quoted and unquoted values as equal', () => {
    expect(normaliseTxtValue('"v=DMARC1; p=none"')).toBe('v=DMARC1; p=none');
    expect(normaliseTxtValue('  "v=DMARC1;   p=none" ')).toBe('v=DMARC1; p=none');

    const choice = chooseDnsAction({
      kind: 'dmarc_suggested',
      records: [txt('1', '"v=DMARC1; p=none"')],
      cname: false,
      proposedValue: 'v=DMARC1; p=none',
    });
    expect(choice.action).toBe('unchanged');
  });

  it('creates, updates and leaves unrelated TXT records alone', () => {
    const unrelated = { ...txt('u', 'google-site-verification=abc'), name: '_dmarc.example.com' };

    expect(
      chooseDnsAction({ kind: 'dmarc_suggested', records: [unrelated], cname: false, proposedValue: 'v=DMARC1; p=none' }),
    ).toMatchObject({ action: 'create' });

    expect(
      chooseDnsAction({
        kind: 'dmarc_suggested',
        records: [unrelated, txt('1', 'v=DMARC1; p=quarantine')],
        cname: false,
        proposedValue: 'v=DMARC1; p=none',
      }),
    ).toMatchObject({ action: 'update', matching: { id: '1' } });
  });

  it('refuses two DMARC records and a CNAME at the name', () => {
    const two = chooseDnsAction({
      kind: 'dmarc_suggested',
      records: [txt('1', 'v=DMARC1; p=none'), txt('2', 'v=DMARC1; p=reject')],
      cname: false,
      proposedValue: 'v=DMARC1; p=quarantine',
    });
    expect(two.action).toBe('refused');
    expect(two.reason).toContain('More than one DMARC record');

    const cname = chooseDnsAction({
      kind: 'dmarc_suggested',
      records: [],
      cname: true,
      proposedValue: 'v=DMARC1; p=none',
    });
    expect(cname.action).toBe('refused');
    expect(cname.reason).toContain('CNAME');
  });

  it('matches only the record kind this feature owns', () => {
    const records = [
      txt('v', 'dmarc-harbor-verification=abc'),
      txt('d', 'v=DMARC1; p=none'),
      { ...txt('x', 'unrelated'), name: '_dmarc-harbor-verification.example.com' },
    ];

    expect(matchingRecords('verification', records).map((record) => record.id)).toEqual(['v']);
    expect(matchingRecords('dmarc_suggested', records).map((record) => record.id)).toEqual(['d']);
  });

  it('fingerprints sorted normalised values stably', () => {
    const a = fingerprintValues(currentValues([txt('1', '"b value"'), txt('2', 'a value')]));
    const b = fingerprintValues(['a value', 'b value']);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});
