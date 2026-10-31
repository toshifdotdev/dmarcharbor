import PDFDocument from 'pdfkit';
import {
  instantText,
  longDate,
  shareText,
  shortDate,
  senderLine,
  type CheckReading,
  type CheckState,
} from './client-evidence.js';
import type { ClientEvidence, DomainEvidence } from './client-evidence.service.js';
import { C, MEASURE, PAGE, PackWriter, WIDTH, type Cell, type Column } from './pack-layout.js';
import { applyPackFonts, type PdfFontFiles } from './pdf-fonts.js';
import type { SubProcessor } from './trust-center.service.js';

/**
 * pack-pdf.ts — renders the compliance evidence pack from its facts.
 *
 * Pure: the facts arrive gathered, and nothing here reads the database, the
 * clock or the environment. The same facts give the same bytes, which is the
 * property the published SHA-256 rests on.
 *
 * The document is set like a report a careful firm would send: a cover that
 * says who it is for, who issued it, as of when and under which reference; a
 * contents page; numbered sections; a running head naming the publisher and
 * the client; and a running foot carrying the reference and "page n of m" on
 * every page, so a single printed sheet can still be traced to its document.
 *
 * It asserts only what the system holds, and says plainly where something is
 * not measured. It is a self attestation and says so on its cover and again
 * where it explains how to verify it.
 */

export interface PackFacts {
  client: { name: string };
  publisher: {
    workspaceName: string;
    /** White-labelled: the agency's name stands alone and the product is not named. */
    branded: boolean;
    /** Origin of the public verifier: the agency's verified domain when branded, else ours. */
    verifyBase: string;
  };
  asOf: Date;
  reference: string;
  documentVersion: string;
  portalContacts: number;
  dataHeld: { category: string; description: string; personal: boolean }[];
  retention: { label: string; value: string }[];
  subProcessors: SubProcessor[];
  connectedServices: string;
  noTracking: string;
  residency: { region: string; hosting: string };
  erasures: { scope: string; completedAt: string; records: number }[];
  rights: { export: string; erasure: string };
  lawEnforcement: string;
  evidence: ClientEvidence;
  /** The scheduled DNS monitor as this deployment runs it. */
  monitor: { scheduled: boolean; intervalMinutes: number };
  /** Whether the client has a published Trust Center, which also lists this pack's digest. */
  trustCenterPublished: boolean;
}

/** "every 24 hours", "every 90 minutes". */
export function intervalText(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `every ${hours === 1 ? 'hour' : `${hours} hours`}`;
  }
  return `every ${minutes} minutes`;
}

const PRODUCT = 'DMARC Harbor';
const KIND = 'DMARC evidence pack';

function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
}

