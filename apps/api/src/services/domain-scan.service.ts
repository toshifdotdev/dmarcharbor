import { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { domainRef } from './domain-ref.js';
import { applySwitchRecord } from './switch-kit/switch.service.js';
import { switchObservationFromScan } from './switch-kit/state.js';
import { scanDomain } from '../scanner/scanner.js';
import { systemDnsReader } from '../scanner/dns.js';
import type { HttpsGetter } from '../scanner/https-get.js';
import type { DnsReader, ScanResult } from '../scanner/types.js';
import { confirmDnsRemovals } from './monitoring/dns-removal-confirmation.js';
import { changeJson, emitDnsWebhooks } from './monitoring/dns-webhook.service.js';
import { diffScans } from './monitoring/dns-diff.js';
import { checkDelegation } from './hosted-dns/hosted-dmarc.service.js';
import { checkSpfDelegation } from './hosted-dns/managed-spf.service.js';
import { checkBimiDelegation } from './hosted-dns/hosted-bimi.service.js';
import { checkMtaStsDelegation } from './hosted-dns/hosted-mta-sts.service.js';

const scanInclude = {
  domain: {
    select: {
      id: true,
      name: true,
      status: true,
      client: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  },
  requestedBy: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
} as const;

type PersistedScan = Prisma.ScanGetPayload<{ include: typeof scanInclude }>;

type RunDomainScanInput = {
  organizationId: string;
  domainId: string;
  requestedById: string | null;
  trigger?: 'MANUAL' | 'SCHEDULED';
  reader?: DnsReader;
  https?: HttpsGetter;
};

export type RunDomainScanOutcome =
  | { status: 'not_found' }
  | { status: 'not_verified' }
  | { status: 'completed'; scan: PersistedScan; changes: number }
  | { status: 'failed'; scan: PersistedScan; error: string };

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The scan failed unexpectedly.';
}

function knownSelectorsFrom(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

const inconsistentRemovalMessage = 'DNS answered inconsistently; the next scheduled check will try again';

export async function runDomainScan(input: RunDomainScanInput): Promise<RunDomainScanOutcome> {
  const trigger = input.trigger ?? 'MANUAL';
  const reader = input.reader ?? systemDnsReader;

  const domain = await prisma.domain.findFirst({
    where: {
      client: { organizationId: input.organizationId },
      ...domainRef(input.domainId),
    },
    select: {
      id: true,
      name: true,
      status: true,
      dkimSelectors: true,
      client: { select: { organizationId: true } },
    },
  });

  if (!domain) {
    return { status: 'not_found' };
  }

  if (domain.status !== 'VERIFIED') {
    return { status: 'not_verified' };
  }

  const scan = await prisma.scan.create({
    data: {
      domainId: domain.id,
      requestedById: input.requestedById,
      trigger,
      status: 'RUNNING',
    },
  });

  try {
    const result = await scanDomain(domain.name, reader, {
      knownSelectors: knownSelectorsFrom(domain.dkimSelectors),
      ...(input.https ? { https: input.https } : {}),
    });

    /**
     * A scan that could not reach DNS is not a scan that found nothing.
     *
     * Stored as FAILED, with the reason preserved, and the domain row left
     * exactly as the previous scan left it. `missing` and `needs_attention`
     * are findings, not failures: a domain with no DMARC record is exactly what
     * a scan exists to report.
     */
    if (result.status === 'error') {
      const reason =
        (result.issues.length > 0 && result.issues[0].message) ||
        'The lookups did not return an answer.';

      const failedScan = await prisma.scan.update({
        where: { id: scan.id },
        data: {
          status: 'FAILED',
          error: reason,
          result: toJson(result),
          completedAt: new Date(result.scannedAt),
        },
        include: scanInclude,
      });

      return { status: 'failed', scan: failedScan, error: reason };
    }

    const completedAt = new Date(result.scannedAt);

    /**
     * Confirm critical removals before anything is written.
     *
     * DNS answers inconsistently, so one "missing" is not proof. This reads the
     * affected name again after a pause. A reappearing record fails the scan
     * rather than telling the customer their DMARC or SPF record was removed
     * when it was not.
     */
    const previousForConfirmation = await prisma.scan.findFirst({
      where: {
        domainId: domain.id,
        status: 'COMPLETED',
        id: { not: scan.id },
      },
      orderBy: [{ completedAt: 'desc' }, { startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, result: true },
    });

    const previousResultForConfirmation = previousForConfirmation?.result
      ? (previousForConfirmation.result as unknown as ScanResult)
      : null;

    if (previousResultForConfirmation) {
      const confirmation = await confirmDnsRemovals({
        domainName: domain.name,
        previous: previousResultForConfirmation,
        current: result,
        reader,
      });

      if (!confirmation.confirmed) {
        const failedScan = await prisma.scan.update({
          where: { id: scan.id },
          data: {
            status: 'FAILED',
            error: inconsistentRemovalMessage,
            result: toJson(result),
            completedAt,
          },
          include: scanInclude,
        });

        return { status: 'failed', scan: failedScan, error: inconsistentRemovalMessage };
      }
    }

    const persisted = await prisma.$transaction(async (transaction) => {
      // Serialises concurrent scans of one domain, so two of them cannot both
      // read the same previous scan and record the same change.
      await transaction.$queryRaw`SELECT id FROM "domain" WHERE id = ${domain.id} FOR UPDATE`;

      const previous = await transaction.scan.findFirst({
        where: {
          domainId: domain.id,
          status: 'COMPLETED',
          id: { not: scan.id },
        },
        orderBy: [{ completedAt: 'desc' }, { startedAt: 'desc' }, { id: 'desc' }],
        select: { id: true, result: true },
      });

      const previousResult = previous?.result ? (previous.result as unknown as ScanResult) : null;
      const drafts = previousResult ? diffScans(previousResult, result) : [];

      const changes = drafts.length
        ? await transaction.dnsChange.createManyAndReturn({
            data: drafts.map((draft) => ({
              organizationId: domain.client.organizationId,
              domainId: domain.id,
              scanId: scan.id,
              previousScanId: previous?.id ?? null,
              kind: draft.kind,
              severity: draft.severity,
              code: draft.code,
              summary: draft.summary,
              before: changeJson(draft.before),
              after: changeJson(draft.after),
              detectedAt: completedAt,
            })),
            select: { id: true, kind: true, severity: true, code: true, summary: true },
          })
        : [];

      await transaction.scan.update({
        where: { id: scan.id },
        data: {
          status: 'COMPLETED',
          score: result.score,
          result: toJson(result),
          completedAt,
        },
      });

      await transaction.domain.update({
        where: { id: domain.id },
        data: {
          lastScanAt: completedAt,
          score: result.score,
          dmarcPolicy: result.dmarc.policy,
          dmarcRecord: result.dmarc.record ?? null,
          spfRecord: result.spf.record ?? null,
          dkimSelectors: toJson(result.dkim.selectors),
          mxRecords: toJson(result.mx.records),
        },
      });

      const scanRow = await transaction.scan.findUnique({
        where: { id: scan.id },
        include: scanInclude,
      });

      return {
        scan: scanRow,
        changes,
        previousScanId: previous?.id ?? null,
        previousResult,
      };
    });

    if (!persisted.scan) {
      throw new Error('The completed scan could not be reloaded.');
    }

    // The scan already read DNS, so the switch row can move without another
    // lookup. Best effort: applySwitchRecord swallows its own failures.
    await applySwitchRecord(domain.id, switchObservationFromScan(result.dmarc));

    await emitDnsWebhooks({
      organizationId: domain.client.organizationId,
      domainId: domain.id,
      domainName: domain.name,
      scanId: scan.id,
      previousScanId: persisted.previousScanId,
      trigger,
      changes: persisted.changes,
      previous: persisted.previousResult,
      current: result,
    });

    /**
     * A hosted record can become delegated (or its CNAME can disappear) between
     * checks. A scan has just read the same names, so it can move the row
     * without another lookup. Any failure is the hosted feature's problem, not
     * the scan's.
     */
    try {
      const hosted = await prisma.hostedDmarcRecord.findUnique({
        where: { domainId: domain.id },
        select: { status: true },
      });
      if (hosted && hosted.status !== 'RELEASED') {
        await checkDelegation({
          organizationId: domain.client.organizationId,
          domainId: domain.id,
          reader,
        });
      }
    } catch (error) {
      console.warn(
        `[hosted-dmarc] delegation check during a scan failed for ${domain.name}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    try {
      const spf = await prisma.hostedSpfRecord.findUnique({
        where: { domainId: domain.id },
        select: { status: true },
      });
      if (spf && spf.status !== 'RELEASED') {
        await checkSpfDelegation({
          organizationId: domain.client.organizationId,
          domainId: domain.id,
          reader,
        });
      }
    } catch (error) {
      console.warn(
        `[hosted-spf] delegation check during a scan failed for ${domain.name}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    try {
      const bimi = await prisma.hostedBimiRecord.findUnique({
        where: { domainId: domain.id },
        select: { status: true },
      });
      if (bimi && bimi.status !== 'RELEASED') {
        await checkBimiDelegation({
          organizationId: domain.client.organizationId,
          domainId: domain.id,
          reader,
        });
      }
    } catch (error) {
      console.warn(
        `[hosted-bimi] delegation check during a scan failed for ${domain.name}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    /**
     * MTA-STS is the one hosted feature whose correctness depends on what the
     * MX lookup says: an enforcing policy that misses a mail server refuses
     * delivery to it. The scan is where that becomes visible, and the check is
     * given the scan id so it can raise the critical change through the same
     * notification path a DNS change uses.
     */
    try {
      const mtaSts = await prisma.hostedMtaStsRecord.findUnique({
        where: { domainId: domain.id },
        select: { status: true },
      });
      if (mtaSts && mtaSts.status !== 'RELEASED') {
        await checkMtaStsDelegation({
          organizationId: domain.client.organizationId,
          domainId: domain.id,
          reader,
          scanId: scan.id,
          previousScanId: persisted.previousScanId,
        });
      }
    } catch (error) {
      console.warn(
        `[hosted-mta-sts] check during a scan failed for ${domain.name}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    return { status: 'completed', scan: persisted.scan, changes: persisted.changes.length };
  } catch (error) {
    const message = errorMessage(error);
    const failedScan = await prisma.scan.update({
      where: { id: scan.id },
      data: {
        status: 'FAILED',
        error: message,
        completedAt: new Date(),
      },
      include: scanInclude,
    });

    return { status: 'failed', scan: failedScan, error: message };
  }
}

export interface ScanListRow extends PersistedScan {
  changeCount: number;
}

/**
 * Scan history, newest first.
 *
 * Paginated because a scheduled scan adds one row per domain per day, so the
 * unbounded list would grow without limit.
 */
export async function listDomainScans(
  organizationId: string,
  domainId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<{ rows: ScanListRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);

  const rows = await prisma.scan.findMany({
    where: {
      domainId,
      domain: { client: { organizationId } },
    },
    include: {
      ...scanInclude,
      _count: { select: { dnsChanges: true } },
    },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    rows: items.map(({ _count, ...scan }) => ({ ...scan, changeCount: _count.dnsChanges })),
    nextCursor: hasMore && last ? last.id : null,
  };
}

export async function getScan(organizationId: string, scanId: string): Promise<PersistedScan | null> {
  return prisma.scan.findFirst({
    where: {
      id: scanId,
      domain: { client: { organizationId } },
    },
    include: scanInclude,
  });
}
