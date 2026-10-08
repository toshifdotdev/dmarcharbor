import { Router } from 'express';
import { scanController } from '../controllers/scan.controller.js';
import { createScanRateLimiter } from '../middleware/rate-limit.middleware.js';

/**
 * The anonymous domain checker.
 *
 * Two routes share the word "scan" and are not the same thing, which is worth
 * saying out loud because the overlap is not visible from the paths:
 *
 *   POST /scan                (here)        public, unauthenticated, stateless
 *   POST /workspaces/:id/domains/:domainId/scans
 *                                              session, write `Scan` rows, and
 *                                              rewrites `domain.dmarcPolicy`
 *
 * This one does not persist anything, and that is deliberate rather than an
 * omission. It is the homepage's free checker: there is no workspace, no
 * session, and no domain row to attach a result to. Creating a customer's
 * domain record from an anonymous lookup would attach a stranger's scan to a
 * real domain, and creating a throwaway record per anonymous request would
 * fill the table with rows nobody asked to keep.
 *
 * The practical consequence is that `domain.dmarcPolicy` is written ONLY by the
 * workspace route. That is why the domain page has a "run a scan now" control:
 * a domain that has never been scanned through the account has no recorded
 * policy at all, and the only thing that can put one there is that button.
 *
 * The two also report differently, on purpose. This returns whatever
 * `scanDomain` produced, including `status: 'error'` with `score: 0` from a
 * failed lookup; the workspace route stores that as FAILED. A visitor reading a
 * box on a marketing page is being told "this lookup failed", an account
 * reading its own scan history is being told "this scan did not run" - and
 * conflating the two is what made the history claim a measured zero.
 */
export const scanRouter = Router();

scanRouter.post('/scan', createScanRateLimiter(), scanController);
