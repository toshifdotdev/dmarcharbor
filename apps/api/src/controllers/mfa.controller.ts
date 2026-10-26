import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../database/prisma.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { queueAuthEmail } from '../email/email.service.js';
import {
  countMembersWithoutMfa,
  mySecurity,
  resetTwoFactorForUser,
  workspaceSecurity,
} from '../services/mfa.service.js';

interface SessionShape {
  user: { id: string; email?: string; twoFactorEnabled?: boolean };
  session: { authMethod?: string | null };
}

function currentSession(response: Response): SessionShape | null {
  return (response.locals.session as SessionShape | undefined) ?? null;
}

async function memberRole(organizationId: string, userId: string): Promise<string | null> {
  const member = await prisma.member.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true },
  });
  return member?.role ?? null;
}

/** Better Auth stores multiple roles comma-separated; owner is one of them or not. */
function hasOwnerRole(role: string | null): boolean {
  return (role ?? '').split(',').map((value) => value.trim()).includes('owner');
}

const resetReasonSchema = z.object({
  reason: z.string().min(10).max(280),
});

const workspaceMfaSchema = z.object({
  requireMfa: z.boolean(),
});

const securityEmailFooter =
  'If this was not you, reset your password and contact your workspace owner.';

function resetEmail(by: string): string {
  return `Your two-step verification was reset ${by}. Sign in with your password and set it up again.\n\n${securityEmailFooter}`;
}

/** GET /api/me/security - account level, never workspace scoped. */
export async function getMySecurity(_request: Request, response: Response): Promise<void> {
  const session = currentSession(response);
  if (!session) {
    response.status(401).json({ error: { message: 'Authentication required.' } });
    return;
  }

  response.json(await mySecurity(session.user.id, session.session.authMethod));
}

/** POST /api/workspaces/:organizationId/members/:memberId/mfa/reset */
export async function resetMemberMfa(request: Request, response: Response): Promise<void> {
  const session = currentSession(response);
  if (!session) {
    response.status(401).json({ error: { message: 'Authentication required.' } });
    return;
  }

  const organizationId = request.params.organizationId as string;
  const memberId = request.params.memberId as string;

  const role = await memberRole(organizationId, session.user.id);
  if (!hasOwnerRole(role)) {
    response.status(403).json({
      error: {
        code: 'MFA_RESET_OWNER_ONLY',
        message: 'Only the workspace owner can reset two-step verification for another member.',
      },
    });
    return;
  }

  const target = await prisma.member.findFirst({
    where: { id: memberId, organizationId },
    select: {
      id: true,
      userId: true,
      user: { select: { email: true } },
    },
  });

  if (!target) {
    response.status(404).json({ error: { message: 'That member is not in this workspace.' } });
    return;
  }

  if (target.userId === session.user.id) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'You turn off your own two-step verification from Account security, not from the member list.',
      },
    });
    return;
  }

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true },
  });

  await resetTwoFactorForUser(target.userId);

  try {
    await recordAuditEvent({
      organizationId,
      actorUserId: session.user.id,
      action: 'MFA_RESET',
      targetType: 'user',
      targetId: target.userId,
      detail: { by: 'owner' },
    });
  } catch (error) {
    console.error('Failed to record an owner two-step reset', error);
  }

  queueAuthEmail({
    to: target.user.email,
    subject: 'Your two-step verification was reset',
    text: resetEmail(`by an owner of ${organization?.name ?? 'your workspace'}`),
  });

  response.json({ status: true });
}

/** POST /api/staff/users/:userId/mfa/reset */
export async function resetUserMfaAsStaff(request: Request, response: Response): Promise<void> {
  const parsed = resetReasonSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Give a reason between 10 and 280 characters.',
      },
    });
    return;
  }

  const userId = request.params.userId as string;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });

  if (!user) {
    response.status(404).json({ error: { message: 'No such account.' } });
    return;
  }

  await resetTwoFactorForUser(user.id);

  try {
    await recordAuditEvent({
      action: 'MFA_RESET',
      targetType: 'user',
      targetId: user.id,
      detail: { by: 'staff', reason: parsed.data.reason },
    });
  } catch (error) {
    console.error('Failed to record a staff two-step reset', error);
  }

  queueAuthEmail({
    to: user.email,
    subject: 'Your two-step verification was reset',
    text: resetEmail('by DMARC Harbor support'),
  });

  response.json({ status: true });
}

/** GET /api/workspaces/:organizationId/security */
export async function getWorkspaceSecurity(request: Request, response: Response): Promise<void> {
  response.json(await workspaceSecurity(request.params.organizationId as string));
}

/** PUT /api/workspaces/:organizationId/security */
export async function putWorkspaceSecurity(request: Request, response: Response): Promise<void> {
  const session = currentSession(response);
  if (!session) {
    response.status(401).json({ error: { message: 'Authentication required.' } });
    return;
  }

  const parsed = workspaceMfaSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'Send requireMfa as true or false.' },
    });
    return;
  }

  const organizationId = request.params.organizationId as string;
  const role = await memberRole(organizationId, session.user.id);
  if (!hasOwnerRole(role)) {
    response.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'Only the workspace owner can change the two-step verification requirement.',
      },
    });
    return;
  }

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { requireMfa: true },
  });
  if (!organization) {
    response.status(404).json({ error: { message: 'That workspace does not exist.' } });
    return;
  }

  if (parsed.data.requireMfa) {
    const satisfies =
      session.user.twoFactorEnabled === true || session.session.authMethod === 'sso';
    if (!satisfies) {
      response.status(409).json({
        error: {
          code: 'MFA_REQUIRED_FOR_CALLER',
          message:
            'Turn on two-step verification for your own account first, so you do not lock yourself out.',
        },
      });
      return;
    }
  }

  await prisma.organization.update({
    where: { id: organizationId },
    data: {
      requireMfa: parsed.data.requireMfa,
      requireMfaChangedAt: new Date(),
      requireMfaChangedById: session.user.id,
    },
  });

  try {
    await recordAuditEvent({
      organizationId,
      actorUserId: session.user.id,
      action: 'WORKSPACE_MFA_REQUIREMENT_CHANGED',
      targetType: 'organization',
      targetId: organizationId,
      detail: { from: organization.requireMfa, to: parsed.data.requireMfa },
    });
  } catch (error) {
    console.error('Failed to record a two-step requirement change', error);
  }

  response.json({
    requireMfa: parsed.data.requireMfa,
    membersWithout: await countMembersWithoutMfa(organizationId),
  });
}
