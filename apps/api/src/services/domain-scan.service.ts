import type { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { scanDomain } from '../scanner/scanner.js';

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
  requestedById: string;
};

export type RunDomainScanOutcome =
  | { status: 'not_found' }
  | { status: 'not_verified' }
  | { status: 'completed'; scan: PersistedScan }
  | { status: 'failed'; scan: PersistedScan; error: string };

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The scan failed unexpectedly.';
}

export async function runDomainScan(input: RunDomainScanInput): Promise<RunDomainScanOutcome> {
  const domain = await prisma.domain.findFirst({
    where: {
      id: input.domainId,
      client: { organizationId: input.organizationId },
    },
    select: {
      id: true,
      name: true,
      status: true,
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
      status: 'RUNNING',
    },
  });

  try {
    const result = await scanDomain(domain.name);

    /**
     * A scan that could not reach DNS is not a scan that found nothing.
     *
     * `scanDomain` answers with `status: 'error'` and `score: 0` when its lookups
     * fail rather than throwing, so this looked like an ordinary completed scan
     * and was stored as one. The row then read "completed, score 0" - a measured
     * zero - and the domain's recorded DMARC policy was overwritten with this
     * scan's `unknown`, quietly replacing a real answer from a scan that worked
     * with no answer from one that never ran.
     *
     * Stored as FAILED, with the reason preserved, and the domain row left
     * exactly as the previous scan left it.
     *
     * `error` is the only status that means this. `missing` and
     * `needs_attention` are findings, not failures: a domain that publishes no
     * DMARC record at all is exactly what the scan exists to report, and
     * treating it as an error would mean a healthy scan of a badly configured
     * domain was never recorded.
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
    const persistedScan = await prisma.$transaction(async (transaction) => {
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

      return transaction.scan.findUnique({
        where: { id: scan.id },
        include: scanInclude,
      });
    });

    if (!persistedScan) {
      throw new Error('The completed scan could not be reloaded.');
    }

    return { status: 'completed', scan: persistedScan };
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

export async function listDomainScans(organizationId: string, domainId: string): Promise<PersistedScan[]> {
  return prisma.scan.findMany({
    where: {
      domainId,
      domain: { client: { organizationId } },
    },
    include: scanInclude,
    orderBy: { startedAt: 'desc' },
  });
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
