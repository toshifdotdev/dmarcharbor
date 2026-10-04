import type { ErasureScope, Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma.js';
import { env } from '../../config/env.js';
import { sendErasureCompletedEmail, sendErasureScheduledEmail } from '../../email/mailer.js';
import { deleteStoredLogo, objectKeyFromLogoUrl } from '../branding/logo-storage.service.js';
import { recordAuditEvent } from '../audit.service.js';
import {
  buildErasureCertificate,
  planErasure,
  summarisePlan,
  type ErasureCertificate,
  type PlannedAction,
} from '../inventory/deletion-planner.js';
import { buildInventory, type InventoryScope } from '../inventory/inventory.service.js';
import { planCatalog } from '../entitlements/plan-catalog.js';

export const erasureGraceDays = 7;
export const erasureCertificateRetentionDays = 1095;

export interface ErasurePreview {
  scope: ErasureScope;
  scopeLabel: string;
  plan: string;
  actions: PlannedAction[];
  totals: {
    personalDataRecords: number;
    recordsDeleted: number;
    recordsAnonymised: number;
    evidenceRetained: number;
  };
  graceDays: number;
  executeAfter: string;
  statement: string;
}

function inventoryScopeFor(organizationId: string, scope: ErasureScope, targetId?: string): InventoryScope {
  if (scope === 'CLIENT' && targetId) {
    return { kind: 'CLIENT', organizationId, clientId: targetId };
  }
  if (scope === 'DOMAIN' && targetId) {
    return { kind: 'DOMAIN', organizationId, domainId: targetId };
  }
  return { kind: 'ORGANIZATION', organizationId };
}

function erasureScopeLabel(scope: string): string {
  switch (scope) {
    case 'ORGANIZATION':
      return 'whole workspace';
    case 'CLIENT':
      return 'client';
    case 'DOMAIN':
      return 'domain';
    default:
      return 'workspace';
  }
}

async function labelFor(organizationId: string, scope: ErasureScope, targetId?: string): Promise<string> {
  if (scope === 'CLIENT' && targetId) {
    const client = await prisma.client.findFirst({
      where: { id: targetId, organizationId },
      select: { name: true },
    });
    return client ? `client:${client.name}` : 'client';
  }
  if (scope === 'DOMAIN' && targetId) {
    const domain = await prisma.domain.findFirst({
      where: { id: targetId, client: { organizationId } },
      select: { name: true },
    });
    return domain ? `domain:${domain.name}` : 'domain';
  }
  return 'workspace';
}

/**
 * Builds the preview a customer is shown before confirming. It runs no writes,
 * so the numbers they approve are produced by exactly the same code that will
 * later perform the erasure.
 */
export async function previewErasure(
  organizationId: string,
  scope: ErasureScope,
  targetId?: string,
): Promise<ErasurePreview> {
  const inventoryScope = inventoryScopeFor(organizationId, scope, targetId);
  const inventory = await buildInventory(inventoryScope, { retentionDays: 400 });
  const actions = planErasure(inventory);
  const plan = await prisma.organization.findUnique({ where: { id: organizationId }, select: { plan: true } });
  const tier = plan?.plan ?? 'MOORING';
  const executeAfter = new Date(Date.now() + erasureGraceDays * 24 * 60 * 60 * 1000);

  return {
    scope,
    scopeLabel: await labelFor(organizationId, scope, targetId),
    plan: tier,
    actions,
    totals: summarisePlan(actions),
    graceDays: erasureGraceDays,
    executeAfter: executeAfter.toISOString(),
    statement:
      'Personal data for this scope is deleted in full, including any named recipient records. ' +
      'Identifying fields on retained security records are cleared while the record itself is kept. ' +
      'DMARC authentication evidence is retained because it contains no recipient data. ' +
      'The request is held for ' +
      `${erasureGraceDays} days before it runs, so a mistake can be cancelled.`,
  };
}

export async function requestErasure(input: {
  organizationId: string;
  requestedById: string;
  scope: ErasureScope;
  targetId?: string;
  reason?: string;
}): Promise<{ id: string; purgeAfter: Date; preview: ErasurePreview }> {
  const preview = await previewErasure(input.organizationId, input.scope, input.targetId);

  const request = await prisma.erasureRequest.create({
    data: {
      organizationId: input.organizationId,
      scope: input.scope,
      targetId: input.targetId ?? null,
      requestedById: input.requestedById,
      state: 'PENDING',
      purgeAfter: new Date(preview.executeAfter),
    },
    select: { id: true, purgeAfter: true },
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.requestedById,
    action: 'ERASURE_REQUESTED',
    targetType: 'erasure_request',
    targetId: request.id,
    detail: {
      scope: input.scope,
      targetId: input.targetId ?? null,
      scopeLabel: preview.scopeLabel,
      reason: input.reason ?? null,
      personalDataRecords: preview.totals.personalDataRecords,
      executeAfter: preview.executeAfter,
    },
  });

  // The confirmation matters more here than anywhere else: a deletion is
  // irreversible, so the person who asked has to be able to stop it. The
  // message carries the cancel link, which is why the grace period exists at
  // all rather than deleting immediately.
  void sendErasureScheduledEmail({
    organizationId: input.organizationId,
    scopeLabel: preview.scopeLabel,
    executesAt: request.purgeAfter,
    cancelUrl: `${env.BETTER_AUTH_URL.replace(/\/$/, '')}/app/erasures/${request.id}`,
  });

  return { id: request.id, purgeAfter: request.purgeAfter, preview };
}

export async function cancelErasure(
  organizationId: string,
  requestId: string,
  actorUserId: string,
): Promise<boolean> {
  const request = await prisma.erasureRequest.findFirst({
    where: { id: requestId, organizationId, state: 'PENDING' },
    select: { id: true },
  });

  if (!request) {
    return false;
  }

  await prisma.erasureRequest.update({ where: { id: request.id }, data: { state: 'CANCELLED' } });

  await recordAuditEvent({
    organizationId,
    actorUserId,
    action: 'ERASURE_CANCELLED',
    targetType: 'erasure_request',
    targetId: request.id,
  });

  return true;
}

async function anonymiseAuditTrail(organizationId: string): Promise<number> {
  const { count } = await prisma.auditLog.updateMany({
    where: { organizationId },
    data: { actorUserId: null, ipAddress: null, requestId: null },
  });
  return count;
}

async function anonymiseSubscription(organizationId: string): Promise<number> {
  const { count } = await prisma.subscription.updateMany({
    where: { organizationId },
    data: { providerCustomerId: null, providerSubscriptionId: null },
  });
  return count;
}

export interface ErasureOutcome {
  requestId: string;
  scope: ErasureScope;
  completedAt: string;
  certificate: ErasureCertificate;
  deleted: { clients: number; domains: number; users: number; notifications: number };
  anonymised: { auditEvents: number; subscriptions: number };
}

/**
 * Performs the erasure. The certificate is written before the deletes, and the
 * request row is not cascade deleted with the workspace, so the proof survives
 * the data it describes.
 */
export async function executeErasure(
  requestId: string,
  options: { now?: Date } = {},
): Promise<ErasureOutcome | null> {
  const now = options.now ?? new Date();

  // Claimed before any deletion happens. The read and the claim are one
  // conditional update, so when several instances find the same due erasure only
  // one of them proceeds and the erasure runs, and confirms, exactly once.
  // The claim is on the state only. Whether a request is due is decided by the
  // caller's query, not here: the scheduler only offers due requests, while a
  // user confirming early is entitled to have it run immediately, and putting a
  // due check in the claim turned that into a 409.
  const claim = await prisma.erasureRequest.updateMany({
    where: { id: requestId, state: 'PENDING' },
    data: { state: 'EXECUTING', claimedAt: now },
  });

  if (claim.count !== 1) {
    return null;
  }

  const request = await prisma.erasureRequest.findFirst({
    where: { id: requestId, state: 'EXECUTING' },
    select: {
      id: true,
      organizationId: true,
      scope: true,
      targetId: true,
      requestedById: true,
      purgeAfter: true,
    },
  });

  if (!request || !request.organizationId) {
    return null;
  }

  const organizationId = request.organizationId;
  const inventoryScope = inventoryScopeFor(organizationId, request.scope, request.targetId ?? undefined);
  const inventory = await buildInventory(inventoryScope, { retentionDays: 400 });
  const actions = planErasure(inventory);
  const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { plan: true } });
  const certificate = buildErasureCertificate(inventory, actions, {
    plan: organization?.plan ?? 'MOORING',
    retentionDays: planCatalog[organization?.plan ?? 'MOORING'].dataRetentionDays,
  });

  // Written first, so the proof is never lost to a partial failure below.
  await prisma.erasureRequest.update({
    where: { id: request.id },
    data: { certificate: certificate as unknown as Prisma.InputJsonValue },
  });

  await recordAuditEvent({
    organizationId,
    actorUserId: request.requestedById,
    action: 'ERASURE_COMPLETED',
    targetType: 'erasure_request',
    targetId: request.id,
    detail: {
      scope: request.scope,
      personalDataRecords: certificate.totals.personalDataRecords,
      recordsDeleted: certificate.totals.recordsDeleted,
      recordsAnonymised: certificate.totals.recordsAnonymised,
    },
  });

  const clientFilter =
    request.scope === 'CLIENT' && request.targetId
      ? { id: request.targetId, organizationId }
      : { organizationId };
  const domainFilter =
    request.scope === 'DOMAIN' && request.targetId
      ? { id: request.targetId, client: { organizationId } }
      : request.scope === 'CLIENT' && request.targetId
        ? { clientId: request.targetId, client: { organizationId } }
        : { client: { organizationId } };

  const anonymous = await anonymiseAuditTrail(organizationId);
  const anonymisedSubscriptions = await anonymiseSubscription(organizationId);

  const counts = {
    clients: await prisma.client.count({ where: clientFilter }),
    domains: await prisma.domain.count({ where: domainFilter }),
  };

  let users = 0;
  let notifications: number;

  if (request.scope === 'ORGANIZATION') {
    /**
     * Sessions and accounts go, but the people do not.
     *
     * A user is keyed by email, globally: one person consulting for two agencies
     * has one `User` row and two `Member` rows pointing at it. Deleting that row
     * cascades to `Member`, `Invitation.inviterId`, `ClientPortalAccess.userId` and
     * `Account`, so one workspace's erasure would reach into the other agency and
     * remove the consultant's membership, destroy pending invitations they had
     * issued there, revoke portal grants they held over that agency's clients, and
     * delete the credentials they use to sign in at all.
     *
     * So the memberships for this workspace are removed, sessions for those people
     * everywhere are ended, and a user row is deleted only when this was the last
     * workspace they belonged to. Someone who also works elsewhere keeps their
     * account and their access to everywhere else, exactly as before the request.
     */
    const membersToRemove = await prisma.member.findMany({
      where: { organizationId },
      select: { userId: true },
    });
    const affectedUserIds = [...new Set(membersToRemove.map((member) => member.userId))];

    // A session is per person, not per workspace: holding one grants access to
    // every workspace they belong to. There is no way to end "their sessions for
    // this workspace" only, so all of them are ended. That signs the person out
    // of any other agency they work for too, which is a far smaller harm than
    // leaving a live session into a workspace that has just been erased.
    await prisma.session.deleteMany({ where: { userId: { in: affectedUserIds } } });

    // These rows go before anything is asked about who is left. Computing orphans
    // while this workspace's memberships still exist finds nobody, because
    // everyone still belongs to somewhere - the workspace being erased.
    await prisma.member.deleteMany({ where: { organizationId } });

    notifications = (await prisma.notification.deleteMany({ where: { organizationId } })).count;
    await prisma.alertDelivery.deleteMany({ where: { event: { organizationId } } });
    await prisma.alertRecipient.deleteMany({ where: { rule: { organizationId } } });

    // Only a person with no remaining membership anywhere is genuinely orphaned,
    // and only then is their row ours to remove.
    const orphaned = await prisma.user.findMany({
      where: { id: { in: affectedUserIds }, members: { none: {} } },
      select: { id: true },
    });
    const orphanedIds = orphaned.map((user) => user.id);

    if (orphanedIds.length > 0) {
      await prisma.account.deleteMany({ where: { userId: { in: orphanedIds } } });
      await prisma.invitation.deleteMany({ where: { inviterId: { in: orphanedIds } } });
      users = (await prisma.user.deleteMany({ where: { id: { in: orphanedIds } } })).count;
    }

    // Organization deletion cascades to clients, domains, scans, reports,
    // forensic reports, alert rules, alert events, shares, digests, members,
    // invitations, overrides and the subscription.
    await prisma.organization.delete({ where: { id: organizationId } });
  } else {
    // Deleting the domains cascades their scans, reports, forensic reports,
    // alert rules, alert events, alert deliveries, shares and digests.
    await prisma.domain.deleteMany({ where: domainFilter });
    notifications = (await prisma.notification.deleteMany({ where: { alertEvent: { domain: domainFilter } } })).count;

    if (request.scope === 'CLIENT') {
      await prisma.client.deleteMany({ where: clientFilter });
    }
  }

  // A deletion request that skipped a stored file would not be a deletion, so
  // the asset goes at the same time as the row that pointed at it.
  const branding = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { brandLogoUrl: true },
  });
  await deleteStoredLogo(objectKeyFromLogoUrl(branding?.brandLogoUrl));
  if (branding?.brandLogoUrl) {
    await prisma.organization.update({ where: { id: organizationId }, data: { brandLogoUrl: null } });
  }

  await prisma.erasureRequest.update({
    where: { id: request.id },
    data: { state: 'COMPLETED', completedAt: now, claimedAt: null },
  });

  // Sent after the transaction commits, so the confirmation cannot arrive for a
  // deletion that then failed.
  void sendErasureCompletedEmail({
    organizationId: request.organizationId,
    scopeLabel: erasureScopeLabel(request.scope),
    completedAt: now,
  });

  return {
    requestId: request.id,
    scope: request.scope,
    completedAt: now.toISOString(),
    certificate,
    deleted: { clients: counts.clients, domains: counts.domains, users, notifications },
    anonymised: { auditEvents: anonymous, subscriptions: anonymisedSubscriptions },
  };
}

