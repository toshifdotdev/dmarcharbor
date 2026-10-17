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

/**
 * The narrow slice of Prisma this service needs. Typed as a structural type
 * rather than the concrete client so a `$transaction` callback client - which
 * is a different type with no `$connect` - can be passed straight in.
 */
export interface PrismaClientLike {
  auditLog: {
    create(args: { data: Prisma.AuditLogCreateInput | Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
    createMany(args: { data: Array<Prisma.AuditLogCreateInput | Prisma.AuditLogUncheckedCreateInput> }): Promise<unknown>;
  };
}

export async function recordAuditEvent(
  input: RecordAuditEventInput,
  // A caller inside `$transaction` must pass its transaction client here. The
  // default is the global `prisma`, which opens a SECOND connection: if the
  // audit row's foreign key names a row the open transaction has already
  // deleted, the insert waits on that row's lock while the transaction waits on
  // the callback, and the pair deadlocks until the transaction times out. That
  // is not hypothetical - it is how the workspace delete used to fail, every
  // time, with "Transaction already closed" after five seconds.
  client: PrismaClientLike = prisma,
): Promise<void> {
  await client.auditLog.create({
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
  options: {
    domainId?: string;
    action?: string;
    limit?: number;
    /**
     * Restrict to the last N hours.
     *
     * Hours rather than a date string on purpose: "what happened in the last
     * hour" is the question an operator actually has while something is on fire,
     * and a bare integer cannot be misread as a timezone. The caller never sends a
     * client-supplied date that this then parses.
     */
    withinHours?: number;
  } = {},
  now = new Date(),
) {
  return prisma.auditLog.findMany({
    where: {
      organizationId,
      domainId: options.domainId,
      action: options.action as AuditAction | undefined,
      ...(options.withinHours
        ? { createdAt: { gte: new Date(now.getTime() - options.withinHours * 60 * 60 * 1000) } }
        : {}),
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
