import { prisma } from '../database/prisma.js';

/**
 * Data Processing Agreement acceptance.
 *
 * Recorded per organisation, not per user. An agency accepts the DPA on behalf of
 * its clients, so the acceptance belongs to the workspace, and a member who leaves
 * must not erase the record that it happened.
 *
 * The version is stored as well as the timestamp because the timestamp answers
 * "when" and an auditor's actual question is "which document". An acceptance with no
 * version cannot answer that.
 */

export class DpaAcceptanceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 409) {
    super(message);
    this.name = 'DpaAcceptanceError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Bump this when the agreement's substance changes.
 *
 * A new version is what makes an existing workspace out of date. Keeping it
 * constant while the wording changes would record an acceptance of something the
 * customer never saw, which is worse than having no acceptance field at all.
 */
export const currentDpaVersion = '1.0';

export interface DpaAcceptance {
  accepted: boolean;
  version: string | null;
  currentVersion: string;
  /** True when an older version was accepted and the current one has not been. */
  requiresReconsent: boolean;
  acceptedAt: Date | null;
  acceptedByEmail: string | null;
  dpaUrl: string;
}

export async function dpaAcceptanceFor(organizationId: string): Promise<DpaAcceptance> {
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { dpaAcceptedAt: true, dpaVersion: true, dpaAcceptedByEmail: true },
  });

  const accepted = organization.dpaAcceptedAt !== null;

  return {
    accepted,
    version: organization.dpaVersion,
    currentVersion: currentDpaVersion,
    // An acceptance of a version that is not the current one is not an acceptance
    // of what the customer would be agreeing to today.
    requiresReconsent: accepted && organization.dpaVersion !== currentDpaVersion,
    acceptedAt: organization.dpaAcceptedAt,
    acceptedByEmail: organization.dpaAcceptedByEmail,
    dpaUrl: '/legal/dpa',
  };
}

/**
 * Records acceptance.
 *
 * Both confirmations are required, and the second one is the one that matters: an
 * employee creating a workspace has not been authorised by their firm to accept a
 * data processing agreement on its behalf. Recording a single tick would let an
 * unauthorised person bind a company to a contract.
 */
export async function recordDpaAcceptance(input: {
  organizationId: string;
  actorUserId?: string | null;
  actorEmail: string;
  hasRead: boolean;
  confirmsAuthority: boolean;
  ipAddress?: string | null;
}): Promise<DpaAcceptance> {
  if (!input.hasRead || !input.confirmsAuthority) {
    throw new DpaAcceptanceError(
      'The Data Processing Agreement has not been accepted.',
      'DPA_NOT_ACCEPTED',
    );
  }

  await prisma.organization.update({
    where: { id: input.organizationId },
    data: {
      dpaAcceptedAt: new Date(),
      dpaVersion: currentDpaVersion,
      dpaAcceptedById: input.actorUserId ?? null,
      dpaAcceptedByEmail: input.actorEmail,
    },
  });

  await prisma.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId ?? undefined,
      action: 'DPA_ACCEPTED',
      targetType: 'organization',
      targetId: input.organizationId,
      detail: {
        version: currentDpaVersion,
        authorityConfirmed: input.confirmsAuthority,
        // Recorded because a dispute about whether someone was authorised is
        // exactly the dispute this row settles.
        ipAddress: input.ipAddress ?? null,
      },
    },
  });

  return dpaAcceptanceFor(input.organizationId);
}

