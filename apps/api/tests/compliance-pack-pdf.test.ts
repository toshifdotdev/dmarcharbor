import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { describe, expect, it } from 'vitest';
import type { ScanResult } from '../src/models/scan.model.js';
import { readPosture } from '../src/services/trust/client-evidence.js';
import type { ClientEvidence, DomainEvidence } from '../src/services/trust/client-evidence.service.js';
import { PAGE, PackWriter } from '../src/services/trust/pack-layout.js';
import { renderCompliancePack, type PackFacts } from '../src/services/trust/pack-pdf.js';
import { applyPackFonts, packFontFiles } from '../src/services/trust/pdf-fonts.js';
import { extractPdfText, normalisePdfText as normalise } from './helpers/pdf-text.js';

/**
 * The 2.0 evidence pack, rendered from fixed facts with no database.
 *
 * The integration suite proves the pack against real rows; this one pins the
 * document itself: the same facts give the same bytes, the faces are embedded
 * (or fall back whole), every page carries the reference, and the claims the
 * document must make, and must never make, are where they should be.
 */

const asOf = new Date('2026-12-02T09:30:00.000Z');
const reference = 'DMARC-20261202-PELLOWYN-DENTAL-0123456789ABCDEF01234567';

function scan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    domain: 'pellowyn-dental.example',
    scannedAt: '2026-12-01T06:00:00.000Z',
    status: 'healthy',
    score: 90,
    scoreBreakdown: { base: 100, final: 90, factors: [] },
    dmarc: {
      status: 'found',
      record: 'v=DMARC1; p=quarantine; rua=mailto:reports+0123456789ab@reports.example',
      policy: 'quarantine',
      tags: { v: 'DMARC1', p: 'quarantine', rua: 'mailto:reports+0123456789ab@reports.example' },
      hasAggregateReports: true,
      hasForensicReports: false,
      aggregateMailtoTargets: ['mailto:reports+0123456789ab@reports.example'],
      aggregateWebTargets: [],
    },
    spf: { status: 'found', record: 'v=spf1 include:spf.protection.outlook.com -all', valid: true, lookupCount: 3 },
    dkim: { status: 'found', selectors: ['selector1', 'selector2'], checkedSelectors: ['selector1', 'selector2', 'google'], records: {} },
    mx: { status: 'found', records: [{ exchange: 'mx.pellowyn-dental.example', priority: 10 }] },
    mtaSts: { status: 'missing', policy: null },
    tlsRpt: { status: 'missing', valid: false, mailtoTargets: [], httpsTargets: [], problems: [] },
    bimi: {
      status: 'missing',
      logoUrl: null,
      authorityUrl: null,
      declined: false,
      problems: [],
      dmarc: { qualifies: false, reasons: [] },
      logo: null,
    },
    issues: [],
    recommendations: [],
    ...overrides,
  };
}

const ours = (uri: string) => uri.includes('@reports.example');

function domain(name: string, result: ScanResult | null, extra: Partial<DomainEvidence> = {}): DomainEvidence {
  const posture = readPosture(result, result ? new Date(result.scannedAt) : null, ours);
  return {
    name,
    ownership: 'verified',
    verifiedAt: '2026-10-01T10:00:00.000Z',
    addedAt: '2026-09-30T10:00:00.000Z',
    posture,
    coverage: {
      reporting: posture.dmarc.reporting,
      lastReportAt: '2026-12-01T03:00:00.000Z',
      firstPeriodAt: '2026-10-02T00:00:00.000Z',
      reportsInWindow: 120,
      daysMeasured: 61,
      reporters: 4,
      tlsReportsInWindow: 0,
      lastTlsReportAt: null,
    },
    senders: { sources: 6, approved: 3, notOurs: 1, unreviewed: 2, failing: 1, messages: 18420, dmarcPass: 18011 },
    ...extra,
  };
}

