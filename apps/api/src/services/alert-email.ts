import { plainTextEmail, type RenderedEmail } from '../email/templates.js';

/**
 * The words of an alert email and of the owners' rollup, and their HTML.
 *
 * Pure, and kept apart from alert.service.ts, which decides when an alert fires
 * and who hears about it. The text was built inline there, between database
 * reads, so the only way to see a rendered alert was to make one fire. Here it
 * can be rendered from plain values by the preview script
 * (`scripts/render-emails.ts`) and pinned by a unit test. The text is exactly
 * what alert.service.ts built before it moved; Slack and Teams post the same
 * body, so a change here changes three channels.
 */

export function escalationSubject(rule: { domain: { name: string }; name: string }, reminderLevel: number): string {
  if (reminderLevel <= 1) {
    return `[DMARC Harbor] ${rule.domain.name}: ${rule.name}`;
  }
  if (reminderLevel === 2) {
    return `[DMARC Harbor] Unacknowledged: ${rule.domain.name} ${rule.name}`;
  }
  return `[DMARC Harbor] URGENT unacknowledged: ${rule.domain.name} ${rule.name}`;
}

/**
 * Plain words for what a rule measures and how it compares, for a technician
 * reading the alert in a channel. Session 19 found posts reading
 * "(FAILURE_COUNT)", "GREATER_THAN 50" and "1440 minutes".
 */
const METRIC_WORDS: Record<string, string> = {
  FAILURE_COUNT: 'failing messages',
  FAILURE_RATE: 'failure rate',
  FORENSIC_FAILURES: 'failure reports',
  SOURCE_IP_VOLUME: 'mail from one source',
  NEW_UNAUTHENTICATED_SOURCE: 'new senders failing SPF and DKIM',
  REPORT_SILENCE: 'reports going quiet',
};
const OPERATOR_WORDS: Record<string, string> = {
  GREATER_THAN: 'more than',
  GREATER_THAN_OR_EQUAL: 'at least',
  LESS_THAN: 'less than',
  LESS_THAN_OR_EQUAL: 'at most',
};
const UNIT: Record<string, string> = { FAILURE_RATE: '%', REPORT_SILENCE: ' hours' };

