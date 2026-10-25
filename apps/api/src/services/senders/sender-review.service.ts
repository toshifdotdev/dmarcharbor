import { prisma } from '../../database/prisma.js';
import { recordAuditEvent } from '../audit.service.js';
import { domainRef } from '../domain-ref.js';
import { buildSenderBreakdown, type SenderBreakdownRow } from '../sender-breakdown.service.js';
import { cleanText } from './sanitize.js';
import { catalogueById } from './service-catalogue.js';

export type ReviewStatus = 'APPROVED' | 'NOT_OURS' | 'UNREVIEWED';

export class SenderReviewError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code = 'SENDER_REVIEW_ERROR', status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SenderReviewError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface ReviewView {
  status: ReviewStatus;
  note: string | null;
  reviewedAt: string | null;
  reviewedBy: { id: string; name: string } | null;
}

export interface ReviewAndOwner {
  review: ReviewView;
  owner: { id: string; name: string } | null;
}

function noteValue(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const clean = cleanText(value, 280);
  return clean || null;
}

function toView(row: {
  status: 'APPROVED' | 'NOT_OURS' | null;
  note: string | null;
  reviewedAt: Date | null;
  reviewedBy: { id: string; name: string } | null;
  ownerUser: { id: string; name: string } | null;
} | null): ReviewAndOwner {
  return {
    review: {
      status: row?.status ?? 'UNREVIEWED',
      note: row?.note ?? null,
      reviewedAt: row?.reviewedAt?.toISOString() ?? null,
      reviewedBy: row?.reviewedBy ?? null,
    },
    owner: row?.ownerUser ?? null,
  };
}