function evidence(domains: DomainEvidence[], extra: Partial<ClientEvidence> = {}): ClientEvidence {
  return {
    asOf: asOf.toISOString(),
    windowDays: 90,
    windowStart: new Date(asOf.getTime() - 90 * 86_400_000).toISOString(),
    domainCount: domains.length,
    domains,
    history: [
      { domain: 'pellowyn-dental.example', at: '2026-10-01T10:05:00.000Z', kind: 'first-check', text: 'Earliest check held: p=none was published.' },
      { domain: 'pellowyn-dental.example', at: '2026-11-12T06:00:00.000Z', kind: 'change', text: 'The DMARC policy strengthened from p=none to p=quarantine.' },
    ],
    historyTotal: 2,
    findings: {
      alerts: [],
      alertCount: 0,
      changes: [],
      changeCount: 0,
      checks: [],
      proposals: [
        { domain: 'pellowyn-dental.example', proposedAt: '2026-11-28T10:00:00.000Z', from: 'p=quarantine', to: 'p=reject', expiresAt: '2026-12-12T10:00:00.000Z' },
      ],
    },
    totals: {
      enforcing: domains.filter((d) => d.posture.dmarc.policy === 'quarantine' || d.posture.dmarc.policy === 'reject').length,
      monitoringOnly: domains.filter((d) => d.posture.dmarc.policy === 'none').length,
      noPolicy: 0,
      notChecked: 0,
      reportingHere: domains.length,
      receivingReports: domains.length,
      sources: 6 * domains.length,
      messages: 18420 * domains.length,
      dmarcPass: 18011 * domains.length,
      openFindings: 0,
    },
    checks: { oldest: '2026-12-01T06:00:00.000Z', newest: '2026-12-01T06:00:00.000Z' },
    reports: { inWindow: 120 * domains.length, reporters: 4, earliestPeriod: '2026-10-02T00:00:00.000Z', latestReceived: '2026-12-01T03:00:00.000Z' },
    ...extra,
  };
}

function facts(overrides: Partial<PackFacts> = {}): PackFacts {
  return {
    client: { name: 'Pellowyn Dental' },
    publisher: { workspaceName: 'Wistholm IT', branded: false, verifyBase: 'https://app.dmarcharbor.example' },
    asOf,
    reference,
    documentVersion: '2.0',
    portalContacts: 1,
    dataHeld: [
      { category: 'DMARC aggregate reports', description: 'Volume and results.', personal: false },
      { category: 'Account and billing records', description: 'Members and grants.', personal: true },
    ],
    retention: [
      { label: 'DMARC aggregate reports', value: '400 days from receipt, then deleted automatically' },
      { label: 'Forensic reports', value: '30 days from receipt, then deleted automatically' },
      { label: 'Named recipients in forensic data', value: '7 days, the shortest window, for the most sensitive data' },
      { label: 'Audit trail', value: 'Kept until a deletion request removes it. No automatic expiry is scheduled.' },
    ],
    subProcessors: [{ name: 'Resend', purpose: 'Transactional and alert email', data: 'Email addresses', region: 'Not confirmed yet' }],
    connectedServices: 'Services the agency connects are under its own agreements.',
    noTracking: 'No third-party analytics, advertising or session-replay service is used.',
    residency: { region: 'Not confirmed yet', hosting: 'A managed PostgreSQL database' },
    erasures: [],
    rights: { export: 'An export can be requested.', erasure: 'Deletion can be requested.' },
    lawEnforcement: 'Only under a valid legal process.',
    evidence: evidence([domain('pellowyn-dental.example', scan())]),
    monitor: { scheduled: true, intervalMinutes: 1440 },
    trustCenterPublished: true,
    ...overrides,
  };
}

