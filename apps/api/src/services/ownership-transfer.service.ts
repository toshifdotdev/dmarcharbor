import type { PlanTier } from '@prisma/client';
import { symmetricDecrypt } from 'better-auth/crypto';
import { auth } from '../auth/auth.config.js';
import { totpKey, verifyTotp } from '../auth/totp-check.js';
import { claimTotpCode, claimableCode, releaseTotpCode } from '../auth/totp-replay.js';
import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { queueEmail } from '../email/email.service.js';
import { ownershipTransferredEmail } from '../email/templates.js';
import { rateLimitStoreFor } from '../middleware/postgres-rate-limit-store.js';
import { recordAuditEvent } from './audit.service.js';
import { resolveEntitlements } from './entitlements/entitlement.service.js';
import { planCatalog, planLabel } from './entitlements/plan-catalog.js';
import { workspaceAllowanceFor } from './entitlements/workspace-allowance.service.js';
import { countCountedDomainsIn } from './inventory/inventory.service.js';

/**
 * Handing a workspace to another member.
 *
 * A workspace has exactly one owner, and the plan, the workspace allowance and
 * the right to delete the workspace all come from that person's account. The
 * plugin's update-member-role no longer accepts "owner" (auth.config.ts), so
 * this is the only way ownership moves: the owner picks a member, confirms with
 * their password or a two-step code, and in one transaction the member becomes
 * owner and the previous owner becomes an admin.
 *
 * The workspace then follows the new owner's plan and counts toward their
 * account, so the transfer is refused when that would put their account over
 * its workspace, client or active-domain limit.
 */
export class OwnershipTransferError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'OwnershipTransferError';
  }
}

/** Ten confirmations per owner per quarter hour, right or wrong. */
const ATTEMPT_LIMIT = 10;
const ATTEMPT_WINDOW_MS = 15 * 60_000;
const attempts = rateLimitStoreFor('ownership-transfer');

/** Live, billed subscriptions; the same rule the workspace deletion uses. */
const BILLED_PROVIDERS = ['RAZORPAY', 'PADDLE'] as const;
const LIVE_STATUSES = ['ACTIVE', 'TRIALING', 'PAST_DUE'] as const;

export interface TransferInput {
  organizationId: string;
  actorUserId: string;
  newOwnerMemberId: string;
  password?: string;
  code?: string;
  ipAddress?: string;
  requestId?: string;
  now?: Date;
}

export interface TransferResult {
  organizationId: string;
  newOwner: { memberId: string; userId: string; email: string; name: string };
  previousOwner: { memberId: string; userId: string; email: string; role: 'admin' };
  plan: PlanTier;
  planLabel: string;
}

/**
 * What the transfer would do, before the owner confirms: the plan the
 * workspace follows afterwards, and the refusal it would meet, if any. The
 * members page shows both in the confirmation, so a downgrade or a blocked
 * transfer is read before a password is typed rather than after.
 */
export interface TransferPreview {
  newOwner: { memberId: string; name: string; email: string };
  currentPlan: PlanTier;
  currentPlanLabel: string;
  plan: PlanTier;
  planLabel: string;
  refusal: { status: number; code: string; message: string; details: Record<string, unknown> } | null;
}

export async function previewTransfer(input: {
  organizationId: string;
  actorUserId: string;
  newOwnerMemberId: string;
  now?: Date;
}): Promise<TransferPreview> {
  const parties = await transferParties(input);
  const currentPlan = (await resolveEntitlements(input.organizationId, input.now)).plan;
  let refusal: TransferPreview['refusal'] = null;
  try {
    await assertTransferable(parties, input.now ?? new Date());
  } catch (error) {
    if (!(error instanceof OwnershipTransferError)) throw error;
    refusal = { status: error.status, code: error.code, message: error.message, details: error.details };
  }
  return {
    newOwner: {
      memberId: parties.target.id,
      name: parties.target.user.name?.trim() || parties.target.user.email,
      email: parties.target.user.email,
    },
    currentPlan,
    currentPlanLabel: planLabel(currentPlan),
    plan: parties.target.user.plan,
    planLabel: planLabel(parties.target.user.plan),
    refusal,
  };
}

type TransferParties = Awaited<ReturnType<typeof transferParties>>;

/** The workspace, its owner (the caller) and the member taking it over. */
async function transferParties(input: { organizationId: string; actorUserId: string; newOwnerMemberId: string }) {
  const organization = await prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { id: true, name: true },
  });
  if (!organization) {
    throw new OwnershipTransferError(404, 'NOT_FOUND', 'That workspace does not exist.');
  }

  const current = await prisma.member.findFirst({
    where: { organizationId: organization.id, userId: input.actorUserId, role: 'owner' },
    select: { id: true, userId: true, user: { select: { email: true, name: true } } },
  });
  if (!current) {
    throw new OwnershipTransferError(403, 'NOT_OWNER', 'Only the owner can hand the workspace to someone else.');
  }

  const target = await prisma.member.findFirst({
    where: { id: input.newOwnerMemberId, organizationId: organization.id },
    select: {
      id: true,
      userId: true,
      role: true,
      user: { select: { email: true, name: true, plan: true, emailVerified: true } },
    },
  });
  if (!target) {
    throw new OwnershipTransferError(404, 'MEMBER_NOT_FOUND', 'That person is not a member of this workspace.');
  }
  if (target.userId === current.userId) {
    throw new OwnershipTransferError(400, 'ALREADY_OWNER', 'You already own this workspace. Choose another member.');
  }
  return { organization, current, target };
}

