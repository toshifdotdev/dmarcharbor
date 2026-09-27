import { auth } from '../auth/auth.config.js';
import { prisma } from '../database/prisma.js';

const userAgentLimit = 200;

export interface SessionView {
  id: string;
  current: boolean;
  createdAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

function truncate(value: string | null | undefined, limit: number): string | null {
  if (!value) {
    return null;
  }
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

export async function listUserSessions(userId: string, currentSessionId: string | undefined): Promise<SessionView[]> {
  const sessions = await prisma.session.findMany({
    where: { userId },
    select: {
      id: true,
      createdAt: true,
      expiresAt: true,
      ipAddress: true,
      userAgent: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  return sessions.map((session) => ({
    id: session.id,
    current: session.id === currentSessionId,
    createdAt: session.createdAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    ipAddress: session.ipAddress,
    userAgent: truncate(session.userAgent, userAgentLimit),
  }));
}

export type RevokeSessionOutcome = 'revoked' | 'not_found' | 'is_current';

export async function revokeUserSession(
  userId: string,
  sessionId: string,
  currentSessionId: string | undefined,
  headers: Headers,
): Promise<RevokeSessionOutcome> {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId },
    select: { id: true, token: true, ipAddress: true },
  });

  if (!session) {
    return 'not_found';
  }

  if (session.id === currentSessionId) {
    return 'is_current';
  }

  await auth.api.revokeSession({ headers, body: { token: session.token } });

  return 'revoked';
}

export async function revokeOtherSessions(headers: Headers): Promise<void> {
  await auth.api.revokeOtherSessions({ headers });
}

export async function revokeAllSessions(headers: Headers): Promise<void> {
  await auth.api.revokeSessions({ headers });
}

export async function countActiveSessions(userId: string): Promise<number> {
  return prisma.session.count({ where: { userId } });
}
