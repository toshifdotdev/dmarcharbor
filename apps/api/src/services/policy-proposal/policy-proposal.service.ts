import type { PolicyProposal, PolicyProposalStatus, Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma.js';
import { recordAuditEvent } from '../audit.service.js';
import { resolveEntitlements } from '../entitlements/entitlement.service.js';
import { domainRef } from '../domain-ref.js';
import {
  isDmarcRecordValue,
  normaliseTxtValue,
  rewriteDmarcPolicy,
  type DmarcPublishPolicy,
} from '../dns-automation/records.js';
import {
  HostedDmarcError,
  changePolicy,
  effectiveLevel,
  policyFromValue,
} from '../hosted-dns/hosted-dmarc.service.js';
import {
  enforcementLevelOf,
  getOnboardingState,
  type PolicyReadiness,
} from '../onboarding.service.js';
import { sendPolicyApprovalRequestedEmail, sendPolicyProposalDecidedEmail } from '../../email/mailer.js';
import { describeProposal, policyLabel, type ProposalEvidence, type ProposalWords } from './proposal-words.js';

/**
 * Client-approved enforcement.
 *
 * Moving a domain to quarantine or reject is the one DMARC change that can stop
 * the client's own mail, and it is the client who carries that risk. So the
 * agency proposes the step, the client contact approves or declines it in the
 * portal, and the decision is recorded under the contact's own account. A
 * hosted record changes the moment the client approves; any other record is
 * handed back to the agency with the exact value to publish.
 */

export const proposalLifetimeDays = 14;
export const maximumNoteLength = 600;
export const maximumDeclineReasonLength = 600;

export class PolicyProposalError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 409,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PolicyProposalError';
  }
}

export type ProposalState = 'pending' | 'expired' | 'approved' | 'declined' | 'withdrawn' | 'superseded';

export interface ProposalView {
  id: string;
  state: ProposalState;
  domain: { id: string; slug: string; name: string };
  from: { policy: string; testing: boolean; label: string };
  to: { policy: string; testing: boolean; np: string | null; label: string };
  recordValue: string;
  applyVia: 'hosted' | 'manual';
  note: string | null;
  evidence: ProposalEvidence;
  blockers: string[];
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedByEmail: string | null;
  declineReason: string | null;
  appliedAt: string | null;
  applyError: string | null;
  /**
   * For an approved proposal: is the approved policy what the domain publishes
   * now? A hosted change counts once it went through; a manual one once the
   * latest scan shows it. Null for anything not approved.
   */
  published: boolean | null;
}

export interface PortalProposalView {
  id: string;
  state: ProposalState;
  domain: { id: string; name: string };
  clientName: string;
  agencyName: string;
  words: ProposalWords;
  note: string | null;
  blockers: string[];
  recordValue: string;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedByEmail: string | null;
  declineReason: string | null;
}

type Readiness = (organizationId: string, domainId: string) => Promise<PolicyReadiness | null>;

let readinessOverride: Readiness | null = null;

/** Test seam so proposals can be made without seeding a month of reports. */
export function setProposalReadinessForTests(check: Readiness | null): void {
  readinessOverride = check;
}

function stateOf(row: Pick<PolicyProposal, 'status' | 'expiresAt'>, now = new Date()): ProposalState {
  if (row.status === 'PENDING') {
    return row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending';
  }
  return row.status.toLowerCase() as ProposalState;
}

function evidenceOf(value: Prisma.JsonValue): ProposalEvidence {
  const raw = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const number = (key: string) => (typeof raw[key] === 'number' ? (raw[key] as number) : 0);
  const nullable = (key: string) => (typeof raw[key] === 'number' ? (raw[key] as number) : null);
  return {
    daysObserved: number('daysObserved'),
    daysAtCurrentPolicy: number('daysAtCurrentPolicy'),
    messagesObserved: number('messagesObserved'),
    passRatePercent: nullable('passRatePercent'),
    dkimPassRatePercent: nullable('dkimPassRatePercent'),
    failingSenders: number('failingSenders'),
    observedSenders: number('observedSenders'),
  };
}

/**
 * Orders policies along the rollout ladder: none, quarantine on trial,
 * quarantine, reject on trial, reject. What receivers apply comes first, then
 * the published p, so the trial steps count as steps: quarantine with t=y is
 * applied like none but is still the move towards quarantine.
 */
