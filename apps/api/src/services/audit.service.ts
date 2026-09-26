import type { AuditAction, Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';

export interface RecordAuditEventInput {
  organizationId?: string;
  domainId?: string;
  actorUserId?: string;
  action: AuditAction;
  targetType: string;
  targetId?: string;
  outcome?: 'SUCCESS' | 'DENIED';
  detail?: Record<string, unknown>;
  ipAddress?: string;
  requestId?: string;
}

export async function recordAuditEvent(input: RecordAuditEventInput): Promise<void> {
  await prisma.auditLog.create({
    data: {
      organizationId: input.organizationId ?? null,
      domainId: input.domainId ?? null,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      outcome: input.outcome ?? 'SUCCESS',
      detail: input.detail === undefined ? undefined : (input.detail as Prisma.InputJsonValue),
      ipAddress: input.ipAddress ?? null,
      requestId: input.requestId ?? null,
    },
  });
}

export async function recordAuditEvents(inputs: RecordAuditEventInput[]): Promise<void> {
  if (inputs.length === 0) {
    return;
  }

  await prisma.auditLog.createMany({
    data: inputs.map((input) => ({
      organizationId: input.organizationId ?? null,
      domainId: input.domainId ?? null,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      outcome: input.outcome ?? ('SUCCESS' as const),
      detail: input.detail === undefined ? undefined : (input.detail as Prisma.InputJsonValue),
      ipAddress: input.ipAddress ?? null,
      requestId: input.requestId ?? null,
    })),
  });
}

export async function listAuditEvents(
  organizationId: string,
  options: { domainId?: string; action?: string; limit?: number } = {},
) {
  return prisma.auditLog.findMany({
    where: {
      organizationId,
      domainId: options.domainId,
      action: options.action as AuditAction | undefined,
    },
    select: {
      id: true,
      action: true,
      outcome: true,
      targetType: true,
      targetId: true,
      detail: true,
      requestId: true,
      createdAt: true,
      domain: { select: { id: true, name: true } },
      actorUser: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(options.limit ?? 100, 1), 200),
  });
}
