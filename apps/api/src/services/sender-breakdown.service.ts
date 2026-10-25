import { prisma } from '../database/prisma.js';
import { classifyNewSenderRisk, newSenderWindowDays, type NewSenderRisk } from './dmarc-rollout.service.js';
import {
  attributeSender,
  type AuthSignal,
  type CachedIntel,
  type SenderConfidence,
  type SenderNetwork,
  type SenderService,
} from './senders/attribution.js';
import { normaliseIpAddress } from './senders/ip-intel.service.js';

export const senderBreakdownThresholds = {
  minimumMessagesForSignal: 50,
  maximumFailureSharePercent: 5,
  consideredSenders: 25,
} as const;

export interface SenderBreakdownRow {
  senderKey: string;
  senderDomain: string | null;
  sourceIps: string[];
  failingSourceIps: string[];
  totalMessages: number;
  /**
   * Messages that did not pass both aligned checks. This is the legacy
   * "failure" figure used by the source breakdown and the Senders table's
   * secondary line; DMARC itself passes when either check passed.
   */
  failedMessages: number;
  failureSharePercent: number;
  /** Messages that failed both aligned checks, which is a DMARC failure. */
  dmarcFailedMessages: number;
  dmarcFailureSharePercent: number;
  hasEnoughSignal: boolean;
  status: 'clean' | 'degraded' | 'failing' | 'insufficient-data';
  firstSeenAt: string;
  lastSeenAt: string;
  isNew: boolean;
  newSenderRisk: NewSenderRisk | null;
  dkimPassMessages: number;
  spfPassMessages: number;
  service: SenderService | null;
  confidence: SenderConfidence;
  network: SenderNetwork | null;
  evidence: string[];
  intelPending: boolean;
  review: {
    status: 'APPROVED' | 'NOT_OURS' | 'UNREVIEWED';
    note: string | null;
    reviewedAt: string | null;
    reviewedBy: { id: string; name: string } | null;
  };
  owner: { id: string; name: string } | null;
}

function isPass(value: string | null): boolean {
  return (value ?? '').trim().toLowerCase() === 'pass';
}

export function classifySender(totalMessages: number, dmarcFailedMessages: number): SenderBreakdownRow['status'] {
  if (totalMessages < senderBreakdownThresholds.minimumMessagesForSignal) {
    return 'insufficient-data';
  }

  const share = (dmarcFailedMessages / totalMessages) * 100;
  if (share === 0) {
    return 'clean';
  }

  return share > senderBreakdownThresholds.maximumFailureSharePercent ? 'failing' : 'degraded';
}

