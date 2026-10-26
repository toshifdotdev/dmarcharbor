import { auth } from '../auth/auth.config.js';
import { prisma } from '../database/prisma.js';

export interface MySecurity {
  twoFactorEnabled: boolean;
  hasPassword: boolean;
  sessionAuthMethod: 'sso' | null;
  backupCodesRemaining: number | null;
  requiredBy: Array<{ id: string; name: string }>;
}

export interface WorkspaceSecurity {
  requireMfa: boolean;
  changedAt: string | null;
  membersWithout: number;
}

/**
 * What the account-security screen needs, in one read.
 *
 * Backup codes are encrypted at rest, so the count comes from Better Auth's
 * server-only viewBackupCodes rather than from a column. The codes themselves
 * are never returned here - only how many are left.
 */
export async function mySecurity(userId: string, sessionAuthMethod: string | null | undefined): Promise<MySecurity> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      twoFactorEnabled: true,
      accounts: {
        where: { providerId: 'credential' },
        select: { password: true },
      },
      members: {
        where: { role: { not: 'portal' }, organization: { requireMfa: true } },
        select: { organization: { select: { id: true, name: true } } },
        orderBy: { organization: { name: 'asc' } },
      },
    },
  });

  let backupCodesRemaining: number | null = null;
  if (user?.twoFactorEnabled) {
    try {
      const viewed = await auth.api.viewBackupCodes({ body: { userId } });
      backupCodesRemaining = viewed.backupCodes.length;
    } catch {
      // The account is still protected; the count is the only thing missing.
      backupCodesRemaining = null;
    }
  }

  return {
    twoFactorEnabled: user?.twoFactorEnabled ?? false,
    hasPassword: Boolean(user?.accounts.some((account) => Boolean(account.password))),
    sessionAuthMethod: sessionAuthMethod === 'sso' ? 'sso' : null,
    backupCodesRemaining,
    requiredBy: (user?.members ?? []).map((member) => member.organization),
  };
}

export async function countMembersWithoutMfa(organizationId: string): Promise<number> {
  return prisma.member.count({
    where: {
      organizationId,
      role: { not: 'portal' },
      user: { twoFactorEnabled: false },
    },
  });
}

export async function workspaceSecurity(organizationId: string): Promise<WorkspaceSecurity> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { requireMfa: true, requireMfaChangedAt: true },
  });

  return {
    requireMfa: organization?.requireMfa ?? false,
    changedAt: organization?.requireMfaChangedAt?.toISOString() ?? null,
    membersWithout: await countMembersWithoutMfa(organizationId),
  };
}

/**
 * Removes every trace of two-step verification for one account.
 *
 * The sessions go too. A session created while the account had a second factor
 * is not evidence that the next request should be trusted without one, and the
 * owner reset is explicitly "signs the member out everywhere". Trust-device
 * rows are deleted as well; leaving one would let a device skip the next
 * challenge after the account is set up again.
 */
export async function resetTwoFactorForUser(userId: string): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    await transaction.twoFactor.deleteMany({ where: { userId } });
    await transaction.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: false },
    });
    await transaction.session.deleteMany({ where: { userId } });
    await transaction.verification.deleteMany({
      where: { identifier: { startsWith: 'trust-device-' }, value: userId },
    });
  });
}
