import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { previousCompleteMonth } from '../src/services/reports/monthly-period.js';
import {
  renderMonthlyReportPdf,
  type MonthlyFacts,
  type MonthlyReportBranding,
} from '../src/services/reports/monthly-report-pdf.js';

function facts(overrides: Partial<MonthlyFacts> = {}): MonthlyFacts {
  return {
    clientName: 'Fixture Client',
    agencyName: 'Fixture Agency',
    period: previousCompleteMonth(new Date('2026-11-05T12:00:00Z')),
    reference: 'RPT-202610-FIXTURE-CLIENT-0123456789ABCDEF01234567',
    issuedAt: new Date('2026-11-05T12:00:00.000Z'),
    domains: [
      {
        name: 'fixture.test',
        policy: 'no record',
        messages: 0,
        dmarcPass: 0,
        spfPass: 0,
        dkimPass: 0,
        reports: 0,
        organisations: 0,
      },
    ],
    domainCount: 1,
    totalReports: 0,
    messages: 0,
    dmarcPass: 0,
    spfPass: 0,
    dkimPass: 0,
    policyDistribution: {
      none: 0,
      quarantine: 0,
      reject: 0,
      testing: 0,
      'no record': 1,
      'not known': 0,
    },
    policyMoved: 0,
    domainsWithoutReports: 1,
    changes: [],
    changeCount: 0,
    sources: [],
    forensicCount: 0,
    alertsOpened: 0,
    alertsResolved: 0,
    ...overrides,
  };
}

const unbranded: MonthlyReportBranding = {
  branded: false,
  workspaceName: 'Fixture Agency',
  primaryColor: null,
  logo: null,
  verifyBase: 'http://localhost:3100',
};

const branded: MonthlyReportBranding = {
  branded: true,
  workspaceName: 'Bright Agency',
  primaryColor: '#123456',
  logo: null,
  verifyBase: 'https://portal.bright.example',
};

function extractPdfText(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  const pattern = /<([0-9a-fA-F]+)>/g;
  const parts: string[] = [];
  let match = pattern.exec(raw);
  while (match !== null) {
    const hex = match[1]!;
    if (hex.length % 2 === 0) {
      parts.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
    match = pattern.exec(raw);
  }
  return parts.join(' ');
}

function normalise(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

describe('monthly report PDF', () => {
  it('is deterministic for the same facts, reference and issue time', async () => {
    const first = await renderMonthlyReportPdf(facts(), unbranded);
    const second = await renderMonthlyReportPdf(facts(), unbranded);
    expect(first.buffer.equals(second.buffer)).toBe(true);
    expect(createHash('sha256').update(first.buffer).digest('hex')).toBe(
      createHash('sha256').update(second.buffer).digest('hex'),
    );
    expect(first.pageCount).toBeGreaterThan(0);
  });

  it('states the no-reports case and still renders the domain and DNS sections', async () => {
    const rendered = await renderMonthlyReportPdf(facts(), unbranded);
    const text = normalise(extractPdfText(rendered.buffer));

    expect(text).toContain('emailauthenticationreport');
    expect(text).toContain('fixtureclient');
    expect(text).toContain('october2026');
    expect(text).toContain('noaggregatereportswerereceivedforthisclient');
    expect(text).toContain('noreports');
    expect(text).toContain('nowarningorcriticaldnschangeswererecorded');
    expect(text).toContain('usingdmarcharbor');
    expect(text).not.toContain('400days');
    expect(text).not.toContain('retention');
  });

  it('uses the agency brand when branded and keeps the product name out', async () => {
    const rendered = await renderMonthlyReportPdf(facts(), branded);
    const text = normalise(extractPdfText(rendered.buffer));

    expect(text).toContain('preparedbybrightagency');
    expect(text).not.toContain('dmarcharbor');
    expect(text).toContain('portal.bright.example');
  });

  it('lists a top failing source without identifying a person', async () => {
    const rendered = await renderMonthlyReportPdf(
      facts({
        totalReports: 2,
        messages: 120,
        dmarcPass: 100,
        spfPass: 110,
        dkimPass: 105,
        domainCount: 2,
        domains: [
          {
            name: 'fixture.test',
            policy: 'reject',
            messages: 120,
            dmarcPass: 100,
            spfPass: 110,
            dkimPass: 105,
            reports: 2,
            organisations: 1,
          },
        ],
        policyDistribution: {
          none: 0,
          quarantine: 0,
          reject: 1,
          testing: 0,
          'no record': 0,
          'not known': 1,
        },
        policyMoved: 1,
        domainsWithoutReports: 1,
        sources: [
          { sourceIp: '198.51.100.7', senderDomain: 'sender.example', failedMessages: 20, totalMessages: 30 },
        ],
      }),
      unbranded,
    );
    const text = normalise(extractPdfText(rendered.buffer));

    expect(text).toContain('198.51.100.7');
    expect(text).toContain('sender.example');
    expect(text).not.toContain('alice@example.com');
    expect(text).toContain('83.3%');
  });
});