export async function buildSenderBreakdown(
  organizationId: string,
  domainId: string,
): Promise<SenderBreakdownRow[]> {
  const domain = await prisma.domain.findFirst({
    where: { id: domainId, client: { organizationId } },
    select: { name: true },
  });
  if (!domain) {
    return [];
  }

  const records = await prisma.dmarcReportRecord.findMany({
    where: { report: { domainId, domain: { client: { organizationId } } } },
    select: {
      sourceIp: true,
      messageCount: true,
      dkimResult: true,
      spfResult: true,
      senderKey: true,
      senderDomain: true,
      authResults: { select: { type: true, domain: true, result: true } },
      report: { select: { receivedAt: true } },
    },
    // Beyond 50,000 records the subset must be the newest evidence, not an
    // arbitrary slice. The aggregate count is bounded; the order makes what it
    // leaves out predictable.
    orderBy: { report: { receivedAt: 'desc' } },
    take: 50_000,
  });

  const senders = new Map<
    string,
    {
      senderDomain: string | null;
      sourceIps: Set<string>;
      failingSourceIps: Set<string>;
      totalMessages: number;
      failedMessages: number;
      dmarcFailedMessages: number;
      dkimPassMessages: number;
      spfPassMessages: number;
      firstSeenAt: Date;
      lastSeenAt: Date;
      signals: Map<string, AuthSignal>;
      ipMessages: Map<string, number>;
    }
  >();

  const windowStart = new Date(Date.now() - newSenderWindowDays * 24 * 60 * 60 * 1000);

  for (const record of records) {
    const key = record.senderKey ?? `${record.sourceIp}|unknown`;
    const reportedAt = record.report.receivedAt;
    const existing = senders.get(key) ?? {
      senderDomain: record.senderDomain,
      sourceIps: new Set<string>(),
      failingSourceIps: new Set<string>(),
      totalMessages: 0,
      failedMessages: 0,
      dmarcFailedMessages: 0,
      dkimPassMessages: 0,
      spfPassMessages: 0,
      firstSeenAt: reportedAt,
      lastSeenAt: reportedAt,
      signals: new Map(),
      ipMessages: new Map(),
    };

    const dkimPass = isPass(record.dkimResult);
    const spfPass = isPass(record.spfResult);
    const failed = !dkimPass || !spfPass;
    const dmarcFailed = !dkimPass && !spfPass;

    const sourceIp = normaliseIpAddress(record.sourceIp) ?? record.sourceIp.trim().toLowerCase();
    existing.sourceIps.add(sourceIp);
    existing.ipMessages.set(sourceIp, (existing.ipMessages.get(sourceIp) ?? 0) + record.messageCount);
    existing.totalMessages += record.messageCount;

    for (const auth of record.authResults) {
      const key = `${auth.type}|${auth.domain ?? ''}|${auth.result}`;
      const signal = existing.signals.get(key) ?? {
        type: auth.type,
        domain: auth.domain,
        result: auth.result,
        messageCount: 0,
      };
      signal.messageCount += record.messageCount;
      existing.signals.set(key, signal);
    }
    if (dkimPass) {
      existing.dkimPassMessages += record.messageCount;
    }
    if (spfPass) {
      existing.spfPassMessages += record.messageCount;
    }
    if (failed) {
      existing.failedMessages += record.messageCount;
    }
    if (dmarcFailed) {
      existing.dmarcFailedMessages += record.messageCount;
      existing.failingSourceIps.add(sourceIp);
    }
    if (reportedAt < existing.firstSeenAt) {
      existing.firstSeenAt = reportedAt;
    }
    if (reportedAt > existing.lastSeenAt) {
      existing.lastSeenAt = reportedAt;
    }

    senders.set(key, existing);
  }

  const allIps = [...new Set([...senders.values()].flatMap((entry) => [...entry.sourceIps]))];
  const intelRows = allIps.length
    ? await prisma.sourceIpIntel.findMany({
        where: { ip: { in: allIps } },
        select: { ip: true, ptr: true, ptrConfirmed: true, asn: true, asnName: true },
      })
    : [];
  const intel = new Map<string, CachedIntel>(
    intelRows.map((row) => [
      row.ip,
      { ip: row.ip, ptr: row.ptr, ptrConfirmed: row.ptrConfirmed, asn: row.asn, asnName: row.asnName },
    ]),
  );

  const reviewRows = await prisma.senderReview.findMany({
    where: { organizationId, domainId },
    select: {
      senderKey: true,
      status: true,
      note: true,
      reviewedAt: true,
      reviewedBy: { select: { id: true, name: true } },
      ownerUser: { select: { id: true, name: true } },
    },
  });
  const reviews = new Map(reviewRows.map((row) => [row.senderKey, row]));

  return [...senders.entries()]
    .map(([senderKey, entry]) => {
      const failureSharePercent =
        entry.totalMessages > 0 ? Math.round((entry.failedMessages / entry.totalMessages) * 100) * 100 : 0;
      const dmarcFailureSharePercent =
        entry.totalMessages > 0 ? Math.round((entry.dmarcFailedMessages / entry.totalMessages) * 100) * 100 : 0;
      const isNew = entry.firstSeenAt >= windowStart;
      const intelPending = [...entry.sourceIps].some((ip) => !intel.has(ip));
      const attributed = attributeSender({
        reportedDomain: domain.name,
        signals: [...entry.signals.values()],
        ipMessages: entry.ipMessages,
        intel,
        intelPending,
      });
      const review = reviews.get(senderKey);

      return {
        senderKey,
        senderDomain: entry.senderDomain,
        sourceIps: [...entry.sourceIps].sort(),
        failingSourceIps: [...entry.failingSourceIps].sort(),
        totalMessages: entry.totalMessages,
        failedMessages: entry.failedMessages,
        failureSharePercent: Math.round(failureSharePercent) / 100,
        dmarcFailedMessages: entry.dmarcFailedMessages,
        dmarcFailureSharePercent: Math.round(dmarcFailureSharePercent) / 100,
        hasEnoughSignal: entry.totalMessages >= senderBreakdownThresholds.minimumMessagesForSignal,
        status: classifySender(entry.totalMessages, entry.dmarcFailedMessages),
        firstSeenAt: entry.firstSeenAt.toISOString(),
        lastSeenAt: entry.lastSeenAt.toISOString(),
        isNew,
        newSenderRisk: isNew
          ? classifyNewSenderRisk(
              entry.dkimPassMessages > 0,
              entry.spfPassMessages > 0,
            )
          : null,
        dkimPassMessages: entry.dkimPassMessages,
        spfPassMessages: entry.spfPassMessages,
        service: attributed.service,
        confidence: attributed.confidence,
        network: attributed.network,
        evidence: attributed.evidence,
        intelPending: attributed.intelPending,
        review: {
          status: (review?.status ?? 'UNREVIEWED') as SenderBreakdownRow['review']['status'],
          note: review?.note ?? null,
          reviewedAt: review?.reviewedAt?.toISOString() ?? null,
          reviewedBy: review?.reviewedBy ?? null,
        },
        owner: review?.ownerUser ?? null,
      };
    })
    .sort(
      (left, right) =>
        right.dmarcFailedMessages - left.dmarcFailedMessages ||
        right.failedMessages - left.failedMessages ||
        right.totalMessages - left.totalMessages,
    )
    .slice(0, senderBreakdownThresholds.consideredSenders);
}

