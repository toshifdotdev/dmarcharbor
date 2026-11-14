import type { AuditAction } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from '../services/audit.service.js';

/**
 * The audit trail for the organization plugin's membership routes.
 *
 * SECURITY.md promised "role and membership changes" in the audit log, and
 * none were written: the plugin's routes for inviting, withdrawing, accepting,
 * declining, changing a role and removing someone ran with no entry at all.
 *
 * The entries are written from the global after hook rather than the plugin's
 * organizationHooks, for two reasons. A resend never reaches the create hooks
 * (the plugin updates the expiry and returns early), and the remove and role
 * hooks are not told who made the change. The after hook sees the request's
 * session, its body and the answer, and runs only once the change has been
 * made: an answer that is an Error means nothing changed and nothing is
 * written.
 */
export const membershipAuditPaths = new Set([
  '/organization/invite-member',
  '/organization/cancel-invitation',
  '/organization/accept-invitation',
  '/organization/reject-invitation',
  '/organization/update-member-role',
  '/organization/remove-member',
  '/organization/leave',
]);

/**
 * The role a member had before update-member-role ran, keyed on the request
 * body. The before and after hooks see the same body object, and it is
 * dropped with the request.
 */
const previousRoles = new WeakMap<object, string>();

/** Called from the global before hook on update-member-role. */
export async function rememberPreviousRole(body: unknown): Promise<void> {
  if (!body || typeof body !== 'object') return;
  const memberId = (body as { memberId?: unknown }).memberId;
  const organizationId = (body as { organizationId?: unknown }).organizationId;
  if (typeof memberId !== 'string' || memberId === '') return;
  // Scoped to the workspace the request names when it names one, so a member
  // id from another workspace is never even read.
  const member = await prisma.member.findFirst({
    where: { id: memberId, ...(typeof organizationId === 'string' && organizationId ? { organizationId } : {}) },
    select: { role: true },
  });
  if (member) previousRoles.set(body, member.role);
}

interface MembershipHookContext {
  path?: string;
  body?: unknown;
  context: {
    returned?: unknown;
    session?: { user?: { id?: string } } | null;
  };
}

interface InvitationShape {
  id: string;
  email: string;
  role: string;
  organizationId: string;
}

interface MemberShape {
  id: string;
  userId: string;
  organizationId: string;
  role: string;
}

function isInvitation(value: unknown): value is InvitationShape {
  const row = value as Partial<InvitationShape> | null;
  return Boolean(row && typeof row.id === 'string' && typeof row.email === 'string' && typeof row.organizationId === 'string');
}

function isMember(value: unknown): value is MemberShape {
  const row = value as Partial<MemberShape> | null;
  return Boolean(row && typeof row.id === 'string' && typeof row.userId === 'string' && typeof row.organizationId === 'string');
}

async function emailOf(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return user?.email ?? null;
}

/** The entry for one membership request, or null when it changed nothing. */
export async function membershipAuditEntry(ctx: MembershipHookContext): Promise<{
  organizationId: string;
  actorUserId?: string;
  action: AuditAction;
  targetType: 'invitation' | 'member';
  targetId: string;
  detail: Record<string, unknown>;
} | null> {
  const returned = ctx.context.returned;
  if (!ctx.path || !membershipAuditPaths.has(ctx.path) || !returned || returned instanceof Error) {
    return null;
  }
  const actorUserId = ctx.context.session?.user?.id;
  const body = (ctx.body ?? {}) as Record<string, unknown>;

  const invitationEntry = (action: AuditAction, invitation: unknown) =>
    isInvitation(invitation)
      ? {
          organizationId: invitation.organizationId,
          actorUserId,
          action,
          targetType: 'invitation' as const,
          targetId: invitation.id,
          detail: { email: invitation.email, role: invitation.role },
        }
      : null;

  const memberEntry = async (action: AuditAction, member: unknown, extra: Record<string, unknown> = {}) =>
    isMember(member)
      ? {
          organizationId: member.organizationId,
          actorUserId,
          action,
          targetType: 'member' as const,
          targetId: member.id,
          detail: { email: await emailOf(member.userId), userId: member.userId, role: member.role, ...extra },
        }
      : null;

  switch (ctx.path) {
    case '/organization/invite-member':
      return invitationEntry(body.resend === true ? 'INVITATION_RESENT' : 'MEMBER_INVITED', returned);
    case '/organization/cancel-invitation':
      return invitationEntry('INVITATION_CANCELED', returned);
    case '/organization/accept-invitation':
      return invitationEntry('INVITATION_ACCEPTED', (returned as { invitation?: unknown }).invitation);
    case '/organization/reject-invitation':
      return invitationEntry('INVITATION_REJECTED', (returned as { invitation?: unknown }).invitation);
    case '/organization/update-member-role': {
      const previousRole = ctx.body && typeof ctx.body === 'object' ? previousRoles.get(ctx.body) : undefined;
      return memberEntry('MEMBER_ROLE_CHANGED', returned, { previousRole: previousRole ?? null });
    }
    case '/organization/remove-member':
      return memberEntry('MEMBER_REMOVED', (returned as { member?: unknown }).member);
    case '/organization/leave':
      return memberEntry('MEMBER_LEFT', returned);
    default:
      return null;
  }
}

/**
 * Writes the entry. The change has already been made by then, so a failed
 * write is logged rather than turned into an error for a request that
 * succeeded.
 */
export async function recordMembershipAudit(ctx: MembershipHookContext): Promise<void> {
  try {
    const entry = await membershipAuditEntry(ctx);
    if (entry) {
      await recordAuditEvent(entry);
    }
  } catch (error) {
    console.error(`Failed to record the audit entry for ${ctx.path}`, error);
  }
}

/**
 * After an invitation is sent again: the expired ones it replaces are closed.
 *
 * The plugin resends by moving the expiry of an open invitation. An expired
 * one is not open to it, so "Resend" on an expired invitation creates a new
 * invitation and leaves the old row pending for ever, shown as expired beside
 * the new one. Marking the old rows canceled leaves one invitation per person.
 */
export async function closeExpiredInvitationsReplacedBy(ctx: MembershipHookContext, now = new Date()): Promise<void> {
  if (ctx.path !== '/organization/invite-member') return;
  const returned = ctx.context.returned;
  if (!returned || returned instanceof Error || !isInvitation(returned)) return;
  try {
    await prisma.invitation.updateMany({
      where: {
        organizationId: returned.organizationId,
        email: returned.email.toLowerCase(),
        status: 'pending',
        expiresAt: { lte: now },
        id: { not: returned.id },
      },
      data: { status: 'canceled' },
    });
  } catch (error) {
    console.error('Failed to close expired invitations', error);
  }
}
