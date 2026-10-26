import { fromNodeHeaders } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';
import { auth } from '../auth/auth.config.js';

export async function requireSession(request: Request, response: Response, next: NextFunction): Promise<void> {
  // The workspace MFA gate may already have read the session to decide whether
  // to let the request through. Re-reading it here would double the auth work
  // on every gated request, so the gate stores its answer (including null) and
  // this reuses it.
  const cached = response.locals.sessionLookup;
  const session =
    cached !== undefined
      ? (cached as Awaited<ReturnType<typeof auth.api.getSession>>)
      : await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });

  if (!session) {
    response.status(401).json({ error: { message: 'Authentication required.' } });
    return;
  }

  response.locals.session = session;
  next();
}
