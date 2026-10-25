import PDFDocument from 'pdfkit';
import {
  ACCENT,
  CONTENT_WIDTH,
  INK,
  MUTED,
  PAGE_MARGIN,
  Page,
  labelled,
  section,
  type SectionBlock,
} from '../trust/pdf-layout.js';
import { percentageText, type MonthlyPeriod } from './monthly-period.js';

export interface MonthlyDomainFacts {
  name: string;
  /** none | quarantine | reject | testing | no record | not known */
  policy: string;
  messages: number;
  dmarcPass: number;
  spfPass: number;
  dkimPass: number;
  reports: number;
  organisations: number;
}

export interface MonthlyChangeFacts {
  domainName: string;
  summary: string;
  detectedAt: Date;
}

export interface MonthlySourceFacts {
  sourceIp: string;
  senderDomain: string | null;
  failedMessages: number;
  totalMessages: number;
  service: string | null;
}

export interface MonthlyFacts {
  clientName: string;
  agencyName: string;
  period: MonthlyPeriod;
  reference: string;
  issuedAt: Date;
  domains: MonthlyDomainFacts[];
  domainCount: number;
  totalReports: number;
  messages: number;
  dmarcPass: number;
  spfPass: number;
  dkimPass: number;
  policyDistribution: Record<string, number>;
  policyMoved: number;
  domainsWithoutReports: number;
  changes: MonthlyChangeFacts[];
  changeCount: number;
  sources: MonthlySourceFacts[];
  forensicCount: number;
  alertsOpened: number;
  alertsResolved: number;
}

export interface MonthlyReportBranding {
  branded: boolean;
  workspaceName: string;
  /** Already validated by resolveBranding; checked again before it reaches PDFKit. */
  primaryColor: string | null;
  logo: Buffer | null;
  /** Absolute origin, either the agency custom domain or APP_URL. */
  verifyBase: string;
}

function accentFor(branding: MonthlyReportBranding): string {
  if (!branding.branded || !branding.primaryColor) {
    return ACCENT;
  }
  return /^#[0-9a-f]{6}$/i.test(branding.primaryColor) ? branding.primaryColor.toLowerCase() : ACCENT;
}

function n(value: number): string {
  return value.toLocaleString('en-GB');
}

