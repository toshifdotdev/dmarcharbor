import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from './audit.service.js';
import { domainRef } from './domain-ref.js';
import { hostedSnapshotsForDomainIds, removeHostedForDeletion } from './hosted-dns/hosted-dmarc.service.js';
import {
  managedSpfSnapshotsForDomainIds,
  removeManagedSpfForDeletion,
} from './hosted-dns/managed-spf.service.js';
import {
  hostedBimiSnapshotsForDomainIds,
  removeHostedBimiForDeletion,
} from './hosted-dns/hosted-bimi.service.js';

/**
 * lifecycle-deletion.ts — removing a domain, a client, or a whole workspace.
 *
 * Nothing here existed. A domain could be added, verified and monitored, and
 * then never removed: an agency that offboarded a client had that client's
 * domains sitting in the workspace forever, still counting against the plan's
 * domain quota and still receiving reports addressed to them. There was also no
 * way to delete a client or a workspace.
 *
 * WHAT IS DESTROYED IS THE WHOLE POINT. The schema cascades aggressively:
 * deleting a domain takes its scans, its DMARC reports, its forensic reports,
 * its alert rules, its alert events, its report shares and its report digests
 * with it, and the audit rows lose their domain reference rather than being
 * removed. That is evidence a customer paid to produce, and it cannot be
 * recovered. So each function counts what it is about to destroy and returns it,
 * and the UI shows those numbers before the operator confirms.
 *
 * COUNTING IS THE SUBTLE PART. `ReportShare` hangs off both `clientId` and
 * `domainId`, both cascading, so a share is removed by either parent. Counting
 * it under both would double-count and tell an operator they were about to
 * destroy twice as many links as exist. So a DOMAIN deletion counts the shares
 * naming that domain, and a CLIENT deletion counts the shares naming that
 * client - which is all of them, however they are attached - and does not also
 * count them per domain.
 *
 * Each is scoped to the organization. A caller cannot delete another
 * workspace's row by naming an id they do not own, which is why every lookup
 * carries `client: { organizationId }` rather than an id alone.
 */

/** What a single domain's removal destroys. */
export interface DomainCounts {
  dmarcReports: number;
  forensicReports: number;
  alertRules: number;
  alertEvents: number;
  reportDigests: number;
  scans: number;
}

/** What a client's removal destroys, on top of its domains'. */
export interface ClientCounts {
  domains: number;
  /** Every share naming this client, whichever way it is attached. */
  reportShares: number;
  portalAccessGrants: number;
  compliancePacks: number;
}

/** The whole picture a confirmation screen shows. */
export interface DeletionSummary {
  domains: number;
  dmarcReports: number;
  forensicReports: number;
  alertRules: number;
  alertEvents: number;
  reportDigests: number;
  scans: number;
  reportShares: number;
  portalAccessGrants: number;
  compliancePacks: number;
}

const EMPTY: DeletionSummary = {
  domains: 0,
  dmarcReports: 0,
  forensicReports: 0,
  alertRules: 0,
  alertEvents: 0,
  reportDigests: 0,
  scans: 0,
  reportShares: 0,
  portalAccessGrants: 0,
  compliancePacks: 0,
};

function merge(target: DeletionSummary, add: Partial<DeletionSummary>): DeletionSummary {
  for (const key of Object.keys(target) as Array<keyof DeletionSummary>) {
    target[key] += add[key] ?? 0;
  }
  return target;
}

/** Read-only pass: what the domain's own cascade removes. Shares are counted by
 *  the CALLER at the right level, so this does not touch them. */
async function countDomainRows(domainId: string): Promise<DomainCounts> {
  const [dmarcReports, forensicReports, alertRules, alertEvents, reportDigests, scans] = await Promise.all([
    prisma.dmarcReport.count({ where: { domainId } }),
    prisma.dmarcForensicReport.count({ where: { domainId } }),
    prisma.alertRule.count({ where: { domainId } }),
    prisma.alertEvent.count({ where: { domainId } }),
    prisma.reportDigest.count({ where: { domainId } }),
    prisma.scan.count({ where: { domainId } }),
  ]);

  return { dmarcReports, forensicReports, alertRules, alertEvents, reportDigests, scans };
}

const domainIdsFor = (clientId: string) =>
  prisma.domain.findMany({ where: { clientId }, select: { id: true } });

export interface DomainDeletion {
  ok: boolean;
  reason?: 'not_found';
  name?: string;
  summary?: DeletionSummary;
}

/**
 * Deletes one domain and everything attached to it.
 *
 * Refuses rather than guessing: a caller that names a domain outside its own
 * workspace gets `not_found`, the same answer a caller gets for an id that never
 * existed. That is deliberate - "that domain is in another agency's account"
 * would confirm the domain exists somewhere.
 */
