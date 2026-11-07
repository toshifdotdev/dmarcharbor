import PDFDocument from 'pdfkit';
import type { CheckState } from '../trust/client-evidence.js';
import { C, type TextStyle } from '../trust/pack-layout.js';
import {
  CONTENT_WIDTH,
  PAGE_MARGIN,
  ReportPage,
  facts as factList,
  section,
  type Cell,
  type SectionBlock,
} from '../trust/pdf-layout.js';
import { applyPackFonts, type PdfFontFiles } from '../trust/pdf-fonts.js';
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

/** One UTC day of the month that has reported mail. Days without any are absent. */
export interface MonthlyDailyFacts {
  /** YYYY-MM-DD */
  date: string;
  messages: number;
  dmarcPass: number;
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
  /** Sorted by date. Optional so a document issued before it existed still renders. */
  daily?: MonthlyDailyFacts[];
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
  /**
   * Not drawn. The report is set in ink like the compliance pack, which carries
   * no agency colour either: on paper the agency is its name and its logo. The
   * colour belongs to buttons on the agency's own domain. Kept so the branding
   * resolved for a report stays one shape.
   */
  primaryColor: string | null;
  logo: Buffer | null;
  /** Absolute origin, either the agency custom domain or APP_URL. */
  verifyBase: string;
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

/**
 * The state a published policy reads as, the same reading the pack gives it:
 * enforcing is aligned, monitoring or testing needs attention, no record is
 * failing, and a policy that could not be read is not measured.
 */
function policyState(policy: string): CheckState {
  switch (policy) {
    case 'reject':
    case 'quarantine':
      return 'pass';
    case 'none':
    case 'testing':
      return 'warn';
    case 'no record':
      return 'fail';
    default:
      return 'unchecked';
  }
}

function policyRows(facts: MonthlyFacts): Cell[][] {
  return policyOrder
    .filter((key) => key !== 'not known' || (facts.policyDistribution['not known'] ?? 0) > 0)
    .map((key) => {
      const count = facts.policyDistribution[key] ?? 0;
      // A policy no domain holds is a row of the scale, not a state any domain is
      // in, so it carries no mark and no colour: red is for a domain that fails.
      return count > 0
        ? [{ text: key, state: policyState(key) }, { text: String(count) }]
        : [{ text: key, color: C.ink3 }, { text: String(count), color: C.ink3 }];
    });
}

/** Domains and addresses are values a reader copies exactly. */
function literal(text: string): Cell {
  return { text, face: 'mono', size: 7.8 };
}

/** A rate with no messages under it is "no reports", set quietly; never 0%. */
function rate(passed: number, total: number): Cell {
  return { text: percentageText(passed, total), color: total > 0 ? C.ink : C.ink3 };
}

// Figures. Drawn in the app's chart language: passed mail green, failed mail
// red, a day with no report a short grey tick (never a zero), and every figure
// also stated in words in the text around it.

const r2 = (value: number) => Math.round(value * 100) / 100;
const KEY: TextStyle = { face: 'sans', size: 7.4, color: C.ink3, tnum: true };
const AXIS: TextStyle = { face: 'sans', size: 7.2, color: C.ink3, tnum: true };

/** A key swatch and its word; returns the x after it. A null fill is a hollow, not-measured swatch. */
function keyItem(page: ReportPage, x: number, y: number, fill: string | null, word: string): number {
  const doc = page.doc;
  if (fill) doc.rect(x, y + 1.7, 6, 6).fillColor(fill).fill();
  else doc.rect(x + 0.4, y + 2.1, 5.2, 5.2).lineWidth(0.7).strokeColor(C.rule2).stroke();
  page.pen.line(word, x + 9, y, KEY);
  return x + 9 + page.pen.widthOf(word, KEY) + 14;
}

const DAY_CHART = 64;
const DAY_FIGURE = DAY_CHART + 4 + 10 + 6 + 10;

/** The month day by day: a column per UTC day, passed green with failed red at its base. */
function dailyFigure(facts: MonthlyFacts): SectionBlock | null {
  const daily = facts.daily ?? [];
  if (facts.messages === 0 || daily.length === 0) return null;
  const days = Math.max(1, Math.round((facts.period.end.getTime() - facts.period.start.getTime()) / 86_400_000));
  const byDay = new Map(daily.map((d) => [d.date, d]));
  const keys = Array.from({ length: days }, (_, i) => new Date(facts.period.start.getTime() + i * 86_400_000).toISOString().slice(0, 10));
  const top = Math.max(1, ...daily.map((d) => d.messages));
  const slot = CONTENT_WIDTH / days;
  const bar = r2(Math.min(12, slot * 0.62));

  return {
    kind: 'figure',
    height: DAY_FIGURE,
    draw: (page, y) => {
      const doc = page.doc;
      const base = y + DAY_CHART;
      keys.forEach((key, i) => {
        const x = r2(PAGE_MARGIN + i * slot + (slot - bar) / 2);
        const day = byDay.get(key);
        if (!day || day.messages === 0) {
          doc.rect(x, base - 1.6, bar, 1.6).fillColor(C.rule2).fill();
          return;
        }
        const h = r2(Math.max(1.6, (day.messages / top) * (DAY_CHART - 2)));
        const failed = day.messages - day.dmarcPass;
        const f = failed > 0 ? r2(Math.max(1.2, (failed / top) * (DAY_CHART - 2))) : 0;
        doc.rect(x, base - h, bar, h - f).fillColor(C.done).fill();
        if (f > 0) doc.rect(x, base - f, bar, f).fillColor(C.red).fill();
      });
      page.pen.rule(base + 0.3, C.rule, 0.5);
      const labelY = base + 4;
      const label = (i: number) => String(Number(keys[i]!.slice(8, 10)));
      page.pen.textAt(label(0), PAGE_MARGIN, labelY, { ...AXIS, width: slot, align: 'center' });
      const mid = Math.floor(days / 2);
      page.pen.textAt(label(mid), PAGE_MARGIN + mid * slot, labelY, { ...AXIS, width: slot, align: 'center' });
      page.pen.textAt(label(days - 1), PAGE_MARGIN + (days - 1) * slot, labelY, { ...AXIS, width: slot, align: 'center' });
      let x: number = PAGE_MARGIN;
      const keyY = labelY + 16;
      x = keyItem(page, x, keyY, C.done, 'Passed DMARC');
      x = keyItem(page, x, keyY, C.red, 'Failed DMARC');
      keyItem(page, x, keyY, C.rule2, 'No mail reported that day');
    },
  };
}

const RATE_ROW = 15;

/** DMARC, SPF and DKIM pass rates as three meters. */
function ratesFigure(facts: MonthlyFacts): SectionBlock | null {
  if (facts.messages === 0) return null;
  const rows: Array<[string, number]> = [
    ['DMARC', facts.dmarcPass],
    ['SPF', facts.spfPass],
    ['DKIM', facts.dkimPass],
  ];
  const labelWidth = 48;
  const trackWidth = 300;
  return {
    kind: 'figure',
    height: rows.length * RATE_ROW,
    draw: (page, y) => {
      const doc = page.doc;
      rows.forEach(([name, passed], i) => {
        const rowY = y + i * RATE_ROW;
        page.pen.line(name, PAGE_MARGIN, rowY, { face: 'medium', size: 8.4, color: C.ink });
        const tx = PAGE_MARGIN + labelWidth;
        doc.roundedRect(tx, rowY + 2.4, trackWidth, 5, 2.5).fillColor(C.rule).fill();
        const w = r2((passed / facts.messages) * trackWidth);
        if (w > 0) doc.roundedRect(tx, rowY + 2.4, Math.max(5, w), 5, 2.5).fillColor(C.done).fill();
        page.pen.line(percentageText(passed, facts.messages), tx + trackWidth + 10, rowY, {
          face: 'medium',
          size: 8.4,
          color: C.ink,
          tnum: true,
        });
      });
    },
  };
}

/** How the stretch for each published policy is filled: green as far as reject, amber for no record. */
const POLICY_FILL: Record<string, string | null> = {
  reject: C.done,
  quarantine: '#9cd7b5',
  none: C.rule2,
  testing: C.rule2,
  'no record': C.warnMark,
  'not known': null,
};
const POLICY_KEY: Record<string, string> = {
  reject: 'at p=reject',
  quarantine: 'at p=quarantine',
  none: 'at p=none',
  testing: 'testing',
  'no record': 'with no record',
  'not known': 'not known',
};

const KEY_LINE = 13;

/**
 * Where the client's domains stand on the road to p=reject, as one bar, with
 * its key under it. The key wraps onto a second line rather than running off
 * the page, and the figure's height is measured for that before it is drawn.
 */
function policyFigure(page: ReportPage, facts: MonthlyFacts): SectionBlock | null {
  const parts = policyOrder
    .map((key) => ({ key, count: facts.policyDistribution[key] ?? 0 }))
    .filter((part) => part.count > 0);
  const total = parts.reduce((sum, part) => sum + part.count, 0);
  if (total === 0) return null;
  const words = parts.map((part) => `${n(part.count)} ${POLICY_KEY[part.key] ?? part.key}`);
  // Lay the key out once: each item is a swatch, its words and 14pt after.
  const placed: Array<{ x: number; line: number }> = [];
  let kx = 0;
  let line = 0;
  for (const word of words) {
    const w = 9 + page.pen.widthOf(word, KEY) + 14;
    if (kx > 0 && kx + w - 14 > CONTENT_WIDTH) {
      kx = 0;
      line += 1;
    }
    placed.push({ x: kx, line });
    kx += w;
  }
  const keyLines = line + 1;
  return {
    kind: 'figure',
    height: 10 + 8 + keyLines * KEY_LINE,
    draw: (page, y) => {
      const doc = page.doc;
      const gap = 1.5;
      const usable = CONTENT_WIDTH - gap * (parts.length - 1);
      let x: number = PAGE_MARGIN;
      for (const part of parts) {
        // A share too small to see is still drawn, at least a point wide.
        const w = r2(Math.max(1, (part.count / total) * usable));
        const fill = POLICY_FILL[part.key] ?? null;
        if (fill) doc.rect(x, y, w, 10).fillColor(fill).fill();
        else doc.rect(x + 0.35, y + 0.35, w - 0.7, 9.3).lineWidth(0.7).strokeColor(C.rule2).stroke();
        x += w + gap;
      }
      parts.forEach((part, i) => {
        const at = placed[i]!;
        keyItem(page, PAGE_MARGIN + at.x, y + 18 + at.line * KEY_LINE, POLICY_FILL[part.key] ?? null, words[i]!);
      });
    },
  };
}

/**
 * Renders the monthly evidence report and returns the exact bytes.
 *
 * The same facts, reference and issue time produce identical bytes. Every
 * clock read and every unsorted query result is settled before this function is
 * called; there is no `new Date()` and no map iteration whose order depends on
 * insertion here.
 *
 * `fonts` exists for tests: passing no files exercises the fallback to the
 * standard faces that a missing asset would cause in production.
 */
export async function renderMonthlyReportPdf(
  facts: MonthlyFacts,
  branding: MonthlyReportBranding,
  fonts?: PdfFontFiles,
): Promise<{ buffer: Buffer; pageCount: number; embeddedFonts: { sans: boolean; mono: boolean } }> {
  const title = `Email authentication report - ${facts.clientName}`;
  const author = branding.branded ? branding.workspaceName : 'DMARC Harbor';

  const doc = new PDFDocument({
    size: 'A4',
    // pdfkit's own bottom margin is zero: the layout decides every page break.
    margins: { top: PAGE_MARGIN, bottom: 0, left: PAGE_MARGIN, right: PAGE_MARGIN },
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

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  const faces = applyPackFonts(doc, fonts);
  const page = new ReportPage(doc, faces);
  const pen = page.pen;

  // Cover.
  if (branding.logo) {
    try {
      doc.image(branding.logo, PAGE_MARGIN, page.y, { fit: [120, 40] });
      page.y += 52;
    } catch {
      // The image was already validated. If PDFKit rejects it anyway, a report
      // without a logo is still a complete report.
    }
  }

  page.y +=
    pen.textAt('Email authentication report', PAGE_MARGIN, page.y, {
      face: 'bold',
      size: 26,
      tracking: -0.6,
      width: CONTENT_WIDTH,
    }) + 6;
  page.y +=
    pen.textAt(preparedBy(facts, branding), PAGE_MARGIN, page.y, {
      face: 'sans',
      size: 10.5,
      color: C.ink2,
      width: CONTENT_WIDTH,
    }) + 20;

  factList(page, [
    { label: 'Client', value: facts.clientName },
    { label: 'Period', value: facts.period.label },
    { label: 'Issued', value: issuedLabel(facts.issuedAt), figure: true },
    { label: 'Reference', value: facts.reference, mono: true },
  ]);

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

  const rates = ratesFigure(facts);
  if (rates) summaryBlocks.push(rates);

  const byDay = dailyFigure(facts);
  if (byDay) {
    const reported = facts.daily?.filter((day) => day.messages > 0).length ?? 0;
    summaryBlocks.push({
      kind: 'note',
      text: `Mail by day. Each column is one UTC day of ${facts.period.label}, scaled to the busiest day; mail was reported on ${reported} of them.`,
    });
    summaryBlocks.push(byDay);
  }

  const policies = policyFigure(page, facts);
  if (policies) summaryBlocks.push(policies);

  summaryBlocks.push({
    kind: 'table',
    columns: [
      { label: 'Policy', width: 150 },
      { label: 'Domains', width: 60, align: 'right' },
    ],
    rows: policyRows(facts),
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

  section(page, { number: '1', title: 'Summary', blocks: summaryBlocks });

  const domainBlocks: SectionBlock[] = [
    {
      kind: 'table',
      // Measured in the embedded faces: a rate column holds "no reports" on one
      // line, the policy column "quarantine" beside its mark, and the domain
      // column a 27-character name before it wraps.
      columns: [
        { label: 'Domain', width: CONTENT_WIDTH - 339 },
        { label: 'Policy', width: 66 },
        { label: 'Messages', width: 50, align: 'right' },
        { label: 'DMARC', width: 51, align: 'right' },
        { label: 'SPF', width: 51, align: 'right' },
        { label: 'DKIM', width: 51, align: 'right' },
        { label: 'Reports', width: 38, align: 'right' },
        { label: 'Orgs', width: 32, align: 'right' },
      ],
      rows: facts.domains.map((domain) => [
        literal(domain.name),
        { text: domain.policy, state: policyState(domain.policy) },
        { text: n(domain.messages) },
        rate(domain.dmarcPass, domain.messages),
        rate(domain.spfPass, domain.messages),
        rate(domain.dkimPass, domain.messages),
        { text: n(domain.reports) },
        { text: n(domain.organisations) },
      ]),
    },
  ];
  if (facts.domainCount > facts.domains.length) {
    domainBlocks.push({
      kind: 'note',
      text: `and ${facts.domainCount - facts.domains.length} more domains are included in the totals`,
    });
  }
  section(page, { number: '2', title: 'Domains', blocks: domainBlocks });

  const changeBlocks: SectionBlock[] =
    facts.changes.length === 0
      ? [{ kind: 'body', text: 'No warning or critical DNS changes were recorded.' }]
      : [
          {
            kind: 'table',
            columns: [
              { label: 'Date', width: 70 },
              { label: 'Domain', width: 140 },
              { label: 'Change', width: CONTENT_WIDTH - 210 },
            ],
            rows: facts.changes.map((change) => [
              { text: dateLabel(change.detectedAt) },
              literal(change.domainName),
              { text: change.summary },
            ]),
          },
        ];
  if (facts.changeCount > facts.changes.length) {
    changeBlocks.push({
      kind: 'note',
      text: `and ${facts.changeCount - facts.changes.length} more changes are not listed`,
    });
  }
  section(page, { number: '3', title: 'Changes to DNS during the month', blocks: changeBlocks });

  const sourceBlocks: SectionBlock[] =
    facts.sources.length === 0
      ? [{ kind: 'body', text: 'No failing source was recorded in the period.' }]
      : [
          {
            kind: 'table',
            columns: [
              { label: 'Source IP', width: 96 },
              { label: 'Service', width: 100 },
              { label: 'Sender domain', width: 135 },
              { label: 'Failed messages', width: 76, align: 'right' },
              { label: 'Total messages', width: CONTENT_WIDTH - 407, align: 'right' },
            ],
            rows: facts.sources.map((source) => [
              literal(source.sourceIp),
              source.service ? { text: source.service } : { text: 'not identified', color: C.ink3 },
              source.senderDomain ? literal(source.senderDomain) : { text: 'not known', color: C.ink3 },
              // Failed mail is the one thing the report sets in red, as the pack
              // sets its failing sources.
              { text: n(source.failedMessages), color: source.failedMessages > 0 ? C.red : C.ink },
              { text: n(source.totalMessages) },
            ]),
          },
          {
            kind: 'note',
            text: 'A failing source can be a legitimate service that has not been set up for this domain yet.',
          },
        ];
  section(page, { number: '4', title: 'Sources failing authentication', blocks: sourceBlocks });

  section(page, {
    number: '5',
    title: 'Alerts and forensic reports',
    blocks: [
      {
        kind: 'facts',
        rows: [
          { label: 'Alerts opened', value: n(facts.alertsOpened), figure: true },
          { label: 'Alerts resolved', value: n(facts.alertsResolved), figure: true },
          { label: 'Forensic reports received', value: n(facts.forensicCount), figure: true },
        ],
      },
    ],
  });

  section(page, {
    number: '6',
    title: 'How these figures are measured',
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

  section(page, {
    number: '7',
    title: 'How to verify this document',
    blocks: [
      {
        kind: 'body',
        text:
          'The digest is deliberately not printed here. A file cannot contain its own digest, because writing it in changes the file and therefore changes the digest. The digest is published at the address below, so there is exactly one value and it cannot disagree with itself.',
      },
      {
        kind: 'facts',
        rows: [
          { label: 'Reference', value: facts.reference, mono: true },
          {
            label: 'Verify at',
            value: `${branding.verifyBase}/verify?reference=${encodeURIComponent(facts.reference)}`,
            mono: true,
          },
        ],
      },
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

  return { buffer: await finished, pageCount, embeddedFonts: faces.embedded };
}