function dateLabel(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function issuedLabel(value: Date): string {
  return value.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function preparedBy(facts: MonthlyFacts, branding: MonthlyReportBranding): string {
  return branding.branded
    ? `Prepared by ${branding.workspaceName}`
    : `Prepared by ${facts.agencyName} using DMARC Harbor`;
}

const policyOrder = ['none', 'quarantine', 'reject', 'testing', 'no record', 'not known'];

function policyRows(facts: MonthlyFacts): string[][] {
  return policyOrder
    .filter((key) => key !== 'not known' || (facts.policyDistribution['not known'] ?? 0) > 0)
    .map((key) => [key, String(facts.policyDistribution[key] ?? 0)]);
}

/**
 * Renders the monthly evidence report and returns the exact bytes.
 *
 * The same facts, reference and issue time produce identical bytes. Every
 * clock read and every unsorted query result is settled before this function is
 * called; there is no `new Date()` and no map iteration whose order depends on
 * insertion here.
 */
export async function renderMonthlyReportPdf(
  facts: MonthlyFacts,
  branding: MonthlyReportBranding,
): Promise<{ buffer: Buffer; pageCount: number }> {
  const accent = accentFor(branding);
  const title = `Email authentication report - ${facts.clientName}`;
  const author = branding.branded ? branding.workspaceName : 'DMARC Harbor';

  const doc = new PDFDocument({
    size: 'A4',
    margin: PAGE_MARGIN,
    bufferPages: true,
    compress: false,
    info: {
      Title: title,
      Author: author,
      Subject: `DMARC aggregate evidence for ${facts.period.label}`,
      Creator: author,
      Producer: author,
      CreationDate: facts.issuedAt,
      ModDate: facts.issuedAt,
    },
  });

  const page = new Page(doc);
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  // Cover.
  if (branding.logo) {
    try {
      doc.image(branding.logo, PAGE_MARGIN, page.y, { fit: [120, 40] });
      page.move(52);
    } catch {
      // The image was already validated. If PDFKit rejects it anyway, a report
      // without a logo is still a complete report.
    }
  }

  doc.rect(PAGE_MARGIN, page.y, 56, 4).fillColor(accent).fill();
  page.move(18);

  doc.font('Helvetica-Bold').fontSize(22).fillColor(INK).text('Email authentication report', PAGE_MARGIN, page.y, {
    width: CONTENT_WIDTH,
  });
  page.move(30);

  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(preparedBy(facts, branding), PAGE_MARGIN, page.y, {
    width: CONTENT_WIDTH,
  });
  page.move(18);

  labelled(doc, page, 'Client', facts.clientName);
  labelled(doc, page, 'Period', facts.period.label);
  labelled(doc, page, 'Issued', issuedLabel(facts.issuedAt));
  labelled(doc, page, 'Reference', facts.reference);

  const noReports = facts.totalReports === 0;
  const summaryBlocks: SectionBlock[] = [];

  if (noReports) {
    summaryBlocks.push({
      kind: 'body',
      text: `No aggregate reports were received for this client's domains in ${facts.period.label}.`,
    });
  }

  if (facts.messages > 0) {
    summaryBlocks.push({
      kind: 'body',
      text:
        `Across all ${facts.domainCount} domain${facts.domainCount === 1 ? '' : 's'}, ${n(facts.messages)} messages were observed. ` +
        `${percentageText(facts.dmarcPass, facts.messages)} passed DMARC, ${percentageText(facts.spfPass, facts.messages)} passed SPF and ${percentageText(facts.dkimPass, facts.messages)} passed DKIM.`,
    });
  } else {
    summaryBlocks.push({
      kind: 'body',
      text: 'No messages were observed in the period, so no pass rates are shown.',
    });
  }

  summaryBlocks.push({
    kind: 'table',
    columns: [
      { label: 'Policy at period end', width: 260 },
      { label: 'Domains', width: 100 },
    ],
    rows: [['Policy', 'Domains'], ...policyRows(facts)],
  });

  summaryBlocks.push({
    kind: 'body',
    text:
      facts.policyMoved > 0
        ? `Policy at the end of the month differed from policy at the start for ${facts.policyMoved} domain${facts.policyMoved === 1 ? '' : 's'}.`
        : 'No domain’s policy at the end of the month differed from its policy at the start.',
  });
  summaryBlocks.push({
    kind: 'body',
    text: `${facts.domainsWithoutReports} domain${facts.domainsWithoutReports === 1 ? '' : 's'} had no aggregate reports in the month.`,
  });

  section(doc, page, { title: '1. Summary', blocks: summaryBlocks, accent });

  const domainRows: string[][] = [
    ['Domain', 'Policy', 'Messages', 'DMARC', 'SPF', 'DKIM', 'Reports', 'Orgs'],
    ...facts.domains.map((domain) => [
      domain.name,
      domain.policy,
      n(domain.messages),
      percentageText(domain.dmarcPass, domain.messages),
      percentageText(domain.spfPass, domain.messages),
      percentageText(domain.dkimPass, domain.messages),
      n(domain.reports),
      n(domain.organisations),
    ]),
  ];

  const domainBlocks: SectionBlock[] = [
    {
      kind: 'table',
      columns: [
        { label: 'Domain', width: 140 },
        { label: 'Policy', width: 62 },
        { label: 'Messages', width: 45 },
        { label: 'DMARC', width: 55 },
        { label: 'SPF', width: 45 },
        { label: 'DKIM', width: 45 },
        { label: 'Reports', width: 46 },
        { label: 'Orgs', width: 45 },
      ],
      rows: domainRows,
    },
  ];
  if (facts.domainCount > facts.domains.length) {
    domainBlocks.push({
      kind: 'body',
      text: `and ${facts.domainCount - facts.domains.length} more domains are included in the totals`,
    });
  }
  section(doc, page, { title: '2. Domains', blocks: domainBlocks, accent });

  const changeRows = facts.changes.map((change) => [dateLabel(change.detectedAt), change.domainName, change.summary]);
  const changeBlocks: SectionBlock[] = [
    {
      kind: changeRows.length === 0 ? 'body' : 'table',
      ...(changeRows.length === 0
        ? { text: 'No warning or critical DNS changes were recorded.' }
        : {
            columns: [
              { label: 'Date', width: 70 },
              { label: 'Domain', width: 140 },
              { label: 'Change', width: 273 },
            ],
            rows: [['Date', 'Domain', 'Change'], ...changeRows],
          }),
    },
  ];
  if (facts.changeCount > facts.changes.length) {
    changeBlocks.push({
      kind: 'body',
      text: `and ${facts.changeCount - facts.changes.length} more changes are not listed`,
    });
  }
  section(doc, page, { title: '3. Changes to DNS during the month', blocks: changeBlocks, accent });

  const sourceBlocks: SectionBlock[] =
    facts.sources.length === 0
      ? [{ kind: 'body', text: 'No failing source was recorded in the period.' }]
      : [
          {
            kind: 'table',
            columns: [
              { label: 'Source IP', width: 100 },
              { label: 'Service', width: 105 },
              { label: 'Sender domain', width: 120 },
              { label: 'Failed messages', width: 78 },
              { label: 'Total messages', width: 80 },
            ],
            rows: [
              ['Source IP', 'Service', 'Sender domain', 'Failed messages', 'Total messages'],
              ...facts.sources.map((source) => [
                source.sourceIp,
                source.service ?? 'not identified',
                source.senderDomain ?? 'not known',
                n(source.failedMessages),
                n(source.totalMessages),
              ]),
            ],
          },
          {
            kind: 'note',
            text: 'A failing source can be a legitimate service that has not been set up for this domain yet.',
          },
        ];
  section(doc, page, { title: '4. Sources failing authentication', blocks: sourceBlocks, accent });

  section(doc, page, {
    title: '5. Alerts and forensic reports',
    accent,
    blocks: [
      { kind: 'labelled', label: 'Alerts opened', value: n(facts.alertsOpened) },
      { kind: 'labelled', label: 'Alerts resolved', value: n(facts.alertsResolved) },
      { kind: 'labelled', label: 'Forensic reports received', value: n(facts.forensicCount) },
    ],
  });

  section(doc, page, {
    title: '6. How these figures are measured',
    accent,
    blocks: [
      {
        kind: 'body',
        text:
          'The figures come from aggregate reports that receivers chose to send. A receiver that sent nothing is not counted, and a domain with no messages is shown as no reports rather than 0%.',
      },
      {
        kind: 'body',
        text: `The period covers ${facts.period.start.toISOString()} up to, but not including, ${facts.period.end.toISOString()}. An aggregate report belongs to the month in which its reporting period begins.`,
      },
      {
        kind: 'body',
        text: 'A pass is measured from the message counts in those reports, never averaged across domains. The DMARC pass rate counts a message when either its aligned DKIM check or its aligned SPF check passed.',
      },
    ],
  });

  section(doc, page, {
    title: '7. How to verify this document',
    accent,
    blocks: [
      {
        kind: 'body',
        text:
          'The digest is deliberately not printed here. A file cannot contain its own digest, because writing it in changes the file and therefore changes the digest. The digest is published at the address below, so there is exactly one value and it cannot disagree with itself.',
      },
      { kind: 'labelled', label: 'Reference', value: facts.reference },
      { kind: 'labelled', label: 'Verify at', value: `${branding.verifyBase}/verify?reference=${encodeURIComponent(facts.reference)}` },
      {
        kind: 'body',
        text: 'To verify: compute the SHA-256 digest of this file and compare it with the value published for this reference. A match means the file is byte for byte the one that was issued.',
      },
    ],
  });

  const pageCount = doc.bufferedPageRange().count;
  doc.flushPages();

  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.end();

  return { buffer: await finished, pageCount };
}