export function strictness(policy: { p: string; testing: boolean }): number {
  const base = policy.p === 'reject' ? 2 : policy.p === 'quarantine' ? 1 : 0;
  return effectiveLevel({ p: policy.p, testing: policy.testing, np: null }) * 3 + base;
}

/** p and t of a published record, as the scanner last read it. */
function publishedPolicy(record: string | null): { policy: string; testing: boolean } | null {
  if (!record || !isDmarcRecordValue(record)) {
    return null;
  }
  const parsed = policyFromValue(normaliseTxtValue(record));
  return { policy: parsed.p, testing: parsed.testing };
}

const proposalInclude = {
  domain: { select: { id: true, slug: true, name: true, dmarcRecord: true, client: { select: { name: true } } } },
  createdBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.PolicyProposalInclude;

type ProposalRow = Prisma.PolicyProposalGetPayload<{ include: typeof proposalInclude }>;

function toView(row: ProposalRow, now = new Date()): ProposalView {
  const state = stateOf(row, now);
  let published: boolean | null = null;
  if (state === 'approved') {
    if (row.applyVia === 'hosted') {
      published = row.appliedAt !== null;
    } else {
      const live = publishedPolicy(row.domain.dmarcRecord);
      published = live !== null && live.policy === row.policy && live.testing === row.testing;
    }
  }
  return {
    id: row.id,
    state,
    domain: { id: row.domain.id, slug: row.domain.slug, name: row.domain.name },
    from: { policy: row.fromPolicy, testing: row.fromTesting, label: policyLabel(row.fromPolicy, row.fromTesting) },
    to: { policy: row.policy, testing: row.testing, np: row.np, label: policyLabel(row.policy, row.testing) },
    recordValue: row.recordValue,
    applyVia: row.applyVia === 'hosted' ? 'hosted' : 'manual',
    note: row.note,
    evidence: evidenceOf(row.evidence),
    blockers: row.blockers,
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name || row.createdBy.email } : null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByEmail: row.decidedByEmail,
    declineReason: row.declineReason,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    applyError: row.applyError,
    published,
  };
}

async function agencyNameOf(organizationId: string): Promise<string> {
  const organization = await prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
  return organization?.name ?? 'Your IT provider';
}

function toPortalView(row: ProposalRow, agencyName: string, now = new Date()): PortalProposalView {
  const evidence = evidenceOf(row.evidence);
  return {
    id: row.id,
    state: stateOf(row, now),
    domain: { id: row.domain.id, name: row.domain.name },
    clientName: row.domain.client.name,
    agencyName,
    words: describeProposal({
      domainName: row.domain.name,
      agencyName,
      policy: row.policy,
      testing: row.testing,
      evidence,
    }),
    note: row.note,
    blockers: row.blockers,
    recordValue: row.recordValue,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByEmail: row.decidedByEmail,
    declineReason: row.declineReason,
  };
}

async function findDomain(organizationId: string, domainRefOrId: string) {
  return prisma.domain.findFirst({
    where: { client: { organizationId }, ...domainRef(domainRefOrId) },
    select: { id: true, slug: true, name: true, status: true, clientId: true, dmarcRecord: true },
  });
}

/** Whether a proposal made now would be applied by DMARC Harbor or handed back. */
async function hostedRowFor(domainId: string) {
  const row = await prisma.hostedDmarcRecord.findUnique({ where: { domainId } });
  return row && (row.status === 'PENDING' || row.status === 'ACTIVE') ? row : null;
}

async function activeContactCount(organizationId: string, clientId: string): Promise<number> {
  return prisma.clientPortalAccess.count({ where: { organizationId, clientId, revokedAt: null } });
}

// ─── Agency side ─────────────────────────────────────────────────────────────

