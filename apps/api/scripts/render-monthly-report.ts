/**
 * Renders a sample monthly report from invented facts, with no database, so the
 * layout can be looked at without issuing one.
 *
 *   npx tsx scripts/render-monthly-report.ts [out.pdf] [--branded]
 *
 * Writes to the system temp directory when no path is given. The client, the
 * agency and every domain are invented, and the domains use .example.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { previousCompleteMonth } from '../src/services/reports/monthly-period.js';
import {
  renderMonthlyReportPdf,
  type MonthlyFacts,
  type MonthlyReportBranding,
} from '../src/services/reports/monthly-report-pdf.js';

const args = process.argv.slice(2);
const branded = args.includes('--branded');
const out = args.find((arg) => !arg.startsWith('--')) ?? path.join(tmpdir(), 'monthly-report-sample.pdf');

const domain = (
  name: string,
  policy: string,
  messages: number,
  dmarcPass: number,
  spfPass: number,
  dkimPass: number,
  reports: number,
  organisations: number,
) => ({ name, policy, messages, dmarcPass, spfPass, dkimPass, reports, organisations });

const domains = [
  domain('pellowyn-bookings.example', 'none', 2_410, 2_102, 2_250, 1_988, 31, 4),
  domain('pellowyn-dental.example', 'reject', 18_420, 18_011, 17_920, 18_102, 62, 6),
  domain('pellowyn-mail.example', 'quarantine', 5_128, 4_996, 5_010, 4_870, 30, 3),
  domain('pellowyn-old.example', 'no record', 0, 0, 0, 0, 0, 0),
  domain('pellowyn-staff.example', 'not known', 0, 0, 0, 0, 0, 0),
  domain('pellowyn.example', 'testing', 640, 512, 600, 498, 12, 2),
];

const sum = (key: 'messages' | 'dmarcPass' | 'spfPass' | 'dkimPass' | 'reports') =>
  domains.reduce((total, row) => total + row[key], 0);

const facts: MonthlyFacts = {
  clientName: 'Pellowyn Dental',
  agencyName: 'Wistholm IT',
  period: previousCompleteMonth(new Date('2026-11-05T12:00:00Z')),
  reference: 'RPT-202610-PELLOWYN-DENTAL-0123456789ABCDEF01234567',
  issuedAt: new Date('2026-11-05T12:00:00.000Z'),
  domains,
  domainCount: domains.length,
  totalReports: sum('reports'),
  messages: sum('messages'),
  dmarcPass: sum('dmarcPass'),
  spfPass: sum('spfPass'),
  dkimPass: sum('dkimPass'),
  policyDistribution: { none: 1, quarantine: 1, reject: 1, testing: 1, 'no record': 1, 'not known': 1 },
  policyMoved: 1,
  domainsWithoutReports: 2,
  changes: [
    {
      domainName: 'pellowyn-dental.example',
      summary: 'The DMARC policy strengthened from p=quarantine to p=reject.',
      detectedAt: new Date('2026-10-08T06:00:00Z'),
    },
    {
      domainName: 'pellowyn-mail.example',
      summary: 'The SPF record now includes _spf.hubspot.example, which adds 2 DNS lookups (8 of 10).',
      detectedAt: new Date('2026-10-21T06:00:00Z'),
    },
  ],
  changeCount: 2,
  sources: [
    { sourceIp: '198.51.100.7', senderDomain: 'pellowyn-bookings.example', failedMessages: 284, totalMessages: 2_410, service: 'HubSpot' },
    { sourceIp: '203.0.113.24', senderDomain: null, failedMessages: 128, totalMessages: 128, service: null },
    { sourceIp: '2001:db8:4f2a::1c', senderDomain: 'pellowyn.example', failedMessages: 96, totalMessages: 640, service: 'Xero' },
  ],
  forensicCount: 3,
  alertsOpened: 2,
  alertsResolved: 1,
};

const branding: MonthlyReportBranding = branded
  ? { branded: true, workspaceName: 'Wistholm IT', primaryColor: '#0f766e', logo: null, verifyBase: 'https://reports.wistholm.example' }
  : { branded: false, workspaceName: 'Wistholm IT', primaryColor: null, logo: null, verifyBase: 'https://app.dmarcharbor.example' };

const rendered = await renderMonthlyReportPdf(facts, branding);
writeFileSync(out, rendered.buffer);
console.log(
  `${out}: ${rendered.pageCount} page${rendered.pageCount === 1 ? '' : 's'}, ${rendered.buffer.length.toLocaleString('en-GB')} bytes, ` +
    `faces ${rendered.embeddedFonts.sans && rendered.embeddedFonts.mono ? 'embedded' : 'fell back to the standard faces'}`,
);
