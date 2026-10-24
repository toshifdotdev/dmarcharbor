import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { env } from '../src/config/env.js';
import { systemDnsReader } from '../src/scanner/dns.js';
import { applyOwnershipResult, checkDomainOwnership } from '../src/services/client.service.js';
import { prisma } from '../src/database/prisma.js';

vi.mock('../src/database/prisma.js', () => ({
  prisma: { domain: { update: vi.fn() } },
}));
vi.mock('../src/services/webhook.service.js', () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/email/mailer.js', () => ({
  sendDomainVerificationEmail: vi.fn(),
}));

const DOMAIN = 'owned.example.test';
const VERIFICATION_HOST = `_dmarc-harbor-verification.${DOMAIN}`;
const DMARC_HOST = `_dmarc.${DOMAIN}`;
const TOKEN = 'abcdef012345';
const SHARED = 'dmarc-reports@reports.dmarcharbor.com';
const ORIGINAL_MODE = env.REPORT_ADDRESS_SUBADDRESSING;

function txt(...records: string[]): { status: 'found'; value: string[][] } {
  return { status: 'found', value: records.map((record) => [record]) };
}

function givenDns(input: {
  verification?: { status: 'found' | 'missing' | 'error'; value?: string[][] };
  dmarc?: { status: 'found' | 'missing' | 'error'; value?: string[][] };
}) {
  vi.spyOn(systemDnsReader, 'resolveTxt').mockImplementation(async (name) => {
    if (name === VERIFICATION_HOST) {
      return input.verification ?? { status: 'missing' };
    }
    if (name === DMARC_HOST) {
      return input.dmarc ?? { status: 'missing' };
    }
    return { status: 'missing' };
  });
}

function offlineCheck(overrides: Partial<{
  verified: boolean;
  lookupStatus: string;
  method: 'txt' | 'report_address' | null;
  reportAddressLookupStatus: string | null;
}> = {}) {
  return {
    verified: false,
    lookupStatus: 'missing',
    host: VERIFICATION_HOST,
    type: 'TXT' as const,
    value: 'dmarc-harbor-verification=vt',
    method: null,
    reportAddressLookupStatus: 'missing',
    ...overrides,
  };
}

beforeEach(() => {
  env.REPORT_ADDRESS_SUBADDRESSING = 'plus';
  vi.clearAllMocks();
});

afterEach(() => {
  env.REPORT_ADDRESS_SUBADDRESSING = ORIGINAL_MODE;
  vi.restoreAllMocks();
});