export async function deleteDomain(
  organizationId: string,
  domainIdOrSlug: string,
  actorUserId?: string | null,
): Promise<DomainDeletion> {
  const domain = await prisma.domain.findFirst({
    where: { client: { organizationId }, ...domainRef(domainIdOrSlug) },
    select: { id: true, name: true },
  });

  if (!domain) return { ok: false, reason: 'not_found' };

  const rows = await countDomainRows(domain.id);
  // Shares naming this domain: the client-level count is not added, because a
  // domain delete does not remove shares attached to a sibling domain.
  const reportShares = await prisma.reportShare.count({ where: { domainId: domain.id } });

  const summary: DeletionSummary = merge({ ...EMPTY, domains: 1 }, { ...rows, reportShares });
  const hosted = await hostedSnapshotsForDomainIds([domain.id]);
  const spf = await managedSpfSnapshotsForDomainIds([domain.id]);
  const bimi = await hostedBimiSnapshotsForDomainIds([domain.id]);

  await prisma.$transaction(async (transaction) => {
    await transaction.domain.delete({ where: { id: domain.id } });
    // Recorded with the actor, because "who deleted this evidence" is a question
    // a customer auditor asks, and a deletion with no author cannot be answered.
    await recordAuditEvent({
      organizationId,
      actorUserId: actorUserId ?? undefined,
      action: 'DOMAIN_DELETED',
      targetType: 'domain',
      targetId: domain.id,
      detail: { name: domain.name, destroyed: summary },
    });
  });

  await removeHostedForDeletion(hosted);
  await removeManagedSpfForDeletion(spf);
  await removeHostedBimiForDeletion(bimi);
  return { ok: true, name: domain.name, summary };
}

export interface ClientDeletion {
  ok: boolean;
  reason?: 'not_found' | 'has_portal_access';
  name?: string;
  summary?: DeletionSummary;
}

/** What a client takes with it, without deleting anything. */
async function summariseClient(clientId: string): Promise<DeletionSummary> {
  const domains = await domainIdsFor(clientId);
  const summary: DeletionSummary = { ...EMPTY, domains: domains.length };
  for (const domain of domains) {
    merge(summary, await countDomainRows(domain.id));
  }
  // Shares at client level only. `clientId` covers every share that goes with
  // the client, including any attached to one of its domains.
  merge(summary, {
    reportShares: await prisma.reportShare.count({ where: { clientId } }),
    portalAccessGrants: await prisma.clientPortalAccess.count({ where: { clientId } }),
    compliancePacks: await prisma.compliancePack.count({ where: { clientId } }),
  });
  return summary;
}

/**
 * Deletes a client and everything under it.
 *
 * Refuses while a portal access grant still exists for the client. The grant is
 * a live credential for a client contact, and deleting the client underneath it
 * would leave that person holding a link to a Trust Center that answers with
 * nothing. They have to be revoked first, which is a deliberate step on the
 * portal settings screen rather than a side effect of this one.
 */
export async function deleteClient(
  organizationId: string,
  clientId: string,
  actorUserId?: string | null,
): Promise<ClientDeletion> {
  const client = await prisma.client.findFirst({
    where: { id: clientId, organizationId },
    select: {
      id: true,
      name: true,
      slug: true,
      trustSlug: true,
      // ONLY live grants. Revoking sets `revokedAt` and keeps the row, which is
      // what the audit trail needs, so counting every row made a revoked contact
      // block the delete forever: the operator revoked the access, followed the
      // instruction on the refusal, and hit the identical refusal again with no
      // way out. A revoked grant is a dead credential - nobody can present it -
      // so it must not stand in the way of offboarding the client.
      portalAccess: { where: { revokedAt: null }, select: { id: true } },
    },
  });

  if (!client) return { ok: false, reason: 'not_found' };

  if (client.portalAccess.length > 0) {
    return { ok: false, reason: 'has_portal_access' };
  }

  const summary = await summariseClient(client.id);
  const domainIds = (await domainIdsFor(client.id)).map((domain) => domain.id);
  const [hosted, spf, bimi] = await Promise.all([
    hostedSnapshotsForDomainIds(domainIds),
    managedSpfSnapshotsForDomainIds(domainIds),
    hostedBimiSnapshotsForDomainIds(domainIds),
  ]);

  await prisma.$transaction(async (transaction) => {
    await transaction.client.delete({ where: { id: client.id } });
    await recordAuditEvent({
      organizationId,
      actorUserId: actorUserId ?? undefined,
      action: 'CLIENT_DELETED',
      targetType: 'client',
      targetId: client.id,
      detail: { name: client.name, slug: client.slug, destroyed: summary },
    });
  });

  await removeHostedForDeletion(hosted);
  await removeManagedSpfForDeletion(spf);
  await removeHostedBimiForDeletion(bimi);

  // No trust-link revocation here. `trustSlug` is a column on Client, so the
  // delete above already withdrew the Trust Center address with the row. The old
  // call ran after the delete, found nothing to revoke, and swallowed the
  // failure - code that could only ever be dead.
  return { ok: true, name: client.name, summary };
}

