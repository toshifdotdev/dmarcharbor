import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { previousCompleteMonth } from '../src/services/reports/monthly-period.js';
import {
  renderMonthlyReportPdf,
  type MonthlyFacts,
  type MonthlyReportBranding,
} from '../src/services/reports/monthly-report-pdf.js';
import { C } from '../src/services/trust/pack-layout.js';
import { packFontFiles } from '../src/services/trust/pdf-fonts.js';
import { extractPdfText, normalisePdfText as normalise } from './helpers/pdf-text.js';

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

/**
 * A colour as pdfkit writes it into an uncompressed content stream: each
 * channel divided by 255 and printed in full, before `scn` or `SCN`.
 */
function pdfColour(hex: string): string {
  const value = parseInt(hex.slice(1), 16);
  return [value >> 16, (value >> 8) & 0xff, value & 0xff].map((part) => part / 255).join(' ');
}

/** The Helvetica layout's palette and its zebra fill, none of which Routes uses. */
const retiredColours = {
  ink: '#0f172a',
  muted: '#64748b',
  rule: '#e2e8f0',
  tealAccent: '#0f766e',
  zebra: '#f8fafc',
};

// A render embeds and subsets five faces; on a busy runner that is seconds.
describe('monthly report PDF', { timeout: 60_000 }, () => {
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
          { sourceIp: '198.51.100.7', senderDomain: 'sender.example', failedMessages: 20, totalMessages: 30, service: 'SendGrid' },
        ],
      }),
      unbranded,
    );
    const text = normalise(extractPdfText(rendered.buffer));

    expect(text).toContain('198.51.100.7');
    expect(text).toContain('sendgrid');
    expect(text).toContain('sender.example');
    expect(text).not.toContain('alice@example.com');
    expect(text).toContain('83.3%');
  });

  it('is set in Albert Sans and Atkinson Hyperlegible Mono, as the compliance pack is', async () => {
    const files = packFontFiles();
    expect(files.sans, 'apps/api/assets/fonts/AlbertSans-Regular.ttf should be found').toBeTruthy();
    expect(files.mono, 'apps/api/assets/fonts/AtkinsonHyperlegibleMono-Regular.ttf should be found').toBeTruthy();

    const rendered = await renderMonthlyReportPdf(facts(), unbranded);
    const raw = rendered.buffer.toString('latin1');
    expect(rendered.embeddedFonts).toEqual({ sans: true, mono: true });
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+AlbertSans-Regular/);
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+AlbertSans-Bold/);
    // The reference and the domains are set in the data face.
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+AtkinsonHyperlegibleMono-Regular/);
    expect(raw).not.toContain('/BaseFont /Helvetica');
  });

  it('falls back to the standard faces rather than failing when the fonts are missing', async () => {
    const rendered = await renderMonthlyReportPdf(facts(), unbranded, {});
    expect(rendered.embeddedFonts).toEqual({ sans: false, mono: false });
    const text = normalise(extractPdfText(rendered.buffer));
    expect(text).toContain(facts().reference.toLowerCase());
    expect(text).toContain(normalise('How to verify this document'));
  });

  it('uses the Routes palette and none of the old one, branded or not', async () => {
    for (const branding of [unbranded, branded]) {
      const raw = (await renderMonthlyReportPdf(facts(), branding)).buffer.toString('latin1');

      // The check can see colours: the ink the text is set in is there.
      expect(raw).toContain(`${pdfColour(C.ink)} scn`);
      for (const [name, hex] of Object.entries(retiredColours)) {
        expect(raw, `${name} ${hex} should be gone`).not.toContain(pdfColour(hex));
      }
      // The agency's colour is not drawn either: like the pack, the report is
      // set in ink, and the agency appears as its name and its logo.
      expect(raw).not.toContain(pdfColour(branded.primaryColor!));
    }
  });

  it('draws the column labels again on every page a long table runs onto', async () => {
    const domains = Array.from({ length: 120 }, (_, index) => ({
      name: `domain-${String(index).padStart(3, '0')}.test`,
      policy: index % 3 === 0 ? 'reject' : 'none',
      messages: index * 10,
      dmarcPass: index * 9,
      spfPass: index * 8,
      dkimPass: index * 7,
      reports: index,
      organisations: index % 4,
    }));
    const rendered = await renderMonthlyReportPdf(
      facts({ domains, domainCount: domains.length, totalReports: 1, messages: 100, dmarcPass: 90, spfPass: 80, dkimPass: 70 }),
      unbranded,
    );
    const text = normalise(extractPdfText(rendered.buffer));

    expect(text).toContain('domain-000.test');
    expect(text).toContain('domain-119.test');
    // "Orgs" is only ever the domain table's last column label.
    const labelled = text.split('orgs').length - 1;
    expect(labelled).toBeGreaterThanOrEqual(2);
    expect(labelled).toBeLessThan(rendered.pageCount);
  });
});
