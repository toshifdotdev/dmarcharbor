import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';

/**
 * The server side operations a support engineer performs.
 *
 * These change a plan or grant an entitlement outside a paid flow, so they are
 * authorised by a deployment secret rather than by a workspace role. A plan is
 * what money buys, and the ability to grant one must not sit in the same role
 * table as the ability to read a client's domains: an owner who can already see
 * every domain in the workspace has no business also being able to move the
 * workspace onto a paid tier for nothing.
 *
 * Compared in constant time, and refused outright when the key is unset. An
 * unset key leaves the operations closed rather than open, so a deployment that
 * never configured one cannot be written into by accident.
 */
/** True when the request carries the staff key. False when it is unset or wrong. */
export function presentsStaffKey(request: Request): boolean {
  const expected = env.STAFF_API_KEY;
  if (!expected) {
    return false;
  }

  const header = request.get('authorization') ?? '';
  const presented = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');

  // timingSafeEqual throws on a length mismatch, so the lengths are compared
  // first. That leaks only the length of the key, which is not a secret worth
  // protecting, and a plain string compare would leak the position of the first
  // differing byte.
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireStaff(request: Request, response: Response, next: NextFunction): void {
  if (!env.STAFF_API_KEY) {
    response.status(404).json({
      error: { code: 'NOT_FOUND', message: 'No such endpoint.' },
    });
    return;
  }

  if (!presentsStaffKey(request)) {
    response.status(403).json({
      error: { code: 'FORBIDDEN', message: 'This operation requires a staff credential.' },
    });
    return;
  }

  // These routes are all workspace scoped, and the controllers read the
  // workspace from the same place the permission middleware used to populate
  // it. Set here so changing the authorisation did not also mean rewriting
  // every controller.
  if (typeof request.params.organizationId === 'string') {
    response.locals.organizationId = request.params.organizationId;
  }

  next();
}