/** 1440 as "24 hours", 90 as "90 minutes", 10080 as "7 days". */
export function durationWords(minutes: number): string {
  if (minutes % 1440 === 0 && minutes >= 2880) return `${minutes / 1440} days`;
  if (minutes % 60 === 0 && minutes >= 60) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function thresholdWords(metric: string, operator: string, threshold: number): string {
  const op = OPERATOR_WORDS[operator] ?? operator.toLowerCase().replace(/_/g, ' ');
  const unit = UNIT[metric] ?? (metric === 'FAILURE_COUNT' || metric === 'SOURCE_IP_VOLUME' ? ' messages' : '');
  return `${op} ${threshold.toLocaleString('en-GB')}${unit}`;
}

/** "Alert: Session 8 failing mail (failing messages)", without repeating a rule named for its metric. */
function alertLine(ruleName: string, metric: string): string {
  const words = METRIC_WORDS[metric] ?? metric.toLowerCase().replace(/_/g, ' ');
  return ruleName.trim().toLowerCase() === words ? `Alert: ${ruleName}` : `Alert: ${ruleName} (${words})`;
}

/** "This is the first notice", then "Reminder 1 of 2": the first notice is not a reminder. */
export function noticeLine(reminderLevel: number, maxReminderLevel: number): string {
  if (reminderLevel <= 1) return 'This is the first notice.';
  return `Reminder ${reminderLevel - 1} of ${Math.max(1, maxReminderLevel - 1)}`;
}

export function escalationNote(reminderLevel: number): string {
  if (reminderLevel <= 1) {
    return '';
  }
  if (reminderLevel === 2) {
    return 'Nobody has acknowledged this alert yet. If someone is already handling it, acknowledge it to stop further reminders.';
  }
  return 'This alert has been unacknowledged across multiple reminders. Escalate to whoever owns this domain.';
}

/** A new sender failing both SPF and DKIM, as the spoofing rule lists it. */
export interface SpoofingSourceLine {
  senderKey: string;
  senderDomain: string | null;
  serviceName: string | null;
  totalMessages: number;
  failedMessages: number;
  sourceIps: string[];
  firstSeenAt: string;
}

/** The body of one alert's email, and of its Slack and Teams posts. */
export function alertEmailBody(input: {
  organizationName: string;
  domainName: string;
  ruleName: string;
  metric: string;
  summary: string;
  operator: string;
  threshold: number;
  windowMinutes: number;
  reminderLevel: number;
  maxReminderLevel: number;
  /** The senders to check, for a new-unauthenticated-source rule; null for every other rule. */
  spoofingSources: SpoofingSourceLine[] | null;
}): string {
  const spoofingLines = input.spoofingSources
    ? [
        '',
        'Sending sources to check:',
        ...input.spoofingSources
          .slice(0, 10)
          .map(
            (source) =>
              `  ${source.serviceName ?? source.senderDomain ?? source.senderKey}: ${source.failedMessages} of ${source.totalMessages} messages failed both SPF and DKIM` +
              `${source.sourceIps.length ? `, from ${source.sourceIps.join(', ')}` : ''}, first seen ${source.firstSeenAt.slice(0, 10)}.`,
          ),
        input.spoofingSources.length > 10 ? `  ...and ${input.spoofingSources.length - 10} more` : '',
        '',
        'If the domain owner confirms this is not their service, move to p=reject to stop it.',
      ]
    : [];

  return [
    `Workspace: ${input.organizationName}`,
    `Domain: ${input.domainName}`,
    alertLine(input.ruleName, input.metric),
    input.summary,
    '',
    `Fires at: ${thresholdWords(input.metric, input.operator, input.threshold)}`,
    `Measured over: the last ${durationWords(input.windowMinutes)}`,
    ...spoofingLines,
    noticeLine(input.reminderLevel, input.maxReminderLevel),
    escalationNote(input.reminderLevel),
    '',
    'Review and acknowledge this alert in DMARC Harbor.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function rollupEmailSubject(count: number): string {
  return `[DMARC Harbor] ${count} unacknowledged alert${count === 1 ? '' : 's'}`;
}

/**
 * The owners' rollup of alerts nobody acknowledged. The first twenty are set
 * out in padded columns, which line up only in a fixed-width face; the HTML
 * keeps them in mono for that reason.
 */
export function rollupEmailBody(input: {
  organizationName: string;
  outstanding: Array<{ domainName: string; ruleName: string; summary: string }>;
}): string {
  const { outstanding } = input;
  const lines = outstanding
    .slice(0, 20)
    .map((event) => `  ${event.domainName.padEnd(30)} ${event.ruleName.padEnd(28)} ${event.summary}`);

  return [
    `Workspace: ${input.organizationName}`,
    '',
    `${outstanding.length} alert${outstanding.length === 1 ? '' : 's'} remain unacknowledged after their reminder sequence finished.`,
    '',
    ...lines,
    outstanding.length > 20 ? `  ...and ${outstanding.length - 20} more` : '',
    '',
    'These alerts have already been sent to the people who own each rule.',
    'Review them in DMARC Harbor and acknowledge, adjust, or disable the rule.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * An alert or rollup as email: the body as the text part, exactly, and the
 * same words in our layout with a way to the alerts page. Staff mail, so it is
 * always our brand.
 */
export function alertEmail(input: { subject: string; body: string; kind: 'ALERT' | 'ROLLUP'; appUrl: string }): RenderedEmail {
  return plainTextEmail({
    subject: input.subject,
    text: input.body,
    kind: 'Alerts',
    action: {
      label: input.kind === 'ROLLUP' ? 'Review the alerts' : 'Review the alert',
      url: `${input.appUrl.replace(/\/+$/, '')}/alerts`,
    },
  });
}
