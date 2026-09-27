import { prisma } from '../database/prisma.js';
import { classifyNewSenderRisk, newSenderWindowDays, type NewSenderRisk } from './dmarc-rollout.service.js';

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
  failedMessages: number;
  failureSharePercent: number;
  hasEnoughSignal: boolean;
  status: 'clean' | 'degraded' | 'failing' | 'insufficient-data';
  firstSeenAt: string;
  lastSeenAt: string;
  isNew: boolean;
  newSenderRisk: NewSenderRisk | null;
  dkimPassMessages: number;
  spfPassMessages: number;
}

function isPass(value: string | null): boolean {
  return (value ?? '').trim().toLowerCase() === 'pass';
}

export function classifySender(totalMessages: number, failedMessages: number): SenderBreakdownRow['status'] {
  if (totalMessages < senderBreakdownThresholds.minimumMessagesForSignal) {
    return 'insufficient-data';
  }

  const share = (failedMessages / totalMessages) * 100;
  if (share === 0) {
    return 'clean';
  }

  return share > senderBreakdownThresholds.maximumFailureSharePercent ? 'failing' : 'degraded';
}

export async function buildSenderBreakdown(
  organizationId: string,
  domainId: string,
): Promise<SenderBreakdownRow[]> {
  const records = await prisma.dmarcReportRecord.findMany({
    where: { report: { domainId, domain: { client: { organizationId } } } },
    select: {
      sourceIp: true,
      messageCount: true,
      dkimResult: true,
      spfResult: true,
      senderKey: true,
      senderDomain: true,
      report: { select: { receivedAt: true } },
    },
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
      dkimPassMessages: number;
      spfPassMessages: number;
      firstSeenAt: Date;
      lastSeenAt: Date;
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
      dkimPassMessages: 0,
      spfPassMessages: 0,
      firstSeenAt: reportedAt,
      lastSeenAt: reportedAt,
    };

    const dkimPass = isPass(record.dkimResult);
    const spfPass = isPass(record.spfResult);
    const failed = !dkimPass || !spfPass;

    existing.sourceIps.add(record.sourceIp);
    existing.totalMessages += record.messageCount;
    if (dkimPass) {
      existing.dkimPassMessages += record.messageCount;
    }
    if (spfPass) {
      existing.spfPassMessages += record.messageCount;
    }
    if (failed) {
      existing.failedMessages += record.messageCount;
      existing.failingSourceIps.add(record.sourceIp);
    }
    if (reportedAt < existing.firstSeenAt) {
      existing.firstSeenAt = reportedAt;
    }
    if (reportedAt > existing.lastSeenAt) {
      existing.lastSeenAt = reportedAt;
    }

    senders.set(key, existing);
  }

  return [...senders.entries()]
    .map(([senderKey, entry]) => {
      const failureSharePercent =
        entry.totalMessages > 0 ? Math.round((entry.failedMessages / entry.totalMessages) * 100) * 100 : 0;
      const isNew = entry.firstSeenAt >= windowStart;

      return {
        senderKey,
        senderDomain: entry.senderDomain,
        sourceIps: [...entry.sourceIps].sort(),
        failingSourceIps: [...entry.failingSourceIps].sort(),
        totalMessages: entry.totalMessages,
        failedMessages: entry.failedMessages,
        failureSharePercent: Math.round(failureSharePercent) / 100,
        hasEnoughSignal: entry.totalMessages >= senderBreakdownThresholds.minimumMessagesForSignal,
        status: classifySender(entry.totalMessages, entry.failedMessages),
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
      };
    })
    .sort((left, right) => right.failedMessages - left.failedMessages || right.totalMessages - left.totalMessages)
    .slice(0, senderBreakdownThresholds.consideredSenders);
}

export function senderBlockers(rows: SenderBreakdownRow[]): string[] {
  return rows
    .filter((row) => row.status === 'failing')
    .map(
      (row) =>
        `Sending service ${row.senderDomain ?? row.senderKey} fails ${row.failureSharePercent}% of its ${row.totalMessages} messages` +
        `${row.failingSourceIps.length ? ` (seen from ${row.failingSourceIps.join(', ')})` : ''}. ` +
        'Fix its SPF or DKIM before enforcing, or confirm it is an attacker.',
    );
}

export function newSenderBlockers(rows: SenderBreakdownRow[]): string[] {
  return rows
    .filter((row) => row.isNew && row.newSenderRisk === 'partially-authenticated' && row.failedMessages > 0)
    .map(
      (row) =>
        `New sending service ${row.senderDomain ?? row.senderKey} authenticated only one of SPF or DKIM and failed ${row.failedMessages} of ${row.totalMessages} messages. ` +
        'It is probably legitimate but not fully configured. Fix it or allowlist it before enforcing, otherwise enforcement will reject real mail.',
    );
}

export interface SpoofingWarning {
  senderKey: string;
  senderDomain: string | null;
  totalMessages: number;
  failedMessages: number;
  sourceIps: string[];
  detail: string;
}

export function possibleSpoofingSources(rows: SenderBreakdownRow[]): SpoofingWarning[] {
  return rows
    .filter(
      (row) =>
        row.isNew &&
        row.newSenderRisk === 'unauthenticated' &&
        row.hasEnoughSignal &&
        row.failedMessages > 0,
    )
    .map((row) => ({
      senderKey: row.senderKey,
      senderDomain: row.senderDomain,
      totalMessages: row.totalMessages,
      failedMessages: row.failedMessages,
      sourceIps: row.failingSourceIps,
      detail:
        `New sending service ${row.senderDomain ?? row.senderKey} failed both SPF and DKIM on ${row.failedMessages} of ${row.totalMessages} messages. ` +
        'A legitimate service normally passes at least one of them, so this is either spoofing or a badly configured provider. Confirm with the domain owner, then enforce.',
    }));
}