/** Every refusal that does not depend on the confirmation. */
async function assertTransferable({ organization, target }: TransferParties, now: Date): Promise<void> {
  if (!target.user.emailVerified) {
    throw new OwnershipTransferError(409, 'EMAIL_NOT_VERIFIED', `${target.user.email} has not confirmed their email address yet, so the workspace cannot be handed to them.`);
  }

  const billed = await prisma.subscription.findFirst({
    where: {
      organizationId: organization.id,
      status: { in: [...LIVE_STATUSES] },
      provider: { in: [...BILLED_PROVIDERS] },
    },
    select: { id: true },
  });
  if (billed) {
    // The subscription is the current owner's, paid through this workspace, so
    // it cannot follow the workspace to someone else's account. The refusal
    // names both ways through, because "cancel it" alone leaves the owner
    // wondering whether the workspace goes unpaid in between.
    throw new OwnershipTransferError(
      409,
      'SUBSCRIPTION_STILL_ACTIVE',
      "This workspace's plan is paid through a subscription on your account, and a subscription cannot move to someone else's account. Either cancel it on the Billing page, transfer the workspace once the paid period has ended, and the new owner then subscribes on their own account; or contact support to move the subscription to them without a gap.",
      { billingUrl: '/billing', supportUrl: '/support' },
    );
  }

  await assertWithinNewOwnersLimits(target.userId, organization.id, target.user.plan, now);
}

export async function transferOwnership(input: TransferInput): Promise<TransferResult> {
  const now = input.now ?? new Date();

  const { totalHits } = await attempts
    .incrementWithWindow(input.actorUserId, now.getTime() + ATTEMPT_WINDOW_MS)
    .catch(() => ({ totalHits: 0 }));
  if (totalHits > ATTEMPT_LIMIT) {
    throw new OwnershipTransferError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Wait 15 minutes and try again.');
  }

  const parties = await transferParties(input);
  const { organization, current, target } = parties;

  await confirmIdentity(input.actorUserId, input.password, input.code);
  await assertTransferable(parties, now);

  const plan = target.user.plan;

  await prisma.$transaction(async (tx) => {
    // The same lock the quota checks take, so a transfer and a plan write on
    // this workspace cannot interleave.
    await tx.$queryRaw`SELECT id FROM "organization" WHERE id = ${organization.id} FOR UPDATE`;
    const stillOwner = await tx.member.findFirst({ where: { id: current.id, role: 'owner' }, select: { id: true } });
    const stillMember = await tx.member.findFirst({ where: { id: target.id, organizationId: organization.id }, select: { id: true } });
    if (!stillOwner || !stillMember) {
      throw new OwnershipTransferError(409, 'TEAM_CHANGED', 'The team changed while you were confirming. Reload the page and try again.');
    }
    await recordAuditEvent(
      {
        organizationId: organization.id,
        actorUserId: current.userId,
        action: 'OWNERSHIP_TRANSFERRED',
        targetType: 'member',
        targetId: target.id,
        detail: {
          from: { userId: current.userId, email: current.user.email, newRole: 'admin' },
          to: { userId: target.userId, email: target.user.email, previousRole: target.role },
          plan,
          confirmedWith: input.password ? 'password' : 'two-step code',
        },
        ipAddress: input.ipAddress,
        requestId: input.requestId,
      },
      tx,
    );
    await tx.member.update({ where: { id: current.id }, data: { role: 'admin' } });
    await tx.member.update({ where: { id: target.id }, data: { role: 'owner' } });
    // The workspace's shadow plan and its unbilled entitlement row follow the
    // account that now holds it, as setOrganizationPlan keeps them.
    await tx.organization.update({ where: { id: organization.id }, data: { plan } });
    await tx.subscription.updateMany({
      where: { organizationId: organization.id, provider: 'NONE' },
      data: { userId: target.userId, plan },
    });
  });

  const membersUrl = `${env.APP_URL.replace(/\/+$/, '')}/settings/members`;
  const previousOwnerName = current.user.name?.trim() || current.user.email;
  const newOwnerName = target.user.name?.trim() || target.user.email;
  const shared = { workspaceName: organization.name, previousOwnerName, newOwnerName, planLabel: planLabel(plan), membersUrl };
  const key = `ownership:${organization.id}:${now.getTime()}`;
  queueEmail(ownershipTransferredEmail({ ...shared, recipient: 'new-owner' }), target.user.email, `${key}:new`);
  queueEmail(ownershipTransferredEmail({ ...shared, recipient: 'previous-owner' }), current.user.email, `${key}:previous`);

  return {
    organizationId: organization.id,
    newOwner: { memberId: target.id, userId: target.userId, email: target.user.email, name: newOwnerName },
    previousOwner: { memberId: current.id, userId: current.userId, email: current.user.email, role: 'admin' },
    plan,
    planLabel: planLabel(plan),
  };
}

