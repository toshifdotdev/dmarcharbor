import { oneLine } from '../email/sender.js';
import { clientContact, plainTextEmail, type RenderedEmail } from '../email/templates.js';
import { canCollectAggregateReports, hasAggregateReporting, type DmarcRecordTags } from '../scanner/dmarc-tags.js';
import type { PolicyReadiness } from './onboarding.service.js';
import type { DomainInsights, SourceAttribution } from './report-intelligence.service.js';

/**
 * The words of a domain summary digest, and its HTML.
 *
 * Pure: report-digest.service.ts reads the figures and sends, and everything it
 * says is built here from plain values. That keeps the wording testable and
 * lets the preview script (`scripts/render-emails.ts`) render a digest with no
 * database. The text is exactly what the service built before it moved.
 */

/** A pass rate as people read it: "97.5%", or "not measured yet" with no messages. */
function rate(value: number | null | undefined): string {
  return typeof value === 'number' ? `${value}%` : 'not measured yet';
}

/** The figures a digest reports, as the service reads them: only the fields it prints. */
export interface DigestFigures {
  domain: { name: string; score: number | null; dmarcPolicy: string | null; client: { name: string } };
  insights: {
    aggregate: Pick<
      DomainInsights['aggregate'],
      'messageCount' | 'failedMessages' | 'dmarcPassRate' | 'spfPassRate' | 'dkimPassRate' | 'reportCount' | 'lastReportAt'
    >;
    forensic: Pick<DomainInsights['forensic'], 'count' | 'rejectedMessages' | 'affectedRecipients' | 'lastReportAt'>;
    sources: Array<Pick<SourceAttribution, 'sourceIp' | 'failedMessages' | 'totalMessages' | 'risk'>>;
  };
  readiness: Pick<PolicyReadiness, 'ready' | 'level' | 'blockers'>;
  tags: DmarcRecordTags;
  includeForensics: boolean;
  /** `resolveBranding(...).branded`: the wording stops naming us when it is true. */
  branded: boolean;
}

/** The digest's lines between the envelope's opening and closing. */
export function digestLines(input: DigestFigures): string[] {
  const { domain, insights, readiness, tags, includeForensics, branded } = input;
  const lastReportAt = insights.aggregate.lastReportAt ?? insights.forensic.lastReportAt;

  const lines = [
    `Domain: ${domain.name}`,
    `Client: ${domain.client.name}`,
    `Policy: ${domain.dmarcPolicy ?? 'not published'}`,
    `Health score: ${domain.score ?? 'not scored yet'}`,
    '',
    `Messages observed: ${insights.aggregate.messageCount}`,
    `Failed DMARC: ${insights.aggregate.failedMessages}`,
    `DMARC pass rate: ${rate(insights.aggregate.dmarcPassRate)}`,
    `SPF pass rate: ${rate(insights.aggregate.spfPassRate)}`,
    `DKIM pass rate: ${rate(insights.aggregate.dkimPassRate)}`,
    `Aggregate reports received: ${insights.aggregate.reportCount}`,
    `Last report: ${lastReportAt ?? 'none yet'}`,
    '',
    `Recommendation: ${readiness.ready ? `safe to consider p=${readiness.level}` : 'stay on p=none'}`,
  ];

  if (!readiness.ready && readiness.blockers.length) {
    lines.push('Outstanding:', ...readiness.blockers.map((blocker) => `  - ${blocker}`));
  }

  if (insights.sources.length) {
    lines.push('', 'Top sources:');
    for (const source of insights.sources.slice(0, 5)) {
      lines.push(
        `  ${source.sourceIp}  ${source.failedMessages} failed DMARC / ${source.totalMessages} total  (${source.risk} risk)`,
      );
    }
  }

  if (includeForensics) {
    lines.push(
      '',
      'Forensic failures:',
      `  Reports: ${insights.forensic.count}`,
      `  Rejected or quarantined: ${insights.forensic.rejectedMessages}`,
      `  Distinct recipients affected: ${insights.forensic.affectedRecipients}`,
    );
  }

  // Two different situations that the previous single check called the same
  // thing. A rua=mailto: address is the normal case and needs no comment; a
  // rua=https: address means reports are published somewhere we cannot read, and
  // telling the customer "no rua= address" when one is plainly present is worse
  // than saying nothing.
  if (!hasAggregateReporting(tags)) {
    lines.push('', 'Warning: this domain has no rua= address, so reports cannot arrive.');
  } else if (!canCollectAggregateReports(tags)) {
    lines.push('', ...webEndpointNote(branded));
  }

  return lines;
}

/**
 * The note for a domain whose reports go to a web endpoint. A white-labelled
 * digest says "this service" rather than naming us, because the client reading
 * it knows only the agency.
 */
export function webEndpointNote(branded: boolean): string[] {
  return [
    'Note: this domain publishes reports to a web endpoint rather than a mailbox.',
    branded
      ? 'Reports are being sent, but this service does not read them from there yet,'
      : 'Reports are being sent, but DMARC Harbor does not read them from there yet,',
    'so the figures in this summary may be incomplete.',
  ];
}

/**
 * The subject and the text around the figures.
 *
 * Digests go to the client's contacts. With the agency's white label on, the
 * subject is tagged with the agency's name and the text says only that the
 * agency prepared it; without it, the wording names us as it always has.
 */
export function digestEnvelope(input: {
  domainName: string;
  organizationName: string;
  branded: boolean;
  lines: string[];
}): { subject: string; text: string } {
  const agency = oneLine(input.organizationName);
  if (input.branded) {
    return {
      subject: `[${agency}] ${input.domainName} DMARC summary`,
      text: [`Prepared by ${agency}.`, '', ...input.lines].join('\n'),
    };
  }
  return {
    subject: `[DMARC Harbor] ${input.domainName} DMARC summary`,
    text: [`Prepared by ${agency}.`, '', ...input.lines, '', 'Prepared by DMARC Harbor.'].join('\n'),
  };
}

/** The parts of the resolved branding a digest's HTML reads. */
export interface DigestBranding {
  branded: boolean;
  workspaceName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  supportEmail?: string | null;
  supportUrl?: string | null;
}

/**
 * A digest as email. The text is given whole, the contact line included when
 * the service added one. Under white label the HTML wears the agency's logo and
 * button colour and shows the contact line with its links; otherwise it is
 * ours, which is what the text says too.
 */
export function digestEmail(input: { subject: string; text: string; branding: DigestBranding | null }): RenderedEmail {
  const branded = Boolean(input.branding?.branded);
  return plainTextEmail({
    subject: input.subject,
    text: input.text,
    kind: 'Domain summary',
    brand:
      branded && input.branding
        ? {
            workspaceName: oneLine(input.branding.workspaceName),
            logoUrl: input.branding.logoUrl,
            primaryColor: input.branding.primaryColor,
            accentColor: input.branding.accentColor,
          }
        : null,
    whiteLabel: branded,
    contact: clientContact(input.branding),
  });
}