export async function listDomainProposals(
  organizationId: string,
  domainRefOrId: string,
): Promise<{ proposals: ProposalView[]; contacts: number; applyVia: 'hosted' | 'manual' } | null> {
  const domain = await findDomain(organizationId, domainRefOrId);
  if (!domain) {
    return null;
  }
  const [rows, contacts, hosted] = await Promise.all([
    prisma.policyProposal.findMany({
      where: { organizationId, domainId: domain.id },
      include: proposalInclude,
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    activeContactCount(organizationId, domain.clientId),
    hostedRowFor(domain.id),
  ]);
  const now = new Date();
  return { proposals: rows.map((row) => toView(row, now)), contacts, applyVia: hosted ? 'hosted' : 'manual' };
}

export async function createPolicyProposal(input: {
  organizationId: string;
  domainId: string;
  actorUserId: string | null;
  policy: Exclude<DmarcPublishPolicy, 'none'>;
  testing: boolean;
  note?: string | null;
  acceptBlockers?: boolean;
}): Promise<ProposalView> {
  const domain = await findDomain(input.organizationId, input.domainId);
  if (!domain) {
    throw new PolicyProposalError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  if (domain.status !== 'VERIFIED') {
    throw new PolicyProposalError(
      'Verify this domain first. The client portal only shows verified domains, so the client could not see the request.',
      'DOMAIN_NOT_VERIFIED',
      409,
    );
  }
  if ((await activeContactCount(input.organizationId, domain.clientId)) === 0) {
    throw new PolicyProposalError(
      'Nobody at this client can approve it yet. Invite a contact to the client portal first.',
      'NO_PORTAL_CONTACTS',
      409,
    );
  }

  const hosted = await hostedRowFor(domain.id);
  const base = hosted?.value ?? domain.dmarcRecord;
  if (!base || !isDmarcRecordValue(base)) {
    throw new PolicyProposalError(
      'This domain publishes no DMARC record yet. Publish p=none and collect reports before proposing enforcement.',
      'NO_DMARC_RECORD',
      409,
    );
  }
  const current = policyFromValue(normaliseTxtValue(base));
  const target = { p: input.policy, testing: input.testing, np: current.np };
  if (strictness(target) <= strictness(current)) {
    throw new PolicyProposalError(
      `The domain already publishes ${policyLabel(current.p, current.testing)}, which is at least as strict. A proposal must tighten the policy.`,
      'NOT_STRICTER',
      409,
    );
  }

  const state = await getOnboardingState(input.organizationId, domain.id);
  if (!state) {
    throw new PolicyProposalError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const readiness = readinessOverride ? await readinessOverride(input.organizationId, domain.id) : state.readiness;
  if (!readiness) {
    throw new PolicyProposalError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
  }
  const level = enforcementLevelOf(input.policy, input.testing);
  const blockers =
    level === 'reject'
      ? readiness.blockersByLevel.reject
      : level === 'quarantine'
        ? readiness.blockersByLevel.quarantine
        : [];
  if (blockers.length > 0 && input.acceptBlockers !== true) {
    throw new PolicyProposalError(
      'The evidence does not support this step yet. Resolve the open points, or propose it anyway and the client will see them.',
      'POLICY_NOT_READY',
      409,
      { blockers },
    );
  }

  const recordValue = rewriteDmarcPolicy(base, state.suggestedRecord.aggregateAddress, {
    policy: input.policy,
    testing: input.testing,
    np: (current.np as DmarcPublishPolicy | null) ?? null,
  });
  const evidence: ProposalEvidence = {
    daysObserved: readiness.daysObserved,
    daysAtCurrentPolicy: readiness.daysAtCurrentPolicy,
    messagesObserved: readiness.messagesObserved,
    passRatePercent: readiness.passRatePercent,
    dkimPassRatePercent: readiness.dkimPassRatePercent,
    failingSenders: readiness.failingSenders,
    observedSenders: readiness.observedSenders,
  };
  const now = new Date();
  const note = input.note?.trim() ? input.note.trim() : null;

  const created = await prisma.$transaction(async (transaction) => {
    // The domain row is the lock: one live proposal per domain, so two people
    // proposing at once cannot leave the client two requests to answer.
    await transaction.$queryRaw`SELECT id FROM "domain" WHERE id = ${domain.id} FOR UPDATE`;
    await transaction.policyProposal.updateMany({
      where: { domainId: domain.id, status: 'PENDING' },
      data: { status: 'SUPERSEDED' },
    });
    const row = await transaction.policyProposal.create({
      data: {
        organizationId: input.organizationId,
        domainId: domain.id,
        createdById: input.actorUserId,
        fromPolicy: current.p,
        fromTesting: current.testing,
        policy: input.policy,
        testing: input.testing,
        np: current.np,
        recordValue,
        applyVia: hosted ? 'hosted' : 'manual',
        note,
        evidence: evidence as unknown as Prisma.InputJsonValue,
        blockers,
        expiresAt: new Date(now.getTime() + proposalLifetimeDays * 24 * 60 * 60 * 1000),
      },
      include: proposalInclude,
    });
    await recordAuditEvent(
      {
        organizationId: input.organizationId,
        domainId: domain.id,
        actorUserId: input.actorUserId ?? undefined,
        action: 'POLICY_PROPOSAL_CREATED',
        targetType: 'policy_proposal',
        targetId: row.id,
        detail: {
          from: policyLabel(current.p, current.testing),
          to: policyLabel(input.policy, input.testing),
          applyVia: row.applyVia,
          ...(blockers.length > 0 ? { blockersAccepted: blockers } : {}),
        },
      },
      transaction,
    );
    return row;
  });

  sendPolicyApprovalRequestedEmail({ proposalId: created.id });
  return toView(created, now);
}

export async function withdrawPolicyProposal(input: {
  organizationId: string;
  proposalId: string;
  actorUserId: string | null;
}): Promise<ProposalView | null> {
  const row = await prisma.policyProposal.findFirst({
    where: { id: input.proposalId, organizationId: input.organizationId },
    select: { id: true, domainId: true },
  });
  if (!row) {
    return null;
  }
  const updated = await prisma.policyProposal.updateMany({
    where: { id: row.id, status: 'PENDING' },
    data: { status: 'WITHDRAWN' },
  });
  if (updated.count === 0) {
    throw new PolicyProposalError(
      'The client has already answered this request, or it was replaced.',
      'PROPOSAL_NOT_PENDING',
      409,
    );
  }
  await recordAuditEvent({
    organizationId: input.organizationId,
    domainId: row.domainId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'POLICY_PROPOSAL_WITHDRAWN',
    targetType: 'policy_proposal',
    targetId: row.id,
  });
  const fresh = await prisma.policyProposal.findUniqueOrThrow({ where: { id: row.id }, include: proposalInclude });
  return toView(fresh);
}

/** Tries the hosted change again after the provider, or the record, refused it. */
export async function retryPolicyProposal(input: {
  organizationId: string;
  proposalId: string;
  actorUserId: string;
}): Promise<ProposalView | null> {
  const row = await prisma.policyProposal.findFirst({
    where: { id: input.proposalId, organizationId: input.organizationId },
  });
  if (!row) {
    return null;
  }
  if (row.status !== 'APPROVED' || row.applyVia !== 'hosted' || row.appliedAt !== null) {
    throw new PolicyProposalError(
      'Only an approved hosted change that has not gone through can be retried.',
      'NOTHING_TO_RETRY',
      409,
    );
  }
  await applyApproved(row, input.actorUserId);
  const fresh = await prisma.policyProposal.findUniqueOrThrow({ where: { id: row.id }, include: proposalInclude });
  return toView(fresh);
}

// ─── Applying an approval ────────────────────────────────────────────────────

/**
 * Changes the hosted record to what the client approved.
 *
 * Never throws: an approval is the client's decision and stands whatever
 * happens next. A change that cannot go through is recorded on the proposal
 * in words, the agency is told, and they can retry.
 *
 * Open points the client saw and approved are accepted (the readiness gate is
 * overridden). A proposal made with none is not: if the evidence has turned
 * since, the record is left alone, because the client approved a step that was
 * ready, not whatever it has become.
 */
async function applyApproved(row: PolicyProposal, actorUserId: string): Promise<void> {
  const fail = async (message: string) => {
    await prisma.policyProposal.update({ where: { id: row.id }, data: { applyError: message } });
  };

  const hosted = await prisma.hostedDmarcRecord.findUnique({ where: { domainId: row.domainId } });
  if (!hosted || hosted.status === 'RELEASING' || hosted.status === 'RELEASED') {
    await fail('DMARC Harbor no longer hosts this record, so nothing was changed. Publish the approved record yourself.');
    return;
  }
  const entitlements = await resolveEntitlements(row.organizationId);
  if (entitlements.features['dns.hosted'] !== true) {
    await fail("Hosted record changes are paused on this workspace's plan, so nothing was changed.");
    return;
  }

  const current = policyFromValue(hosted.value);
  const target = { p: row.policy, testing: row.testing };
  if (strictness(current) >= strictness(target)) {
    if (current.p === row.policy && current.testing === row.testing) {
      await prisma.policyProposal.update({ where: { id: row.id }, data: { appliedAt: new Date(), applyError: null } });
    } else {
      await fail(
        `The record already publishes ${policyLabel(current.p, current.testing)}, which is at least as strict, so it was left as it is.`,
      );
    }
    return;
  }

  try {
    await changePolicy({
      organizationId: row.organizationId,
      domainId: row.domainId,
      actorUserId,
      expectedVersion: hosted.version,
      policy: row.policy as DmarcPublishPolicy,
      testing: row.testing,
      np: (row.np as DmarcPublishPolicy | null) ?? null,
      override: row.blockers.length > 0,
    });
    await prisma.policyProposal.update({ where: { id: row.id }, data: { appliedAt: new Date(), applyError: null } });
  } catch (error) {
    if (error instanceof HostedDmarcError) {
      const blockers = Array.isArray(error.details?.blockers) ? (error.details.blockers as string[]) : [];
      const message =
        error.code === 'POLICY_NOT_READY'
          ? `The evidence changed after this was proposed, so the record was left as it is: ${blockers.join(' ')}`
          : error.code === 'VERSION_CHANGED'
            ? 'Someone changed the record at the same moment. Retry to apply the approved policy.'
            : error.message;
      await fail(message);
      return;
    }
    console.error('[policy-proposal] applying an approval failed', error);
    await fail('The change could not be made just now. Retry it from the domain page.');
  }
}

// ─── Client side ─────────────────────────────────────────────────────────────

/** Proposals for the clients a contact can see: open ones, and the last few answered. */
export async function listPortalProposals(input: {
  organizationId: string;
  clientIds: string[];
  domainId?: string;
}): Promise<PortalProposalView[]> {
  const now = new Date();
  const rows = await prisma.policyProposal.findMany({
    where: {
      organizationId: input.organizationId,
      domain: { clientId: { in: input.clientIds }, status: 'VERIFIED', ...(input.domainId ? domainRef(input.domainId) : {}) },
      status: { in: ['PENDING', 'APPROVED', 'DECLINED'] as PolicyProposalStatus[] },
    },
    include: proposalInclude,
    orderBy: { createdAt: 'desc' },
    take: input.domainId ? 5 : 50,
  });
  const agencyName = await agencyNameOf(input.organizationId);
  return rows
    .map((row) => toPortalView(row, agencyName, now))
    .filter((view) => (input.domainId ? true : view.state === 'pending'));
}

export async function decidePolicyProposal(input: {
  organizationId: string;
  clientIds: string[];
  proposalId: string;
  user: { id: string; email: string };
  decision: 'approve' | 'decline';
  reason?: string | null;
}): Promise<PortalProposalView> {
  const row = await prisma.policyProposal.findFirst({
    where: {
      id: input.proposalId,
      organizationId: input.organizationId,
      domain: { clientId: { in: input.clientIds }, status: 'VERIFIED' },
    },
  });
  if (!row) {
    throw new PolicyProposalError('That request is not one you can answer.', 'NOT_FOUND', 404);
  }
  const now = new Date();
  const state = stateOf(row, now);
  if (state === 'expired') {
    throw new PolicyProposalError(
      'This request has expired. Ask your IT provider to send it again if you still want the change.',
      'PROPOSAL_EXPIRED',
      409,
    );
  }
  if (state !== 'pending') {
    throw new PolicyProposalError('This request has already been answered or withdrawn.', 'PROPOSAL_NOT_PENDING', 409);
  }

  const approved = input.decision === 'approve';
  const reason = !approved && input.reason?.trim() ? input.reason.trim() : null;
  // The claim: only one answer wins, whoever clicks first, and nothing is
  // decided on a request that expired or was withdrawn in the meantime.
  const claimed = await prisma.policyProposal.updateMany({
    where: { id: row.id, status: 'PENDING', expiresAt: { gt: now } },
    data: {
      status: approved ? 'APPROVED' : 'DECLINED',
      decidedAt: now,
      decidedById: input.user.id,
      decidedByEmail: input.user.email.trim().toLowerCase(),
      declineReason: reason,
    },
  });
  if (claimed.count === 0) {
    throw new PolicyProposalError('This request has already been answered or withdrawn.', 'PROPOSAL_NOT_PENDING', 409);
  }

  await recordAuditEvent({
    organizationId: input.organizationId,
    domainId: row.domainId,
    actorUserId: input.user.id,
    action: approved ? 'POLICY_PROPOSAL_APPROVED' : 'POLICY_PROPOSAL_DECLINED',
    targetType: 'policy_proposal',
    targetId: row.id,
    detail: {
      contact: input.user.email.trim().toLowerCase(),
      to: policyLabel(row.policy, row.testing),
      ...(reason ? { reason } : {}),
    },
  });

  if (approved && row.applyVia === 'hosted') {
    await applyApproved({ ...row, status: 'APPROVED' }, input.user.id);
  }

  await notifyAgency(row.id).catch((error: unknown) => {
    console.error('[policy-proposal] notifying the agency failed', error);
  });
  sendPolicyProposalDecidedEmail({ proposalId: row.id });

  const fresh = await prisma.policyProposal.findUniqueOrThrow({ where: { id: row.id }, include: proposalInclude });
  return toPortalView(fresh, await agencyNameOf(input.organizationId));
}

/**
 * In-app notice to the person who proposed and to the workspace's owners and
 * admins. One row per person; the proposal id ties it to the domain, so it
 * goes when the domain does.
 */
async function notifyAgency(proposalId: string): Promise<void> {
  const row = await prisma.policyProposal.findUnique({ where: { id: proposalId }, include: proposalInclude });
  if (!row || (row.status !== 'APPROVED' && row.status !== 'DECLINED')) {
    return;
  }
  const members = await prisma.member.findMany({
    where: {
      organizationId: row.organizationId,
      OR: [{ role: { in: ['owner', 'admin'] } }, ...(row.createdById ? [{ userId: row.createdById }] : [])],
    },
    select: { userId: true },
  });
  const userIds = [...new Set(members.map((member) => member.userId))];
  if (userIds.length === 0) {
    return;
  }
  const notice = agencyNotice(toView(row));
  await prisma.notification.createMany({
    data: userIds.map((userId) => ({
      userId,
      organizationId: row.organizationId,
      kind: 'POLICY_APPROVAL' as const,
      severity: notice.severity,
      title: notice.title,
      body: notice.body,
      link: `/domains/${row.domain.slug}`,
      policyProposalId: row.id,
    })),
  });
}

/** The agency's notice for a decided proposal, shared by the in-app notice and the email. */
export function agencyNotice(view: ProposalView): {
  severity: 'INFO' | 'WARNING';
  title: string;
  body: string;
} {
  const who = view.decidedByEmail ?? 'The client';
  if (view.state === 'declined') {
    return {
      severity: 'WARNING',
      title: `${view.domain.name}: the client declined ${view.to.label}`,
      body: `${who} declined the change.${view.declineReason ? ` Their reason: "${view.declineReason}"` : ''} The record was not changed.`,
    };
  }
  if (view.applyVia === 'hosted') {
    return view.appliedAt
      ? {
          severity: 'INFO',
          title: `${view.domain.name}: approved and now ${view.to.label}`,
          body: `${who} approved the change, and the hosted record now publishes ${view.to.label}.`,
        }
      : {
          severity: 'WARNING',
          title: `${view.domain.name}: approved, but the record was not changed`,
          body: `${who} approved ${view.to.label}. ${view.applyError ?? 'The change did not go through.'}`,
        };
  }
  return {
    severity: 'INFO',
    title: `${view.domain.name}: approved, ready for you to publish`,
    body: `${who} approved ${view.to.label}. Publish this record at _dmarc.${view.domain.name}: ${view.recordValue}`,
  };
}

/** For the mailer: the views it renders from, without a second copy of the rules. */
export async function proposalForEmail(proposalId: string): Promise<{
  view: ProposalView;
  portal: PortalProposalView;
  organizationId: string;
  clientId: string;
  createdByEmail: string | null;
} | null> {
  const row = await prisma.policyProposal.findUnique({
    where: { id: proposalId },
    include: { ...proposalInclude, domain: { select: { ...proposalInclude.domain.select, clientId: true } } },
  });
  if (!row) {
    return null;
  }
  const agencyName = await agencyNameOf(row.organizationId);
  return {
    view: toView(row),
    portal: toPortalView(row, agencyName),
    organizationId: row.organizationId,
    clientId: row.domain.clientId,
    createdByEmail: row.createdBy?.email ?? null,
  };
}
