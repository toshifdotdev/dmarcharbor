import { prisma } from '../database/prisma.js';
import { sendAuthEmail } from '../email/email.service.js';
import { canCollectAggregateReports, hasAggregateReporting, readDmarcRecord } from '../scanner/dmarc-tags.js';
import { getDomainInsights } from './report-intelligence.service.js';
import { assessPolicyReadiness } from './onboarding.service.js';
import { domainRef } from './domain-ref.js';
import { resolveEntitlements } from './entitlements/entitlement.service.js';
import { resolveLimit } from '../utils/pagination.js';

const maximumRecipients = 20;

export type DigestFrequencyName = 'WEEKLY' | 'MONTHLY';

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function normalizeEmails(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].slice(0, maximumRecipients);
}

export async function createReportDigest(input: {
  organizationId: string;
  domainId: string;
  createdById: string | undefined;
  frequency: DigestFrequencyName;
  sendHourUtc: number;
  weekday: number;
  dayOfMonth: number;
  recipientEmails: string[];
  includeForensics: boolean;
}) {
      const domain = await prisma.domain.findFirst({
        where: { client: { organizationId: input.organizationId }, ...domainRef(input.domainId) },
        select: { id: true },

  });

  if (!domain) {
    return null;
  }

  const recipients = normalizeEmails(input.recipientEmails);
  if (recipients.length === 0) {
    return null;
  }

  return prisma.reportDigest.create({
    data: {
      organizationId: input.organizationId,
      domainId: domain.id,
      createdById: input.createdById ?? null,
      frequency: input.frequency,
      sendHourUtc: clamp(input.sendHourUtc, 0, 23),
      weekday: input.frequency === 'WEEKLY' ? clamp(input.weekday, 0, 6) : 1,
      dayOfMonth: input.frequency === 'MONTHLY' ? clamp(input.dayOfMonth, 1, 28) : 1,
      recipientEmails: recipients,
      includeForensics: input.includeForensics,
    },
  });
}

