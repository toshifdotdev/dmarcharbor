import { prisma } from '../database/prisma.js';
import { sendAuthEmail } from '../email/email.service.js';
import { clientEmailHeaders } from '../email/sender.js';
import { clientContact, contactSentence } from '../email/templates.js';
import { readDmarcRecord } from '../scanner/dmarc-tags.js';
import { digestEmail, digestEnvelope, digestLines } from './report-digest-text.js';
import { getDomainInsights } from './report-intelligence.service.js';
import { assessPolicyReadiness } from './onboarding.service.js';
import { resolveBranding } from './branding.service.js';
import { domainRef } from './domain-ref.js';
import { resolveEntitlements } from './entitlements/entitlement.service.js';
import { resolveLimit } from '../utils/pagination.js';

// The wording lives in report-digest-text.ts; these two are re-exported so
// their existing importers keep working.
export { digestEnvelope, webEndpointNote } from './report-digest-text.js';

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

/** `branded` is `resolveBranding(...).branded`: the wording stops naming us when it is true. */
export async function buildDigestContent(
  organizationId: string,
  domainId: string,
  includeForensics: boolean,
  organizationName: string,
  branded = false,
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
  const lines = digestLines({
    domain,
    insights,
    readiness,
    tags: readDmarcRecord(domain.dmarcRecord),
    includeForensics,
    branded,
  });

  return { ...digestEnvelope({ domainName: domain.name, organizationName, branded, lines }), recipientCount: 0 };
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
  // Read for the wording and the From line. A workspace whose branding cannot be
  // read is sent the unbranded digest rather than none.
  const brand = await resolveBranding(digest.organizationId).catch(() => null);
  const content = await buildDigestContent(
    digest.organizationId,
    digest.domainId,
    digest.includeForensics,
    digest.organization.name,
    brand?.branded ?? false,
  );

  if (!content) {
    return null;
  }

  const recipients = digest.recipientEmails;
  // From the agency's name, Reply-To its published support address, and the
  // same "Questions?" line the other client mail carries, when its white label
  // is on. The digest is written as text, so the line is appended to the text;
  // the HTML shows the same line with its links, and the agency's logo and
  // button colour, from the same branding.
  const headers = clientEmailHeaders(brand);
  const contactLine = contactSentence(clientContact(brand));
  const text = contactLine ? `${content.text}\n\n${contactLine}` : content.text;
  const { html } = digestEmail({ subject: content.subject, text, branding: brand });
  let sent = 0;

  for (const to of recipients) {
    try {
      await sendAuthEmail({ to, subject: content.subject, text, html, ...headers });
      sent += 1;
    } catch {
      continue;
    }
  }

  await prisma.reportDigest.update({
    where: { id: digest.id },
    data: { lastSentAt: now },
  });

  return { ...content, text, recipientCount: sent };
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
