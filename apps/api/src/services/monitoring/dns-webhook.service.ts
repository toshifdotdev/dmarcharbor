import type { DnsChangeKind, DnsChangeSeverity, Prisma } from '@prisma/client';
import { emitEvent } from '../webhook.service.js';
import type { ScanResult } from '../../scanner/types.js';
import { policyDirection, policyTags } from './dns-diff.js';

export interface PersistedDnsChangeForEvent {
  id: string;
  kind: DnsChangeKind;
  severity: DnsChangeSeverity;
  code: string;
  summary: string;
}

/**
 * Emits the DNS monitoring webhooks after a scan has committed.
 *
 * A webhook failure is logged and swallowed: the scan is already stored, and a
 * customer's integration being down must never make their scan look failed.
 */
export async function emitDnsWebhooks(input: {
  organizationId: string;
  domainId: string;
  domainName: string;
  scanId: string;
  previousScanId: string | null;
  trigger: 'MANUAL' | 'SCHEDULED';
  changes: PersistedDnsChangeForEvent[];
  previous: ScanResult | null;
  current: ScanResult;
  now?: Date;
}): Promise<void> {
  if (input.changes.length === 0) {
    return;
  }

  try {
    await emitEvent(
      input.organizationId,
      'dns.changed',
      {
        domainId: input.domainId,
        domainName: input.domainName,
        scanId: input.scanId,
        previousScanId: input.previousScanId,
        trigger: input.trigger,
        changes: input.changes.map((change) => ({
          id: change.id,
          kind: change.kind,
          severity: change.severity,
          code: change.code,
          summary: change.summary,
        })),
      },
      input.now,
    );
  } catch (error) {
    console.error(
      `[dns-monitor] dns.changed webhook failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  if (!input.previous || !input.changes.some((change) => change.kind === 'DMARC_POLICY')) {
    return;
  }

  try {
    await emitEvent(
      input.organizationId,
      'policy.changed',
      {
        domainId: input.domainId,
        domainName: input.domainName,
        scanId: input.scanId,
        from: policyTags(input.previous),
        to: policyTags(input.current),
        direction: policyDirection(input.previous, input.current),
      },
      input.now,
    );
  } catch (error) {
    console.error(
      `[dns-monitor] policy.changed webhook failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

/** Converts a draft's JSON-safe values to the Prisma input type. */
export function changeJson(value: unknown): Prisma.InputJsonValue | undefined {
  return value === null || value === undefined ? undefined : (value as Prisma.InputJsonValue);
}
