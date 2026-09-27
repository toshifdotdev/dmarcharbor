import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';
import { resourceIdSchema } from '../models/client.model.js';
import { recordAuditEvent } from '../services/audit.service.js';
import {
  listUserSessions,
  revokeAllSessions,
  revokeOtherSessions,
  revokeUserSession,
} from '../services/session.service.js';

function currentSessionId(response: Response): string | undefined {
  return response.locals.session?.session?.id;
}

function actorId(response: Response): string | undefined {
  return response.locals.session?.user?.id;
}

export async function listSessionsController(_request: Request, response: Response): Promise<void> {
  const userId = actorId(response);
  if (!userId) {
    response.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication is required.' } });
    return;
  }

  response.json({ sessions: await listUserSessions(userId, currentSessionId(response)) });
}

export async function revokeSessionController(request: Request, response: Response): Promise<void> {
  const sessionId = resourceIdSchema.safeParse(request.params.sessionId);
  if (!sessionId.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid session identifier is required.' } });
    return;
  }

  const userId = actorId(response);
  if (!userId) {
    response.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication is required.' } });
    return;
  }

  const outcome = await revokeUserSession(
    userId,
    sessionId.data,
    currentSessionId(response),
    fromNodeHeaders(request.headers),
  );

  if (outcome === 'not_found') {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found.' } });
    return;
  }

  if (outcome === 'is_current') {
    response.status(409).json({
      error: {
        code: 'CONFLICT',
        message: 'This is the session you are currently using. Use sign out to end it.',
      },
    });
    return;
  }

  await recordAuditEvent({
    actorUserId: userId,
    action: 'SESSION_REVOKED',
    targetType: 'session',
    targetId: sessionId.data,
    requestId: response.locals.requestId,
  });

  response.status(204).send();
}

export async function revokeOtherSessionsController(request: Request, response: Response): Promise<void> {
  const userId = actorId(response);
  if (!userId) {
    response.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication is required.' } });
    return;
  }

  await revokeOtherSessions(fromNodeHeaders(request.headers));

  await recordAuditEvent({
    actorUserId: userId,
    action: 'SESSIONS_REVOKED_OTHERS',
    targetType: 'user',
    targetId: userId,
    requestId: response.locals.requestId,
  });

  const remaining = await listUserSessions(userId, currentSessionId(response));
  response.json({ remaining: remaining.length });
}

export async function revokeAllSessionsController(request: Request, response: Response): Promise<void> {
  const userId = actorId(response);
  if (!userId) {
    response.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication is required.' } });
    return;
  }

  await revokeAllSessions(fromNodeHeaders(request.headers));

  await recordAuditEvent({
    actorUserId: userId,
    action: 'SESSIONS_REVOKED_ALL',
    targetType: 'user',
    targetId: userId,
    requestId: response.locals.requestId,
  });

  response.status(204).send();
}