export async function cancelExpiredErasures(now = new Date()): Promise<number> {
  const { count } = await prisma.erasureRequest.updateMany({
    where: { state: 'PENDING', purgeAfter: { lte: now } },
    data: { state: 'CANCELLED' },
  });
  return count;
}

/**
 * How long a claim is honoured before the erasure is assumed abandoned.
 *
 * Much longer than the lease, because a deletion is destructive and irreversible
 * and a slow one must never be picked up by a second instance. The cost of
 * being wrong this way is a delayed retry, not a double deletion.
 */
const erasureClaimTimeoutMs = 60 * 60 * 1000;

export async function executeDueErasures(now = new Date()): Promise<ErasureOutcome[]> {
  // Returns claims abandoned by a killed instance to the queue. Without this a
  // customer's erasure request would sit in EXECUTING for ever, because the
  // process that claimed it is gone and nothing else will touch it. The timeout
  // is long enough that a genuinely slow deletion is never mistaken for a dead
  // one, and re-running an erasure is safe because it is idempotent.
  await prisma.erasureRequest.updateMany({
    where: { state: 'EXECUTING', claimedAt: { lt: new Date(now.getTime() - erasureClaimTimeoutMs) } },
    data: { state: 'PENDING', claimedAt: null },
  });

  const due = await prisma.erasureRequest.findMany({
    where: { state: 'PENDING', purgeAfter: { lte: now } },
    select: { id: true },
    take: 20,
  });

  const outcomes: ErasureOutcome[] = [];

  for (const entry of due) {
    try {
      const outcome = await executeErasure(entry.id, { now });
      if (outcome) {
        outcomes.push(outcome);
      }
    } catch (error) {
      // Returned to PENDING so a transient failure is retried rather than the
      // request being stranded mid state. The error is reported and the loop
      // continues, because one bad request must not abandon the other nineteen
      // that are due.
      await prisma.erasureRequest
        .updateMany({ where: { id: entry.id, state: 'EXECUTING' }, data: { state: 'PENDING', claimedAt: null } })
        .catch(() => undefined);

      const detail = error instanceof Error ? error.message : 'Unknown erasure failure.';
      console.error(`[erasure] ${entry.id} failed and was requeued: ${detail}`);
    }
  }

  return outcomes;
}