describe('ownership through the DMARC record', () => {
  it('keeps the TXT proof exactly as it was', async () => {
    givenDns({ verification: txt('dmarc-harbor-verification=vt') });

    const check = await checkDomainOwnership({
      name: DOMAIN,
      verificationToken: 'vt',
      reportToken: TOKEN,
    });

    expect(check.verified).toBe(true);
    expect(check.method).toBe('txt');
    expect(check.lookupStatus).toBe('found');
    expect(check.host).toBe(VERIFICATION_HOST);
    expect(check.value).toBe('dmarc-harbor-verification=vt');
    expect(check.reportAddressLookupStatus).toBe('missing');
  });

  it('proves ownership with this client token in rua', async () => {
    givenDns({
      dmarc: txt(`v=DMARC1; p=none; rua=mailto:dmarc-reports+${TOKEN}@reports.dmarcharbor.com`),
    });

    const check = await checkDomainOwnership({
      name: DOMAIN,
      verificationToken: 'vt',
      reportToken: TOKEN,
    });

    expect(check.verified).toBe(true);
    expect(check.method).toBe('report_address');
    expect(check.reportAddressLookupStatus).toBe('found');
  });

  it('does not accept another client token', async () => {
    givenDns({
      dmarc: txt('v=DMARC1; p=none; rua=mailto:dmarc-reports+ffffffffffff@reports.dmarcharbor.com'),
    });

    const check = await checkDomainOwnership({
      name: DOMAIN,
      verificationToken: 'vt',
      reportToken: TOKEN,
    });

    expect(check.verified).toBe(false);
    expect(check.method).toBeNull();
  });

  it('does not accept the shared address as proof of this client', async () => {
    givenDns({ dmarc: txt(`v=DMARC1; p=none; rua=mailto:${SHARED}`) });

    const check = await checkDomainOwnership({
      name: DOMAIN,
      verificationToken: 'vt',
      reportToken: TOKEN,
    });

    expect(check.verified).toBe(false);
  });

  it('does not accept a token that appears only in ruf', async () => {
    givenDns({
      dmarc: txt(
        `v=DMARC1; p=none; rua=mailto:${SHARED}; ruf=mailto:dmarc-reports+${TOKEN}@reports.dmarcharbor.com`,
      ),
    });

    const check = await checkDomainOwnership({
      name: DOMAIN,
      verificationToken: 'vt',
      reportToken: TOKEN,
    });

    expect(check.verified).toBe(false);
  });

  it('does not accept a name with two DMARC records', async () => {
    givenDns({
      dmarc: txt(
        `v=DMARC1; p=none; rua=mailto:dmarc-reports+${TOKEN}@reports.dmarcharbor.com`,
        'v=DMARC1; p=reject',
      ),
    });

    const check = await checkDomainOwnership({
      name: DOMAIN,
      verificationToken: 'vt',
      reportToken: TOKEN,
    });

    expect(check.verified).toBe(false);
  });

  it('does not read the DMARC record while subaddressing is off', async () => {
    env.REPORT_ADDRESS_SUBADDRESSING = 'off';
    givenDns({
      dmarc: txt(`v=DMARC1; p=none; rua=mailto:dmarc-reports+${TOKEN}@reports.dmarcharbor.com`),
    });

    const check = await checkDomainOwnership({
      name: DOMAIN,
      verificationToken: 'vt',
      reportToken: TOKEN,
    });

    expect(check.verified).toBe(false);
    expect(check.reportAddressLookupStatus).toBeNull();
    expect(systemDnsReader.resolveTxt).toHaveBeenCalledTimes(1);
  });
});

describe('demoting a verified domain', () => {
  const domain = {
    id: 'domain-1',
    name: DOMAIN,
    clientId: 'client-1',
    status: 'VERIFIED',
    verificationToken: 'vt',
  };

  it('stays VERIFIED when the TXT record is missing but the report address proves ownership', async () => {
    const status = await applyOwnershipResult(
      'org-1',
      domain,
      offlineCheck({
        verified: true,
        method: 'report_address',
        reportAddressLookupStatus: 'found',
      }),
    );

    expect(status).toBe('VERIFIED');
    expect(prisma.domain.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'VERIFIED' }) }),
    );
  });

  it('stays VERIFIED when the DMARC lookup errored or timed out', async () => {
    const status = await applyOwnershipResult(
      'org-1',
      domain,
      offlineCheck({ reportAddressLookupStatus: 'error' }),
    );

    expect(status).toBe('VERIFIED');
    expect((prisma.domain.update as Mock)).not.toHaveBeenCalled();
  });

  it('becomes FAILED only when both proofs are definitively absent', async () => {
    const status = await applyOwnershipResult(
      'org-1',
      domain,
      offlineCheck({ reportAddressLookupStatus: 'missing' }),
    );

    expect(status).toBe('FAILED');
    expect(prisma.domain.update).toHaveBeenCalledWith({
      where: { id: 'domain-1' },
      data: { status: 'FAILED', verifiedAt: null },
    });
  });

  it('becomes FAILED when a DMARC record exists but without our token', async () => {
    const status = await applyOwnershipResult(
      'org-1',
      domain,
      offlineCheck({ reportAddressLookupStatus: 'found' }),
    );

    expect(status).toBe('FAILED');
  });

  it('stays VERIFIED while the DNS lookup errored rather than returning missing', async () => {
    const status = await applyOwnershipResult(
      'org-1',
      domain,
      offlineCheck({ lookupStatus: 'error', reportAddressLookupStatus: 'missing' }),
    );

    expect(status).toBe('VERIFIED');
    expect(prisma.domain.update).not.toHaveBeenCalled();
  });
});