export interface WorkspaceDeletion {
  ok: boolean;
  reason?: 'not_found' | 'has_active_subscription';
  name?: string;
  summary?: DeletionSummary;
}

/** What an organization takes with it, without deleting anything. */
export async function summariseWorkspace(organizationId: string): Promise<DeletionSummary> {
  const clients = await prisma.client.findMany({ where: { organizationId }, select: { id: true } });
  const summary: DeletionSummary = { ...EMPTY };
  for (const client of clients) {
    merge(summary, await summariseClient(client.id));
  }
  // Nothing is added afterwards, and that is the fix rather than an omission.
  // `ClientPortalAccess.clientId` is required, so every grant belongs to exactly
  // one client and `summariseClient` has already counted each one. Adding an
  // org-wide count on top reported every grant twice - a workspace with 3 portal
  // contacts claimed it would destroy 6 - which is the sort of wrong number that
  // makes an operator distrust the whole confirmation screen.
  return summary;
}

/**
 * Deletes a whole workspace and every row in it.
 *
 * Refuses while a subscription is active. Cancelling is a billing action with a
 * period end, a refund policy and a merchant of record, and deleting the
 * workspace is not a way to cancel: it would strand a paid period the customer
 * has already been charged for, with no order left to refund against. The
 * operator cancels first, then deletes.
 */
export async function deleteWorkspace(
  organizationId: string,
  actorUserId: string,
): Promise<WorkspaceDeletion> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, slug: true },
  });

  if (!organization) return { ok: false, reason: 'not_found' };

  /**
   * Only a subscription that can actually bill blocks the delete.
   *
   * `provider: NONE` with an ACTIVE status is an entitlement, not a payment: it
   * is what a seeded workspace, an admin-granted plan or a comped account
   * carries. Nothing was charged, so nothing can be stranded, and refusing there
   * told a customer they had "already been charged for a period" on a workspace
   * they had never paid for - which is both false and impossible to resolve,
   * because there is no subscription in the billing portal to cancel.
   *
   * A Razorpay or Paddle subscription is money that changed hands, and deleting
   * the workspace would leave an order with no workspace to serve and no refund
   * path. That one is refused.
   */
  const subscription = await prisma.subscription.findFirst({
    where: {
      organizationId,
      status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
      provider: { in: ['RAZORPAY', 'PADDLE'] },
    },
    select: { id: true, status: true },
  });

  if (subscription) {
    return { ok: false, reason: 'has_active_subscription' };
  }

  const summary = await summariseWorkspace(organization.id);
  const domainIds = (
    await prisma.domain.findMany({ where: { client: { organizationId } }, select: { id: true } })
  ).map((domain) => domain.id);
  const [hosted, spf, bimi] = await Promise.all([
    hostedSnapshotsForDomainIds(domainIds),
    managedSpfSnapshotsForDomainIds(domainIds),
    hostedBimiSnapshotsForDomainIds(domainIds),
  ]);

  await prisma.$transaction(async (transaction) => {
    // Audit FIRST, on this transaction's own client, and only then delete.
    //
    // Order matters inside one transaction: an insert whose foreign key names a
    // row this transaction has already deleted fails its FK check, because the
    // deleted row is invisible to the transaction that deleted it. Written after
    // the delete it would also self-block - a second connection waiting on the
    // row lock this transaction holds, while this transaction waits on it - and
    // the route failed with "Transaction already closed" after five seconds.
    //
    // Written first, the audit row keeps the foreign key, and the delete's
    // `onDelete: SetNull` then clears it: the record of the deletion outlives
    // the workspace, with the organization id still readable in `targetId`.
    await recordAuditEvent(
      {
        organizationId,
        actorUserId,
        action: 'WORKSPACE_DELETED',
        targetType: 'organization',
        targetId: organization.id,
        detail: { name: organization.name, slug: organization.slug, destroyed: summary },
      },
      transaction,
    );
    await transaction.organization.delete({ where: { id: organization.id } });
  });

  await removeHostedForDeletion(hosted);
  await removeManagedSpfForDeletion(spf);
  await removeHostedBimiForDeletion(bimi);
  return { ok: true, name: organization.name, summary };
}
