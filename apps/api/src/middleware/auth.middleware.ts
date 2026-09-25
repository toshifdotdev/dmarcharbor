import { fromNodeHeaders } from 'better-auth/node';
import type { NextFunction, Request, Response } from 'express';
import { auth } from '../auth/auth.config.js';

export async function requireSession(request: Request, response: Response, next: NextFunction): Promise<void> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });

  if (!session) {
    response.status(401).json({ error: { message: 'Authentication required.' } });
    return;
  }

  response.locals.session = session;
  next();
}