async function scopedDomain(organizationId: string, domainId: string): Promise<{ id: string; name: string }> {
  const domain = await prisma.domain.findFirst({
    where: { client: { organizationId }, ...domainRef(domainId) },
    select: { id: true, name: true },
  });
  if (!domain) {
    throw new SenderReviewError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  return domain;
}

async function assertSenderSeen(organizationId: string, domainId: string, senderKey: string): Promise<void> {
  const record = await prisma.dmarcReportRecord.findFirst({
    where: {
      senderKey,
      report: { domainId, domain: { client: { organizationId } } },
    },
    select: { id: true },
  });
  if (!record) {
    throw new SenderReviewError('That sender has not appeared in this domain reports.', 'SENDER_NOT_FOUND', 404);
  }
}

export async function reviewSender(input: {
  organizationId: string;
  domainId: string;
  senderKey: string;
  status: ReviewStatus;
  note?: string | null;
  actorUserId?: string | null;
  now?: Date;
}): Promise<ReviewAndOwner> {
  const now = input.now ?? new Date();
  const domain = await scopedDomain(input.organizationId, input.domainId);
  const senderKey = input.senderKey.trim();
  await assertSenderSeen(input.organizationId, domain.id, senderKey);

  const existing = await prisma.senderReview.findUnique({
    where: { domainId_senderKey: { domainId: domain.id, senderKey } },
    select: {
      id: true,
      status: true,
      ownerUserId: true,
      note: true,
      reviewedAt: true,
      reviewedBy: { select: { id: true, name: true } },
      ownerUser: { select: { id: true, name: true } },
    },
  });

  if (input.status === 'UNREVIEWED') {
    if (!existing) {
      return toView(null);
    }
    if (!existing.ownerUserId) {
      await prisma.senderReview.delete({ where: { id: existing.id } });
    } else {
      await prisma.senderReview.update({
        where: { id: existing.id },
        data: { status: null, note: null, reviewedAt: null, reviewedById: null },
      });
    }
    await recordAuditEvent({
      organizationId: input.organizationId,
      domainId: domain.id,
      actorUserId: input.actorUserId ?? undefined,
      action: 'SENDER_REVIEWED',
      targetType: 'sender_review',
      targetId: existing.id,
      detail: { senderKey, status: 'UNREVIEWED' },
    });
    const row = existing.ownerUserId
      ? await prisma.senderReview.findUnique({
          where: { id: existing.id },
          select: {
            status: true,
            note: true,
            reviewedAt: true,
            reviewedBy: { select: { id: true, name: true } },
            ownerUser: { select: { id: true, name: true } },
          },
        })
      : null;
    return toView(row);
  }

  const note = noteValue(input.note);
  const row = await prisma.senderReview.upsert({
    where: { domainId_senderKey: { domainId: domain.id, senderKey } },
    create: {
      organizationId: input.organizationId,
      domainId: domain.id,
      senderKey,
      status: input.status,
      note,
      reviewedById: input.actorUserId ?? null,
      reviewedAt: now,
    },
    update: {
      status: input.status,
      ...(input.note !== undefined ? { note } : {}),
      reviewedById: input.actorUserId ?? null,
      reviewedAt: now,
    },
    select: {
      status: true,
      note: true,
      reviewedAt: true,
      reviewedBy: { select: { id: true, name: true } },
      ownerUser: { select: { id: true, name: true } },
    },
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    domainId: domain.id,
    actorUserId: input.actorUserId ?? undefined,
    action: 'SENDER_REVIEWED',
    targetType: 'sender_review',
    targetId: `${domain.id}:${senderKey}`,
    detail: { senderKey, status: input.status },
  });

  return toView(row);
}

export async function setSenderOwner(input: {
  organizationId: string;
  domainId: string;
  senderKey: string;
  ownerUserId: string | null;
  actorUserId?: string | null;
}): Promise<ReviewAndOwner> {
  const domain = await scopedDomain(input.organizationId, input.domainId);
  const senderKey = input.senderKey.trim();
  await assertSenderSeen(input.organizationId, domain.id, senderKey);

  if (input.ownerUserId) {
    const member = await prisma.member.findFirst({
      where: {
        organizationId: input.organizationId,
        userId: input.ownerUserId,
        role: { in: ['owner', 'admin', 'analyst', 'viewer'] },
      },
      select: { userId: true },
    });
    if (!member) {
      throw new SenderReviewError('Choose a member of this workspace.', 'INVALID_OWNER', 400);
    }
  }

  const existing = await prisma.senderReview.findUnique({
    where: { domainId_senderKey: { domainId: domain.id, senderKey } },
    select: { id: true, status: true },
  });

  if (input.ownerUserId === null) {
    if (!existing) {
      return toView(null);
    }
    if (existing.status === null) {
      await prisma.senderReview.delete({ where: { id: existing.id } });
    } else {
      await prisma.senderReview.update({ where: { id: existing.id }, data: { ownerUserId: null } });
    }
  } else {
    await prisma.senderReview.upsert({
      where: { domainId_senderKey: { domainId: domain.id, senderKey } },
      create: {
        organizationId: input.organizationId,
        domainId: domain.id,
        senderKey,
        ownerUserId: input.ownerUserId,
      },
      update: { ownerUserId: input.ownerUserId },
    });
  }

  await recordAuditEvent({
    organizationId: input.organizationId,
    domainId: domain.id,
    actorUserId: input.actorUserId ?? undefined,
    action: 'SENDER_OWNER_SET',
    targetType: 'sender_review',
    targetId: `${domain.id}:${senderKey}`,
    detail: { senderKey, ownerUserId: input.ownerUserId },
  });

  const row = await prisma.senderReview.findUnique({
    where: { domainId_senderKey: { domainId: domain.id, senderKey } },
    select: {
      status: true,
      note: true,
      reviewedAt: true,
      reviewedBy: { select: { id: true, name: true } },
      ownerUser: { select: { id: true, name: true } },
    },
  });
  return toView(row);
}

export interface BulkReviewResult {
  service: { id: string; name: string };
  status: ReviewStatus;
  updated: number;
}

/**
 * Applies one decision to every sender the catalogue names for a service.
 *
 * Attribution runs per domain, so the set is computed from the same evidence
 * the Senders table shows. Only confirmed or likely names are included; a
 * network-only row has no service to match. The writes are one transaction and
 * produce one audit row with the count.
 */
export async function bulkReviewSendersByService(input: {
  organizationId: string;
  clientId: string;
  serviceId: string;
  status: ReviewStatus;
  actorUserId?: string | null;
  now?: Date;
}): Promise<BulkReviewResult> {
  const service = catalogueById.get(input.serviceId);
  if (!service) {
    throw new SenderReviewError('That service is not in the catalogue.', 'SERVICE_NOT_FOUND', 404);
  }

  const client = await prisma.client.findFirst({
    where: { id: input.clientId, organizationId: input.organizationId },
    select: { id: true },
  });
  if (!client) {
    throw new SenderReviewError('That client is not in this workspace.', 'CLIENT_NOT_FOUND', 404);
  }

  const domains = await prisma.domain.findMany({
    where: { clientId: client.id, client: { organizationId: input.organizationId } },
    select: { id: true },
  });

  const targets: Array<{ domainId: string; senderKey: string }> = [];
  for (const domain of domains) {
    if (targets.length >= 500) break;
    const rows: SenderBreakdownRow[] = await buildSenderBreakdown(input.organizationId, domain.id);
    for (const row of rows) {
      if (targets.length >= 500) break;
      if (
        row.service?.id === service.id &&
        (row.confidence === 'confirmed' || row.confidence === 'likely')
      ) {
        targets.push({ domainId: domain.id, senderKey: row.senderKey });
      }
    }
  }

  const now = input.now ?? new Date();
  await prisma.$transaction(
    async (tx) => {
      for (const target of targets) {
        const existing = await tx.senderReview.findUnique({
          where: { domainId_senderKey: { domainId: target.domainId, senderKey: target.senderKey } },
          select: { id: true, status: true, ownerUserId: true },
        });

        if (input.status === 'UNREVIEWED') {
          if (!existing) continue;
          if (!existing.ownerUserId) {
            await tx.senderReview.delete({ where: { id: existing.id } });
          } else {
            await tx.senderReview.update({
              where: { id: existing.id },
              data: { status: null, note: null, reviewedAt: null, reviewedById: null },
            });
          }
          continue;
        }

        await tx.senderReview.upsert({
          where: { domainId_senderKey: { domainId: target.domainId, senderKey: target.senderKey } },
          create: {
            organizationId: input.organizationId,
            domainId: target.domainId,
            senderKey: target.senderKey,
            status: input.status,
            reviewedById: input.actorUserId ?? null,
            reviewedAt: now,
          },
          update: {
            status: input.status,
            reviewedById: input.actorUserId ?? null,
            reviewedAt: now,
          },
        });
      }

      await recordAuditEvent(
        {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId ?? undefined,
          action: 'SENDER_REVIEWED',
          targetType: 'sender_review_bulk',
          targetId: service.id,
          detail: { clientId: client.id, serviceId: service.id, status: input.status, count: targets.length },
        },
        tx,
      );
    },
    { timeout: 30_000 },
  );

  return { service: { id: service.id, name: service.name }, status: input.status, updated: targets.length };
}
