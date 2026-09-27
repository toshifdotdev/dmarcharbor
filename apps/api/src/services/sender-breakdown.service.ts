import { prisma } from '../database/prisma.js';

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
    }
  >();

  for (const record of records) {
    const key = record.senderKey ?? `${record.sourceIp}|unknown`;
    const existing = senders.get(key) ?? {
      senderDomain: record.senderDomain,
      sourceIps: new Set<string>(),
      failingSourceIps: new Set<string>(),
      totalMessages: 0,
      failedMessages: 0,
    };

    const failed = !isPass(record.dkimResult) || !isPass(record.spfResult);
    existing.sourceIps.add(record.sourceIp);
    existing.totalMessages += record.messageCount;
    if (failed) {
      existing.failedMessages += record.messageCount;
      existing.failingSourceIps.add(record.sourceIp);
    }

    senders.set(key, existing);
  }

  return [...senders.entries()]
    .map(([senderKey, entry]) => {
      const failureSharePercent =
        entry.totalMessages > 0 ? Math.round((entry.failedMessages / entry.totalMessages) * 100) * 100 : 0;

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