export async function listReportDigests(organizationId: string, options: { limit?: number; cursor?: string } = {}) {
  const limit = resolveLimit(options.limit);
  const rows = await prisma.reportDigest.findMany({
    where: { organizationId },
    include: {
      domain: { select: { id: true, name: true, client: { select: { id: true, name: true } } } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  return { rows, limit };
}

export async function updateReportDigest(
  organizationId: string,
  digestId: string,
  changes: {
    frequency?: DigestFrequencyName;
    sendHourUtc?: number;
    weekday?: number;
    dayOfMonth?: number;
    recipientEmails?: string[];
    includeForensics?: boolean;
    enabled?: boolean;
  },
) {
  const existing = await prisma.reportDigest.findFirst({
    where: { id: digestId, organizationId },
    select: { id: true, frequency: true },
  });

  if (!existing) {
    return null;
  }

  const frequency = changes.frequency ?? existing.frequency;

  return prisma.reportDigest.update({
    where: { id: existing.id },
    data: {
      frequency,
      sendHourUtc: changes.sendHourUtc === undefined ? undefined : clamp(changes.sendHourUtc, 0, 23),
      weekday: changes.weekday === undefined ? undefined : clamp(changes.weekday, 0, 6),
      dayOfMonth: changes.dayOfMonth === undefined ? undefined : clamp(changes.dayOfMonth, 1, 28),
      recipientEmails:
        changes.recipientEmails === undefined ? undefined : normalizeEmails(changes.recipientEmails),
      includeForensics: changes.includeForensics,
      enabled: changes.enabled,
    },
  });
}

export async function deleteReportDigest(organizationId: string, digestId: string): Promise<boolean> {
  const result = await prisma.reportDigest.deleteMany({ where: { id: digestId, organizationId } });
  return result.count > 0;
}

export interface DigestContent {
  subject: string;
  text: string;
  recipientCount: number;
}

export async function buildDigestContent(
  organizationId: string,
  domainId: string,
  includeForensics: boolean,
  organizationName: string,
): Promise<DigestContent | null> {
  const domain = await prisma.domain.findFirst({
    where: { client: { organizationId }, ...domainRef(domainId) },
    select: {
      id: true,
      name: true,
      score: true,
      dmarcPolicy: true,
      dmarcRecord: true,
      client: { select: { name: true } },
    },
  });

  if (!domain) {
    return null;
  }

  const insights = await getDomainInsights(organizationId, domainId);
  if (!insights) {
    return null;
  }

  const readiness = await assessPolicyReadiness(organizationId, domainId, insights);
  const tags = readDmarcRecord(domain.dmarcRecord);
  const lastReportAt = insights.aggregate.lastReportAt ?? insights.forensic.lastReportAt;

  const lines = [
    `Domain: ${domain.name}`,
    `Client: ${domain.client.name}`,
    `Policy: ${domain.dmarcPolicy ?? 'not published'}`,
    `Health score: ${domain.score ?? 'not scored yet'}`,
    '',
    `Messages observed: ${insights.aggregate.messageCount}`,
    `Failed DMARC: ${insights.aggregate.failedMessages}`,
    `DMARC pass rate: ${insights.aggregate.dmarcPassRate ?? 'unknown'}%`,
    `SPF pass rate: ${insights.aggregate.spfPassRate ?? 'unknown'}%`,
    `DKIM pass rate: ${insights.aggregate.dkimPassRate ?? 'unknown'}%`,
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
    lines.push(
      '',
      'Note: this domain publishes reports to a web endpoint rather than a mailbox.',
      'Reports are being sent, but DMARC Harbor does not read them from there yet,',
      'so the figures in this summary may be incomplete.',
    );
  }

  const subject = `[DMARC Harbor] ${domain.name} DMARC summary`;

  return {
    subject,
    text: [`Prepared by ${organizationName}.`, '', ...lines, '', 'Prepared by DMARC Harbor.'].join('\n'),
    recipientCount: 0,
  };
}

/**
 * `organizationId` is a required constraint, not a convenience.
 *
 * Taking only the digest id meant the service trusted its caller for tenancy: the
 * controller happened to check first, which closed the hole today while leaving
 * an unscoped read of another workspace's row one refactor away from being
 * reachable.
 */
export async function sendReportDigestNow(
  digestId: string,
  organizationId: string,
  now = new Date(),
): Promise<DigestContent | null> {
  const digest = await prisma.reportDigest.findFirst({
    where: { id: digestId, organizationId },
    include: {
      organization: { select: { id: true, name: true } },
      domain: { select: { id: true, name: true } },
    },
  });

  if (!digest) {
    return null;
  }

  return sendDigest(digest, now);
}

type DigestWithRelations = {
  id: string;
  organizationId: string;
  domainId: string;
  recipientEmails: string[];
  includeForensics: boolean;
  lastSentAt: Date | null;
  organization: { id: string; name: string };
  domain: { id: string; name: string };
};

async function sendDigest(digest: DigestWithRelations, now: Date): Promise<DigestContent | null> {
  const content = await buildDigestContent(
    digest.organizationId,
    digest.domainId,
    digest.includeForensics,
    digest.organization.name,
  );

  if (!content) {
    return null;
  }

  const recipients = digest.recipientEmails;
  let sent = 0;

  for (const to of recipients) {
    try {
      await sendAuthEmail({ to, subject: content.subject, text: content.text });
      sent += 1;
    } catch {
      continue;
    }
  }

  await prisma.reportDigest.update({
    where: { id: digest.id },
    data: { lastSentAt: now },
  });

  return { ...content, recipientCount: sent };
}

export interface DigestRunResult {
  digestId: string;
  sent: boolean;
  recipients: number;
}

function isDigestDue(
  digest: { frequency: string; sendHourUtc: number; weekday: number; dayOfMonth: number; lastSentAt: Date | null },
  now: Date,
): boolean {
  if (now.getUTCHours() < digest.sendHourUtc) {
    return false;
  }

  if (digest.lastSentAt && digest.lastSentAt.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) {
    return false;
  }

  if (digest.frequency === 'WEEKLY') {
    return now.getUTCDay() === digest.weekday;
  }

  return now.getUTCDate() === digest.dayOfMonth;
}

/**
 * The manual "run now" route on a workspace used to call this with no filter, so
 * any member with `report: update` in one workspace could evaluate and email
 * every tenant's digests. The scheduler still sweeps globally by passing nothing;
 * the route now passes its own organizationId, which confines the blast radius to
 * the workspace that asked.
 */
export async function runReportDigests(
  now = new Date(),
  organizationId?: string,
): Promise<DigestRunResult[]> {
  const digests = await prisma.reportDigest.findMany({
    where: { enabled: true, ...(organizationId ? { organizationId } : {}) },
    include: {
      organization: { select: { id: true, name: true } },
      domain: { select: { id: true, name: true } },
    },
    take: 500,
  });

  const results: DigestRunResult[] = [];
  // Read once per workspace per pass. A workspace whose plan cannot be read is
  // skipped this pass rather than sent to.
  const entitled = new Map<string, Promise<boolean>>();
  const hasDigests = (organizationId: string): Promise<boolean> => {
    let answer = entitled.get(organizationId);
    if (!answer) {
      answer = resolveEntitlements(organizationId).then(
        (entitlements) => entitlements.features.digests === true,
        () => false,
      );
      entitled.set(organizationId, answer);
    }
    return answer;
  };

  for (const digest of digests) {
    // The catalog's promise for a downgrade: the digest rows are kept and simply
    // stop being sent. Only creation used to be gated, so they kept going out.
    if (!(await hasDigests(digest.organizationId))) {
      results.push({ digestId: digest.id, sent: false, recipients: 0 });
      continue;
    }

    if (!isDigestDue(digest, now)) {
      results.push({ digestId: digest.id, sent: false, recipients: 0 });
      continue;
    }

    // Claimed by writing the send time before sending, keyed on the value that
    // was read. The check and the write are one statement, so when two
    // instances see the same due digest exactly one of them moves the row and
    // only that one sends. Writing lastSentAt after sending instead would let
    // every instance pass the check, and the customer would receive the same
    // weekly summary once per replica.
    const claimed = await prisma.reportDigest.updateMany({
      where: { id: digest.id, lastSentAt: digest.lastSentAt },
      data: { lastSentAt: now },
    });

    if (claimed.count !== 1) {
      results.push({ digestId: digest.id, sent: false, recipients: 0 });
      continue;
    }

    const content = await sendDigest(digest, now);

    if (!content) {
      // The claim is released so a failed send is retried on the next run
      // rather than being silently consumed by the claim itself.
      await prisma.reportDigest
        .updateMany({ where: { id: digest.id, lastSentAt: now }, data: { lastSentAt: digest.lastSentAt } })
        .catch(() => undefined);
    }

    results.push({ digestId: digest.id, sent: Boolean(content), recipients: content?.recipientCount ?? 0 });
  }

  return results;
}
