import { Router } from 'express';
import { authProviderAvailability } from '../auth/providers.js';

/**
 * Auth-adjacent routes that are ours rather than Better Auth's.
 *
 * Mounted at /api/auth ahead of the Better Auth handler, because Better Auth owns
 * /api/auth/* and would otherwise answer anything under it.
 */
export const authOptionsRouter = Router();

/**
 * Which sign-in methods are available on this deployment.
 *
 * Unauthenticated by necessity: the only screen that reads this is the sign-in
 * page, which nobody can reach while signed in. Requiring a session would make
 * it useless for its only purpose.
 *
 * Returns booleans only. No client id, no authorisation url, nothing that could
 * be turned into a token.
 */
authOptionsRouter.get('/providers', (_request, response) => {
  response.json(authProviderAvailability());
});