/**
 * The new owner's account, with this workspace added to it.
 *
 * Counted the way the quotas count (entitlement.service.ts): workspaces the
 * account owns, and clients and active domains across all of them.
 */
export async function assertWithinNewOwnersLimits(
  newOwnerUserId: string,
  organizationId: string,
  plan: PlanTier,
  now = new Date(),
): Promise<void> {
  const definition = planCatalog[plan];
  const label = planLabel(plan);

  const allowance = await workspaceAllowanceFor(newOwnerUserId);
  if (allowance.used + 1 > allowance.maxWorkspaces) {
    throw limitRefusal('workspace', label, allowance.maxWorkspaces, allowance.used + 1);
  }

  const owned = await prisma.member.findMany({
    where: { userId: newOwnerUserId, role: 'owner' },
    select: { organizationId: true },
    distinct: ['organizationId'],
  });
  const scope = [...new Set([...owned.map((row) => row.organizationId), organizationId])];

  const clients = await prisma.client.count({ where: { organizationId: { in: scope } } });
  if (clients > definition.maxClients) {
    throw limitRefusal('client', label, definition.maxClients, clients);
  }

  const domains = await countCountedDomainsIn(scope, definition.activeDomainWindowDays, now);
  if (domains > definition.maxActiveDomains) {
    throw limitRefusal('activeDomain', label, definition.maxActiveDomains, domains);
  }
}

const quotaNoun: Record<'workspace' | 'client' | 'activeDomain', [string, string]> = {
  workspace: ['workspace', 'workspaces'],
  client: ['client', 'clients'],
  activeDomain: ['active domain', 'active domains'],
};

function limitRefusal(quota: 'workspace' | 'client' | 'activeDomain', label: string, limit: number, wouldHave: number): OwnershipTransferError {
  const [one, many] = quotaNoun[quota];
  const noun = (count: number) => `${count} ${count === 1 ? one : many}`;
  return new OwnershipTransferError(
    402,
    'NEW_OWNER_LIMIT_REACHED',
    `Their account is on ${label}, which includes ${noun(limit)}. With this workspace it would have ${noun(wouldHave)}. They need to upgrade, or free some up, before taking it over.`,
    { quota, limit, wouldHave, planLabel: label },
  );
}

/**
 * The owner proves it is them: their password, or a code from their
 * authenticator. A code is spent once (totp-replay.ts), as at sign-in.
 */
async function confirmIdentity(userId: string, password: string | undefined, code: string | undefined): Promise<void> {
  if (typeof password === 'string' && password !== '') {
    const account = await prisma.account.findFirst({
      where: { userId, providerId: 'credential', password: { not: null } },
      select: { password: true },
    });
    if (!account?.password) {
      throw new OwnershipTransferError(400, 'NO_PASSWORD', 'Your account has no password. Confirm with a code from your authenticator app instead.');
    }
    const context = await auth.$context;
    const valid = await context.password.verify({ hash: account.password, password });
    if (!valid) {
      throw new OwnershipTransferError(401, 'CONFIRMATION_FAILED', 'That password is not right.');
    }
    return;
  }

  const claimable = claimableCode(code);
  if (claimable) {
    const twoFactor = await prisma.twoFactor.findUnique({
      where: { userId },
      select: { secret: true, verified: true, user: { select: { twoFactorEnabled: true } } },
    });
    if (!twoFactor || !twoFactor.user.twoFactorEnabled || twoFactor.verified === false) {
      throw new OwnershipTransferError(400, 'NO_TWO_FACTOR', 'Two-step verification is not on for your account. Confirm with your password instead.');
    }
    if (!(await claimTotpCode(userId, claimable))) {
      throw new OwnershipTransferError(401, 'TOTP_CODE_REUSED', 'That code was already used. Wait for the next code in your authenticator app.');
    }
    const context = await auth.$context;
    const secret = await symmetricDecrypt({ key: context.secretConfig, data: twoFactor.secret });
    if (!verifyTotp(totpKey(secret), claimable, Date.now())) {
      await releaseTotpCode(userId, claimable);
      throw new OwnershipTransferError(401, 'CONFIRMATION_FAILED', 'That code is not right. Check the time on your device and try the next one.');
    }
    return;
  }

  throw new OwnershipTransferError(400, 'CONFIRMATION_REQUIRED', 'Confirm with your password or a code from your authenticator app.');
}