function verb(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function figure(n: number): string {
  return n.toLocaleString('en-GB');
}

function preparedBy(facts: PackFacts): string {
  return facts.publisher.branded
    ? facts.publisher.workspaceName
    : `${facts.publisher.workspaceName}, using ${PRODUCT}`;
}

function verifyUrl(facts: PackFacts): string {
  return `${facts.publisher.verifyBase.replace(/\/$/, '')}/verify?reference=${encodeURIComponent(facts.reference)}`;
}

function stateCell(reading: CheckReading): Cell {
  return { text: reading.word, state: reading.state };
}

function ownershipCell(domain: DomainEvidence): Cell {
  if (domain.ownership === 'verified') {
    return { text: 'Verified', state: 'pass', sub: domain.verifiedAt ? shortDate(domain.verifiedAt) : null };
  }
  if (domain.ownership === 'failed') return { text: 'Not verified', state: 'fail' };
  return { text: 'Pending', state: 'warn' };
}

function reportingCell(domain: DomainEvidence): Cell {
  switch (domain.coverage.reporting) {
    case 'this-service':
      return { text: 'To monitoring', state: 'pass' };
    case 'elsewhere':
      return { text: 'Elsewhere only', state: 'warn' };
    case 'none':
      return { text: 'Not requested', state: 'fail' };
    default:
      return { text: 'Not known', state: 'unchecked' };
  }
}

function domainCell(name: string): Cell {
  return { text: name, face: 'mono', size: 7.8 };
}

function numberCell(value: number | string): Cell {
  return { text: typeof value === 'number' ? figure(value) : value };
}

/** Section 1: the facts a reader asks first, in sentences. */
function summarySentences(facts: PackFacts): string[] {
  const e = facts.evidence;
  const t = e.totals;
  const listed = e.domains.length;
  const sentences: string[] = [];

  sentences.push(
    `${facts.client.name} has ${count(e.domainCount, 'domain')} covered by this document${
      e.domainCount > listed ? `; the first ${figure(listed)}, in alphabetical order, are listed and counted here` : ''
    }.`,
  );

  if (listed === 0) {
    sentences.push('No domain has been added for this client yet, so there is no posture or monitoring evidence to report.');
    return sentences;
  }

  const checked = listed - t.notChecked;
  if (checked > 0) {
    sentences.push(
      `At the latest DNS check, ${figure(t.enforcing)} ${verb(t.enforcing, 'publishes', 'publish')} p=quarantine or p=reject, ` +
        `${figure(t.monitoringOnly)} ${verb(t.monitoringOnly, 'publishes', 'publish')} p=none, and ${figure(t.noPolicy)} ` +
        `${verb(t.noPolicy, 'publishes', 'publish')} no usable DMARC record.` +
        (t.notChecked > 0 ? ` ${count(t.notChecked, 'domain has', 'domains have')} not been checked yet.` : ''),
    );
  } else {
    sentences.push('None of the domains has a completed DNS check yet, so no posture is reported.');
  }

  sentences.push(
    `${figure(t.reportingHere)} of ${figure(listed)} ${verb(listed, 'asks', 'ask')} receivers to send aggregate reports to the monitoring address, ` +
      `and reports arrived for ${figure(t.receivingReports)} in the last ${e.windowDays} days.`,
  );

  sentences.push(
    t.messages > 0
      ? `Those reports describe ${figure(t.messages)} messages from ${count(t.sources, 'sending source')}; ${shareText(t.dmarcPass, t.messages)} passed DMARC.`
      : 'No messages were reported in that window, so no pass rate is given.',
  );

  sentences.push(
    t.openFindings === 0
      ? 'No open findings were recorded at the time of issue.'
      : `${count(t.openFindings, 'open finding')} ${verb(t.openFindings, 'is', 'are')} listed in section 7, with what is being done about each.`,
  );
  return sentences;
}

function drawCover(w: PackWriter, facts: PackFacts): void {
  const e = facts.evidence;
  const t = e.totals;
  const listed = e.domains.length;

  // Masthead: the publisher in bold, what the document is beside it.
  const name = facts.publisher.workspaceName;
  w.line(name, PAGE.x, 56, { face: 'bold', size: 11 });
  w.line(KIND, PAGE.x + w.widthOf(name, { face: 'bold', size: 11 }) + 8, 56, { face: 'sans', size: 11, color: C.ink3 });
  w.rule(80, C.rule, 0.6);

  // The title block.
  let y = 196;
  y += w.textAt('Prepared for', PAGE.x, y, { face: 'medium', size: 10.5, color: C.ink3, width: WIDTH }) + 6;
  y += w.textAt(facts.client.name, PAGE.x, y, { face: 'bold', size: 34, tracking: -0.9, lineGap: -5, width: WIDTH }) + 14;
  y += w.textAt(
    `Email authentication posture, monitoring evidence and data handling for ${count(e.domainCount, 'domain')}, as recorded on ${longDate(facts.asOf)}.`,
    PAGE.x,
    y,
    { face: 'sans', size: 12, color: C.ink2, lineGap: 3, width: 400 },
  );

  w.y = Math.max(y + 34, 376);
  w.readouts([
    { label: 'Domains', value: figure(e.domainCount), note: 'covered by this document' },
    { label: 'At enforcement', value: `${figure(t.enforcing)} of ${figure(listed)}`, note: 'publish p=quarantine or p=reject' },
    { label: 'Reporting', value: `${figure(t.receivingReports)} of ${figure(listed)}`, note: `sent reports in the last ${e.windowDays} days` },
    { label: 'Open findings', value: figure(t.openFindings), note: 'listed in section 7' },
  ]);

  // Identity of the document, set low on the page.
  w.y = Math.max(w.y + 24, 552);
  w.facts(
    [
      { label: 'Prepared for', value: facts.client.name },
      { label: 'Prepared by', value: preparedBy(facts) },
      { label: 'Evidence as of', value: instantText(facts.asOf) },
      {
        label: 'Measurement window',
        value: `${longDate(e.windowStart)} to ${longDate(facts.asOf)} (${e.windowDays} days)`,
      },
      { label: 'Document version', value: facts.documentVersion },
      { label: 'Reference', value: facts.reference, mono: true },
    ],
    132,
  );

  w.textAt(
    `Self attested by ${facts.publisher.workspaceName}; not a third party audit or certification. Check that a copy is unaltered at ${facts.publisher.verifyBase.replace(/^https?:\/\//, '').replace(/\/$/, '')}/verify.`,
    PAGE.x,
    Math.max(w.y + 6, PAGE.bottom - 26),
    { face: 'sans', size: 8, color: C.ink3, width: WIDTH, lineGap: 1.4 },
  );
}

function drawContents(w: PackWriter, facts: PackFacts, pageIndex: number): void {
  w.doc.switchToPage(pageIndex);
  w.y = PAGE.top;
  w.textAt('Contents', PAGE.x, w.y, { face: 'bold', size: 15, tracking: -0.25, width: WIDTH });
  w.y += 26;
  w.rule(w.y, C.ink, 0.9);
  w.y += 4;

  for (const section of w.sections) {
    const rowTop = w.y;
    const page = String(section.page + 1);
    w.line(section.number, PAGE.x, rowTop + 6, { face: 'medium', size: 9.5, color: C.ink3, tnum: true });
    w.line(section.title, PAGE.x + 26, rowTop + 6, { face: 'medium', size: 9.5 });
    const pageWidth = w.widthOf(page, { face: 'sans', size: 9.5 });
    w.line(page, PAGE.x + WIDTH - pageWidth, rowTop + 6, { face: 'sans', size: 9.5, color: C.ink2, tnum: true });
    w.doc.goTo(PAGE.x, rowTop + 2, WIDTH, 18, section.destination);
    w.y = rowTop + 22;
    w.rule(w.y, C.rule, 0.5);
  }

  w.y += 34;
  w.textAt('About this document', PAGE.x, w.y, { face: 'bold', size: 10.5, width: WIDTH });
  w.y += 18;
  const about = [
    `${facts.publisher.workspaceName} issued this document for ${facts.client.name}. It is generated from the records held for the client's domains at the moment of issue: the newest DNS check of each domain, the aggregate reports received from mail providers, the change history between checks, and the alerts and approvals on record. Section 8 says how each was gathered.`,
    'Every figure is as of the date on the cover. Nothing in it comes from a questionnaire or from a statement by the client. Where something has not been measured, the document says so rather than leaving a gap.',
    `It is self attested: it shows what the records say, and it is not a third party audit, a certification or a penetration test. Its SHA-256 digest is published against the reference in the foot of every page, so anyone holding a copy can check it is the one that was issued (section 11).`,
  ];
  for (const text of about) {
    w.y += w.textAt(text, PAGE.x, w.y, { face: 'sans', size: 9.5, color: C.ink2, lineGap: 2.4, width: MEASURE }) + 7;
  }

  w.y += 14;
  w.textAt('How the states are marked', PAGE.x, w.y, { face: 'bold', size: 10.5, width: WIDTH });
  w.y += 20;
  const legend: { state: CheckState; word: string; meaning: string }[] = [
    { state: 'pass', word: 'Filled square', meaning: 'in place and working as published' },
    { state: 'warn', word: 'Ring', meaning: 'published but weaker than it could be, or needs attention' },
    { state: 'fail', word: 'Diamond', meaning: 'missing, broken, or failing' },
    { state: 'absent', word: 'Hollow station', meaning: 'an optional standard that is not published' },
    { state: 'unchecked', word: 'Hatched square', meaning: 'not measured: no check or report to go on' },
  ];
  for (const entry of legend) {
    w.mark(entry.state, PAGE.x + 3.4, w.y + 5.4);
    w.line(entry.word, PAGE.x + 14, w.y, { face: 'medium', size: 9, color: C.ink });
    w.line(entry.meaning, PAGE.x + 110, w.y, { face: 'sans', size: 9, color: C.ink2 });
    w.y += 16;
  }
  w.y += 6;
  w.textAt('The state is always written as a word beside its mark, so the document reads the same in black and white.', PAGE.x, w.y, {
    face: 'sans',
    size: 8,
    color: C.ink3,
    width: MEASURE,
  });
}

function drawRunningHeads(w: PackWriter, facts: PackFacts): number {
  const range = w.doc.bufferedPageRange();
  const total = range.count;
  for (let index = range.start; index < range.start + total; index += 1) {
    w.doc.switchToPage(index);
    if (index > range.start) {
      const name = facts.publisher.workspaceName;
      w.line(name, PAGE.x, 36, { face: 'bold', size: 8 });
      w.line(KIND, PAGE.x + w.widthOf(name, { face: 'bold', size: 8 }) + 5, 36, { face: 'sans', size: 8, color: C.ink3 });
      const client = facts.client.name;
      const clientWidth = w.widthOf(client, { face: 'sans', size: 8 });
      w.line(client, PAGE.x + WIDTH - clientWidth, 36, { face: 'sans', size: 8, color: C.ink3 });
      w.rule(52, C.rule, 0.5);
    }
    const footY = PAGE.height - 46;
    w.rule(footY - 8, C.rule, 0.5);
    const label = 'Reference';
    w.line(label, PAGE.x, footY, { face: 'sans', size: 7.4, color: C.ink3 });
    w.line(facts.reference, PAGE.x + w.widthOf(label, { face: 'sans', size: 7.4 }) + 5, footY, { face: 'mono', size: 7.4, color: C.ink });
    const pageText = `Page ${index - range.start + 1} of ${total}`;
    const pageWidth = w.widthOf(pageText, { face: 'sans', size: 7.4 });
    w.line(pageText, PAGE.x + WIDTH - pageWidth, footY, { face: 'sans', size: 7.4, color: C.ink3, tnum: true });
  }
  return total;
}

function sectionSummary(w: PackWriter, facts: PackFacts): void {
  w.section('1', 'Summary');
  for (const sentence of summarySentences(facts)) w.paragraph(sentence);
}

function sectionDomains(w: PackWriter, facts: PackFacts): void {
  const e = facts.evidence;
  w.section('2', 'Domains covered');
  w.paragraph(
    'Each domain the agency monitors for this client. Ownership is verified when the domain publishes the ownership record the agency was given; a domain that is not verified is listed, but it is not checked on a schedule.',
  );
  const columns: Column[] = [
    { label: 'Domain', width: 190 },
    { label: 'Ownership', width: 100 },
    { label: 'Added', width: 90 },
    { label: 'Last DNS check', width: WIDTH - 380 },
  ];
  w.table(
    columns,
    e.domains.map((domain) => [
      domainCell(domain.name),
      ownershipCell(domain),
      { text: shortDate(domain.addedAt) },
      { text: domain.posture.checkedAt ? shortDate(domain.posture.checkedAt) : 'Not checked yet', color: domain.posture.checkedAt ? C.ink : C.ink3 },
    ]),
    'No domain has been added for this client.',
  );
  if (e.domainCount > e.domains.length) {
    w.note(`${count(e.domainCount - e.domains.length, 'more domain is', 'more domains are')} held for this client and not listed in this document.`);
  }
}

function sectionPosture(w: PackWriter, facts: PackFacts): void {
  const e = facts.evidence;
  w.section('3', 'Authentication posture');
  w.paragraph(
    'From the newest completed DNS check of each domain. A check reads the published records from public DNS; it shows what receivers are told to do, not what happened to any one message. MTA-STS, TLS-RPT and BIMI are optional standards, so "Not published" is a fact rather than a fault.',
  );

  w.subheading('DMARC enforcement');
  const pending = new Map(e.findings.proposals.map((proposal) => [proposal.domain, proposal]));
  const level = (policy: string): 0 | 1 | 2 | null => {
    const p = policy.replace(/^p=/, '').split(',')[0]!.trim();
    return p === 'none' ? 0 : p === 'quarantine' ? 1 : p === 'reject' ? 2 : null;
  };
  w.table(
    [
      { label: 'Domain', width: 160 },
      { label: 'none, quarantine, reject', width: 104 },
      { label: 'Policy', width: WIDTH - 264 },
    ],
    e.domains.map((domain) => {
      const dmarc = domain.posture.dmarc;
      const proposal = pending.get(domain.name);
      return [
        domainCell(domain.name),
        { text: '', strip: { level: dmarc.level, planned: proposal ? level(proposal.to) : null } },
        { text: dmarc.word, state: dmarc.state, sub: dmarc.detail },
      ];
    }),
    'No domain to report.',
  );
  w.note('The line runs in ink as far as the published policy. A dashed segment is a stronger policy proposed to the client and not yet approved.');

  w.subheading('Other checks');
  w.table(
    [
      { label: 'Domain', width: 124 },
      { label: 'SPF', width: 72 },
      { label: 'DKIM', width: 72 },
      { label: 'MTA-STS', width: 72 },
      { label: 'TLS-RPT', width: 72 },
      { label: 'BIMI', width: WIDTH - 412 },
    ],
    e.domains.map((domain) => [
      domainCell(domain.name),
      stateCell(domain.posture.spf),
      stateCell(domain.posture.dkim),
      stateCell(domain.posture.mtaSts),
      stateCell(domain.posture.tlsRpt),
      stateCell(domain.posture.bimi),
    ]),
    'No domain to report.',
  );

  const detailed = e.domains.slice(0, 25);
  w.subheading('Records as published', 60);
  w.paragraph('The values read at the newest check, quoted exactly, with what each reading rests on.');
  for (const domain of detailed) {
    const p = domain.posture;
    w.subheading(domain.name, 80, 'monoMedium');
    const reading = (label: string, r: CheckReading, record: string | null = null) => ({
      label,
      value: r.word,
      state: r.state,
      detail: r.detail,
      record,
    });
    w.facts([
      { label: 'Checked', value: p.checkedAt ? instantText(p.checkedAt) : 'No completed check is held yet.' },
      reading('DMARC', p.dmarc, p.dmarc.record),
      reading('SPF', p.spf, p.spf.record),
      reading('DKIM', p.dkim),
      reading('MTA-STS', p.mtaSts),
      reading('TLS-RPT', p.tlsRpt, p.tlsRpt.record),
      reading('BIMI', p.bimi, p.bimi.record),
    ]);
  }
  if (e.domains.length > detailed.length) {
    w.note(`Records for the other ${count(e.domains.length - detailed.length, 'domain')} are summarised in the tables above and not quoted here.`);
  }
}

function sectionHistory(w: PackWriter, facts: PackFacts): void {
  const e = facts.evidence;
  w.section('4', 'DMARC policy history');
  w.paragraph(
    'Changes to each DMARC record seen between consecutive DNS checks, and the policy changes the client decided on. The first line for a domain is the earliest check still held, not necessarily the day monitoring began.',
  );
  w.table(
    [
      { label: 'Date', width: 74 },
      { label: 'Domain', width: 140 },
      { label: 'What changed', width: WIDTH - 214 },
    ],
    e.history.map((entry) => [{ text: shortDate(entry.at) }, domainCell(entry.domain), { text: entry.text }]),
    'No DMARC check or change is held for these domains yet.',
  );
  if (e.historyTotal > e.history.length) {
    w.note(`${count(e.historyTotal - e.history.length, 'earlier entry is', 'earlier entries are')} not listed. Each domain keeps its earliest check and its newest changes.`);
  }
}

function sectionCoverage(w: PackWriter, facts: PackFacts): void {
  const e = facts.evidence;
  w.section('5', 'Monitoring coverage');
  w.paragraph(
    `Receiving mail providers send aggregate (RUA) reports to the address a domain's DMARC record names. The window is the ${e.windowDays} days to ${longDate(facts.asOf)}. Days measured counts the distinct days, in UTC, on which a reported period began; a domain with reports every day reads ${e.windowDays} of ${e.windowDays}.`,
  );
  w.table(
    [
      { label: 'Domain', width: 128 },
      { label: 'Aggregate reports', width: 88 },
      { label: 'Last received', width: 72 },
      { label: 'Reports', width: 50, align: 'right' },
      { label: 'Days measured', width: 66, align: 'right' },
      { label: 'Reporters', width: WIDTH - 404, align: 'right' },
    ],
    e.domains.map((domain) => [
      domainCell(domain.name),
      reportingCell(domain),
      { text: shortDate(domain.coverage.lastReportAt), color: domain.coverage.lastReportAt ? C.ink : C.ink3 },
      numberCell(domain.coverage.reportsInWindow),
      numberCell(`${domain.coverage.daysMeasured} of ${e.windowDays}`),
      numberCell(domain.coverage.reporters),
    ]),
    'No domain to report.',
  );
  const tlsDomains = e.domains.filter((domain) => domain.coverage.tlsReportsInWindow > 0);
  const tlsReports = tlsDomains.reduce((sum, domain) => sum + domain.coverage.tlsReportsInWindow, 0);
  w.paragraph(
    tlsReports > 0
      ? `${count(tlsReports, 'TLS-RPT report')} arrived in the window for ${count(tlsDomains.length, 'domain')}.`
      : 'No TLS-RPT report arrived in the window.',
  );
  w.note('Receivers choose whether to send reports. Mail delivered to a provider that sends none is not counted anywhere in this document.');
}

function sectionSenders(w: PackWriter, facts: PackFacts): void {
  const e = facts.evidence;
  const sums = e.domains.reduce(
    (total, domain) => ({
      sources: total.sources + domain.senders.sources,
      approved: total.approved + domain.senders.approved,
      notOurs: total.notOurs + domain.senders.notOurs,
      unreviewed: total.unreviewed + domain.senders.unreviewed,
    }),
    { sources: 0, approved: 0, notOurs: 0, unreviewed: 0 },
  );
  w.section('6', 'Senders seen');
  w.paragraph(
    `A sending source is one identity in the reports: the domain the mail authenticated as, or the sending IP address where no domain was reported. Counts cover the same ${e.windowDays} days. Approved and not ours are decisions ${facts.publisher.workspaceName} recorded; failing means a source with at least 50 messages that failed DMARC on more than 5% of them, not counting sources marked not ours.`,
  );
  w.paragraph(senderLine(sums));
  w.table(
    [
      { label: 'Domain', width: 126 },
      { label: 'Sources', width: 44, align: 'right' },
      { label: 'Approved', width: 48, align: 'right' },
      { label: 'Not ours', width: 46, align: 'right' },
      { label: 'Unreviewed', width: 56, align: 'right' },
      { label: 'Failing', width: 40, align: 'right' },
      { label: 'Messages', width: 58, align: 'right' },
      { label: 'Passing DMARC', width: WIDTH - 418, align: 'right' },
    ],
    e.domains.map((domain) => {
      const s = domain.senders;
      return [
        domainCell(domain.name),
        numberCell(s.sources),
        numberCell(s.approved),
        numberCell(s.notOurs),
        numberCell(s.unreviewed),
        { text: figure(s.failing), color: s.failing > 0 ? C.red : C.ink },
        numberCell(s.messages),
        numberCell(shareText(s.dmarcPass, s.messages)),
      ];
    }),
    'No domain to report.',
  );
}

function sectionFindings(w: PackWriter, facts: PackFacts): void {
  const f = facts.evidence.findings;
  w.section('7', 'Open findings and what is being done');
  w.paragraph(
    `Everything on record as unresolved at the time of issue. An acknowledged alert has been taken on by ${facts.publisher.workspaceName}; an open one has not been acknowledged yet. A proposed policy change waits for the client's approval before it is made.`,
  );

  const nothing = f.alertCount === 0 && f.changeCount === 0 && f.checks.length === 0 && f.proposals.length === 0;
  if (nothing) {
    w.paragraph('No open findings were recorded at the time of issue: no unresolved alert, no unacknowledged DNS change, no error or warning from the newest checks, and no policy change awaiting approval.');
    return;
  }

  w.subheading('Alerts not yet resolved');
  w.table(
    [
      { label: 'Opened', width: 66 },
      { label: 'Domain', width: 126 },
      { label: 'Finding', width: WIDTH - 282 },
      { label: 'Status', width: 90 },
    ],
    f.alerts.map((alert) => [
      { text: shortDate(alert.openedAt) },
      domainCell(alert.domain),
      { text: alert.summary },
      alert.acknowledged ? { text: 'Acknowledged', state: 'warn' } : { text: 'Open', state: 'fail' },
    ]),
    'No alert is unresolved.',
  );
  if (f.alertCount > f.alerts.length) w.note(`${count(f.alertCount - f.alerts.length, 'older alert is', 'older alerts are')} unresolved and not listed.`);

  w.subheading('DNS changes not yet acknowledged');
  w.table(
    [
      { label: 'Detected', width: 66 },
      { label: 'Domain', width: 126 },
      { label: 'Change', width: WIDTH - 272 },
      { label: 'Severity', width: 80 },
    ],
    f.changes.map((change) => [
      { text: shortDate(change.detectedAt) },
      domainCell(change.domain),
      { text: change.summary },
      change.severity === 'critical' ? { text: 'Critical', state: 'fail' } : { text: 'Warning', state: 'warn' },
    ]),
    `No warning or critical change in the last ${facts.evidence.windowDays} days is waiting to be acknowledged.`,
  );
  if (f.changeCount > f.changes.length) w.note(`${count(f.changeCount - f.changes.length, 'more change is', 'more changes are')} unacknowledged and not listed.`);

  w.subheading('Raised by the newest DNS checks');
  w.table(
    [
      { label: 'Domain', width: 140 },
      { label: 'Severity', width: 80 },
      { label: 'Finding', width: WIDTH - 220 },
    ],
    f.checks.map((check) => [
      domainCell(check.domain),
      check.severity === 'error' ? { text: 'Error', state: 'fail' } : { text: 'Warning', state: 'warn' },
      { text: check.title },
    ]),
    'The newest checks raised no error or warning.',
  );

  w.subheading('Policy changes awaiting approval');
  w.table(
    [
      { label: 'Proposed', width: 70 },
      { label: 'Domain', width: 130 },
      { label: 'Change', width: WIDTH - 280 },
      { label: 'Open until', width: 80 },
    ],
    f.proposals.map((proposal) => [
      { text: shortDate(proposal.proposedAt) },
      domainCell(proposal.domain),
      { text: `From ${proposal.from} to ${proposal.to}` },
      { text: shortDate(proposal.expiresAt) },
    ]),
    'No policy change is waiting for the client.',
  );
}

function sectionMethod(w: PackWriter, facts: PackFacts): void {
  const e = facts.evidence;
  w.section('8', 'How this evidence was gathered');
  w.facts([
    {
      label: 'DNS checks',
      value: `Each domain's DMARC, SPF, DKIM, MX, MTA-STS, TLS-RPT and BIMI records are read from public DNS by the monitoring service, ${
        facts.monitor.scheduled
          ? `${intervalText(facts.monitor.intervalMinutes)} for every verified domain and whenever ${facts.publisher.workspaceName} runs a check`
          : `whenever ${facts.publisher.workspaceName} runs a check; scheduled checks are not running on this deployment`
      }. This document uses the newest completed check of each domain before the time of issue${
        e.checks.oldest && e.checks.newest
          ? `; those checks ran between ${longDate(e.checks.oldest)} and ${longDate(e.checks.newest)}`
          : ''
      }. A removal is confirmed by a second lookup before it is recorded.`,
    },
    {
      label: 'DKIM keys',
      value: 'DKIM keys are found by probing selector names known for common senders and the selectors already seen. A key published at a selector that was never probed is not seen.',
    },
    {
      label: 'Aggregate reports',
      value: `Daily XML reports from receiving mail providers, parsed and stored as they arrive. Sections 5 and 6 count reports whose period began between ${longDate(e.windowStart)} and ${longDate(facts.asOf)}${
        e.reports.inWindow > 0
          ? `: ${count(e.reports.inWindow, 'report')} from ${count(e.reports.reporters, 'reporting organisation')}`
          : ': none arrived'
      }.`,
    },
    {
      label: 'A pass',
      value: 'A message passes DMARC when its aligned DKIM or aligned SPF result passed, as the receiver evaluated it. Rates are counted from messages, never averaged across domains.',
    },
    {
      label: 'Change history',
      value: 'Each completed check is compared with the one before it, and every difference that matters is recorded with the date it was seen.',
    },
    { label: 'Time', value: 'All dates and times are UTC.' },
  ]);
}

function sectionDataHandling(w: PackWriter, facts: PackFacts): void {
  w.section('9', 'Data handling');

  w.subheading('What is held for this client');
  w.paragraph(
    'Only the categories below are collected. A category marked as containing personal data involves named individuals, and that data is held under a lawful basis the agency that manages it is responsible for.',
  );
  w.table(
    [
      { label: 'Category', width: 140 },
      { label: 'Description', width: WIDTH - 210 },
      { label: 'Personal data', width: 70 },
    ],
    facts.dataHeld.map((entry) => [
      { text: entry.category, face: 'medium' },
      { text: entry.description, color: C.ink2 },
      { text: entry.personal ? 'Yes' : 'No', face: entry.personal ? 'bold' : 'sans', color: entry.personal ? C.ink : C.ink3 },
    ]),
  );

  w.subheading('Who can read it');
  w.paragraph(
    "Access is checked on every request rather than only at sign in. No other client of the same agency, and no other organisation using this platform, can read this client's records. The boundary is enforced by the application and covered by an automated test suite that attempts cross tenant access and asserts every attempt is refused.",
  );
  w.paragraph(
    `${count(facts.portalContacts, 'portal contact')} currently ${verb(facts.portalContacts, 'has', 'have')} access. Portal contacts can see report volume, sending sources and spoofing warnings. They cannot see forensic data or named recipients, and that restriction is enforced on the response, not in the interface.`,
  );

  w.subheading('How long it is kept');
  w.facts(facts.retention.map((line) => ({ label: line.label, value: line.value })));
  w.note(
    'Each window above is applied automatically. A failed payment does not delete anything: a workspace whose subscription lapses moves to the free plan with every client, domain and report intact, and upgrading restores the previous plan.',
  );

  w.subheading('Who else touches this data', 70);
  w.table(
    [
      { label: 'Sub-processor', width: 104 },
      { label: 'Purpose', width: 150 },
      { label: 'Data', width: WIDTH - 334 },
      { label: 'Region', width: 80 },
    ],
    facts.subProcessors.map((entry) => [
      { text: entry.name, face: 'medium' },
      { text: entry.purpose, color: C.ink2 },
      { text: entry.data, color: C.ink2 },
      { text: entry.region, color: entry.region === 'Not confirmed yet' ? C.ink3 : C.ink },
    ]),
  );
  w.paragraph(facts.connectedServices);
  w.paragraph(facts.noTracking);
  w.facts([
    { label: 'Hosting region', value: facts.residency.region },
    { label: 'Hosting', value: facts.residency.hosting },
    { label: 'Law enforcement', value: facts.lawEnforcement },
  ]);
}

function sectionRights(w: PackWriter, facts: PackFacts): void {
  w.section('10', 'Your rights');
  w.facts([
    { label: 'Export', value: facts.rights.export },
    { label: 'Deletion', value: facts.rights.erasure },
  ]);
  if (facts.erasures.length > 0) {
    w.subheading('Completed deletions covering this client');
    w.table(
      [
        { label: 'Scope', width: 200 },
        { label: 'Completed', width: 120 },
        { label: 'Records removed', width: WIDTH - 320, align: 'right' },
      ],
      facts.erasures.map((entry) => [{ text: entry.scope }, { text: shortDate(entry.completedAt) }, numberCell(entry.records)]),
    );
  } else {
    w.paragraph('No deletion covering this client has been requested.', { color: C.ink3 });
  }
}

function sectionVerify(w: PackWriter, facts: PackFacts): void {
  w.section('11', 'How to verify this document');
  w.paragraph(
    'This statement is self attested. Verifying it proves the document has not been altered since it was issued. It does not attest that the provider is trustworthy, and it is not a third party audit or certification.',
  );
  w.facts([
    { label: 'Reference', value: facts.reference, mono: true },
    { label: 'Verify at', value: verifyUrl(facts), mono: true },
    { label: 'Document version', value: facts.documentVersion },
  ]);
  w.paragraph(
    `To verify: compute the SHA-256 digest of this file and compare it with the value published for this reference at the address above${
      facts.trustCenterPublished ? `, which is also listed on the Trust Center page for ${facts.client.name}` : ''
    }. If they match, the file you hold is byte for byte the one that was issued. If the file has been edited in any way, the digest will not match.`,
  );
  w.facts([
    { label: 'Windows', value: 'certutil -hashfile file.pdf SHA256', mono: true },
    { label: 'macOS', value: 'shasum -a 256 file.pdf', mono: true },
    { label: 'Linux', value: 'sha256sum file.pdf', mono: true },
  ]);
  w.note('The verify page can also hash the file in the browser, without uploading it.');
  w.paragraph(
    'The digest is deliberately not printed here. A file cannot contain its own digest, because writing it in changes the file and therefore changes the digest. It is published at the address above instead, so there is exactly one value and it cannot disagree with itself.',
  );
}

function sectionContact(w: PackWriter, facts: PackFacts): void {
  w.section('12', 'Contact');
  w.paragraph(
    `${facts.publisher.workspaceName} issued this document and manages these domains for ${facts.client.name}. Send questions to your usual contact there, quoting the reference in the foot of the page. This document does not carry a contact address.`,
  );
  w.note(`Document version ${facts.documentVersion}, data as of ${facts.asOf.toISOString().slice(0, 10)}.`);
}

/**
 * Renders the pack and returns the exact bytes.
 *
 * `fonts` exists for tests: passing no files exercises the fallback to the
 * standard faces that a missing asset would cause in production.
 */
export async function renderCompliancePack(
  facts: PackFacts,
  fonts?: PdfFontFiles,
): Promise<{ buffer: Buffer; pageCount: number; embeddedFonts: { sans: boolean; mono: boolean } }> {
  const author = facts.publisher.workspaceName;
  const creator = facts.publisher.branded ? author : PRODUCT;
  const doc = new PDFDocument({
    size: 'A4',
    // pdfkit's own bottom margin is zero: the layout decides every page break.
    margins: { top: PAGE.top, bottom: 0, left: PAGE.x, right: PAGE.x },
    // Needed to come back for the contents, the running heads and an exact page count.
    bufferPages: true,
    // Uncompressed so the text stays selectable and searchable. An auditor
    // copying a retention figure out of this document is a normal thing to do.
    compress: false,
    lang: 'en-GB',
    displayTitle: true,
    // Pinned, so the same facts give the same bytes and therefore the same hash.
    info: {
      Title: `${KIND} - ${facts.client.name}`,
      Author: author,
      Subject: 'DMARC posture, monitoring evidence and data handling',
      Keywords: facts.reference,
      Creator: creator,
      Producer: creator,
      CreationDate: facts.asOf,
      ModDate: facts.asOf,
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  const faces = applyPackFonts(doc, fonts);
  const w = new PackWriter(doc, faces);

  doc.outline.addItem('Cover');
  drawCover(w, facts);

  w.newPage();
  const contentsPage = w.pageIndex;
  doc.outline.addItem('Contents');

  w.newPage();
  sectionSummary(w, facts);
  sectionDomains(w, facts);
  sectionPosture(w, facts);
  sectionHistory(w, facts);
  sectionCoverage(w, facts);
  sectionSenders(w, facts);
  sectionFindings(w, facts);
  sectionMethod(w, facts);
  sectionDataHandling(w, facts);
  sectionRights(w, facts);
  sectionVerify(w, facts);
  sectionContact(w, facts);
  w.flushHeading(0);

  drawContents(w, facts, contentsPage);
  const pageCount = drawRunningHeads(w, facts);

  doc.flushPages();

  // pdfkit is a readable stream, so the bytes only exist once it has finished.
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.end();

  return { buffer: await finished, pageCount, embeddedFonts: faces.embedded };
}