// A render embeds and subsets five faces; on a busy runner that is seconds, not
// milliseconds, and the first one also parses the font files.
describe('compliance evidence pack PDF', { timeout: 60_000 }, () => {
  it('renders the same bytes for the same facts', async () => {
    const first = await renderCompliancePack(facts());
    const second = await renderCompliancePack(facts());
    expect(first.buffer.equals(second.buffer)).toBe(true);
    expect(createHash('sha256').update(first.buffer).digest('hex')).toBe(
      createHash('sha256').update(second.buffer).digest('hex'),
    );
  });

  it('embeds Albert Sans and Atkinson Hyperlegible Mono when the assets are there', async () => {
    const files = packFontFiles();
    expect(files.sans, 'apps/api/assets/fonts/AlbertSans-Regular.ttf should be found').toBeTruthy();
    expect(files.mono, 'apps/api/assets/fonts/AtkinsonHyperlegibleMono-Regular.ttf should be found').toBeTruthy();

    const rendered = await renderCompliancePack(facts());
    const raw = rendered.buffer.toString('latin1');
    expect(rendered.embeddedFonts).toEqual({ sans: true, mono: true });
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+AlbertSans-Regular/);
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+AlbertSans-Bold/);
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+AtkinsonHyperlegibleMono-Regular/);
    expect(raw).not.toContain('/BaseFont /Helvetica');
  });

  it('falls back to the standard faces rather than failing when the fonts are missing', async () => {
    const rendered = await renderCompliancePack(facts(), {});
    expect(rendered.embeddedFonts).toEqual({ sans: false, mono: false });
    const text = normalise(extractPdfText(rendered.buffer));
    expect(text).toContain(reference.toLowerCase());
    expect(text).toContain(normalise('How to verify this document'));
  });

  it('has a cover, a contents page, numbered sections and a reference on every page', async () => {
    const rendered = await renderCompliancePack(facts());
    const text = extractPdfText(rendered.buffer);
    const flat = normalise(text);

    for (const title of [
      'Contents',
      '1Summary',
      '2Domainscovered',
      '3Authenticationposture',
      '4DMARCpolicyhistory',
      '5Monitoringcoverage',
      '6Sendersseen',
      '7Openfindingsandwhatisbeingdone',
      '8Howthisevidencewasgathered',
      '9Datahandling',
      '10Yourrights',
      '11Howtoverifythisdocument',
      '12Contact',
    ]) {
      expect(flat).toContain(title.toLowerCase());
    }

    // The running foot: the reference and "page n of m" on every page.
    const occurrences = flat.split(reference.toLowerCase()).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(rendered.pageCount);
    expect(flat).toContain(`page1of${rendered.pageCount}`);
    expect(flat).toContain(`page${rendered.pageCount}of${rendered.pageCount}`);

    // A one-domain client: cover, contents and twelve sections.
    expect(rendered.pageCount).toBeGreaterThanOrEqual(4);
    expect(rendered.pageCount).toBeLessThanOrEqual(9);
  });

  it('states posture, history, coverage and the proposal from the facts it was given', async () => {
    const text = normalise(extractPdfText((await renderCompliancePack(facts())).buffer));
    expect(text).toContain('pellowyn-dental.example');
    expect(text).toContain(normalise('v=DMARC1; p=quarantine;'));
    expect(text).toContain(normalise('v=spf1 include:spf.protection.outlook.com -all'));
    expect(text).toContain(normalise('p=quarantine'));
    expect(text).toContain(normalise('The DMARC policy strengthened from p=none to p=quarantine.'));
    expect(text).toContain(normalise('61 of 90'));
    expect(text).toContain(normalise('From p=quarantine to p=reject'));
    expect(text).toContain(normalise('Not published'));
  });

  it('says plainly what it is and is not', async () => {
    const text = normalise(extractPdfText((await renderCompliancePack(facts())).buffer));
    expect(text).toContain(normalise('self attested'));
    expect(text).toContain(normalise('not a third party audit'));
    expect(text).toContain(normalise('cannot contain its own digest'));
    expect(text).toContain(normalise('No automatic expiry is scheduled.'));

    // Nothing this code cannot prove.
    for (const claim of ['soc2', 'soc 2', 'iso27001', 'iso/iec', 'certified', 'pentested', 'penetrationtested']) {
      expect(text).not.toContain(normalise(claim));
    }
  });

  it('names the product only when the agency is not white-labelled', async () => {
    const plain = await renderCompliancePack(facts());
    expect(normalise(extractPdfText(plain.buffer))).toContain(normalise('Wistholm IT, using DMARC Harbor'));

    const branded = await renderCompliancePack(
      facts({ publisher: { workspaceName: 'Wistholm IT', branded: true, verifyBase: 'https://portal.wistholm.example' } }),
    );
    const text = normalise(extractPdfText(branded.buffer));
    expect(text).not.toContain('dmarcharbor');
    expect(branded.buffer.toString('latin1')).not.toContain('DMARC Harbor');
    expect(text).toContain(normalise('portal.wistholm.example/verify?reference='));
  });

  it('says when a domain has not been checked rather than implying a pass', async () => {
    const unchecked = domain('corriwick-cafe.example', null);
    const rendered = await renderCompliancePack(
      facts({ evidence: evidence([unchecked], { totals: { ...evidence([unchecked]).totals, enforcing: 0, notChecked: 1 } }) }),
    );
    const text = normalise(extractPdfText(rendered.buffer));
    expect(text).toContain(normalise('Not checked yet'));
    expect(text).toContain(normalise('No completed check is held yet.'));
  });
});

describe('pack layout', () => {
  it('moves a table row that would not fit to the next page, labels and all', () => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: PAGE.top, bottom: 0, left: PAGE.x, right: PAGE.x }, bufferPages: true });
    const writer = new PackWriter(doc, applyPackFonts(doc));
    writer.y = PAGE.bottom - 40;
    const long = 'A cell long enough to wrap onto several lines in a narrow column, so the row is taller than the space left. '.repeat(2);
    writer.table(
      [
        { label: 'Domain', width: 120 },
        { label: 'Detail', width: 120 },
      ],
      [[{ text: 'one.example' }, { text: long }]],
    );
    // The header and the row were drawn together on a new page, below its top.
    expect(doc.bufferedPageRange().count).toBe(2);
    expect(writer.y).toBeGreaterThan(PAGE.top);
    expect(writer.y).toBeLessThan(PAGE.bottom);
    doc.end();
  });
});