/** The service name when a signal supports it, otherwise the existing domain/key. */
export function senderLabel(
  row: Pick<SenderBreakdownRow, 'service' | 'confidence' | 'senderDomain' | 'senderKey'>,
): string {
  if (row.service && (row.confidence === 'confirmed' || row.confidence === 'likely')) {
    return row.service.name;
  }
  return row.senderDomain ?? row.senderKey;
}

export function senderBlockers(rows: SenderBreakdownRow[]): string[] {
  return rows
    .filter((row) => row.status === 'failing' && row.review.status !== 'NOT_OURS')
    .map((row) => {
      if (row.review.status === 'APPROVED') {
        return `Approved sender ${senderLabel(row)} fails DMARC on ${row.dmarcFailureSharePercent}% of its messages. Fix its SPF or DKIM before enforcing, or reject will block its real mail.`;
      }
      return (
        `Sending service ${senderLabel(row)} fails DMARC on ${row.dmarcFailureSharePercent}% of its ${row.totalMessages} messages` +
        `${row.failingSourceIps.length ? ` (seen from ${row.failingSourceIps.join(', ')})` : ''}. ` +
        'Fix its SPF or DKIM before enforcing, or confirm it is an attacker.'
      );
    });
}

export function newSenderBlockers(rows: SenderBreakdownRow[]): string[] {
  return rows
    .filter(
      (row) =>
        row.review.status !== 'APPROVED' &&
        row.review.status !== 'NOT_OURS' &&
        row.isNew &&
        row.newSenderRisk === 'partially-authenticated' &&
        row.failedMessages > 0,
    )
    .map(
      (row) =>
        `New sending service ${senderLabel(row)} authenticated only one of SPF or DKIM and failed ${row.failedMessages} of ${row.totalMessages} messages. ` +
        'It is probably legitimate but not fully configured. Fix it or allowlist it before enforcing, otherwise enforcement will reject real mail.',
    );
}

export interface SpoofingWarning {
  senderKey: string;
  senderDomain: string | null;
  serviceName: string | null;
  totalMessages: number;
  failedMessages: number;
  sourceIps: string[];
  detail: string;
}

export function possibleSpoofingSources(rows: SenderBreakdownRow[]): SpoofingWarning[] {
  return rows
    .filter((row) => {
      if (row.review.status === 'APPROVED') {
        return false;
      }
      if (row.dmarcFailedMessages <= 0) {
        return false;
      }
      if (row.review.status === 'NOT_OURS') {
        return true;
      }
      return (
        row.isNew &&
        row.newSenderRisk === 'unauthenticated' &&
        row.hasEnoughSignal
      );
    })
    .map((row) => {
      const label = senderLabel(row);
      return {
        senderKey: row.senderKey,
        senderDomain: row.senderDomain,
        serviceName:
          row.service && (row.confidence === 'confirmed' || row.confidence === 'likely')
            ? row.service.name
            : null,
        totalMessages: row.totalMessages,
        failedMessages: row.dmarcFailedMessages,
        sourceIps: row.failingSourceIps,
        detail:
          row.review.status === 'NOT_OURS'
            ? `${label} is marked not ours and failed DMARC on ${row.dmarcFailedMessages} of ${row.totalMessages} messages. Confirm with the domain owner, then enforce.`
            : `New sending service ${label} failed both SPF and DKIM on ${row.dmarcFailedMessages} of ${row.totalMessages} messages. ` +
              'A legitimate service normally passes at least one of them, so this is either spoofing or a badly configured provider. Confirm with the domain owner, then enforce.',
      };
    });
}
