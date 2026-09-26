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
