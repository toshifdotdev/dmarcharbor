import { Router, type Request, type Response } from 'express';
import { mtaStsPolicyForHostname } from '../services/hosted-dns/hosted-mta-sts.service.js';
import { mtaStsPublicRateLimiter } from '../middleware/rate-limit.middleware.js';

/**
 * The MTA-STS policy a customer's `mta-sts.<domain>` resolves to.
 *
 * Mounted at the host root, like the well-known document and the BIMI bytes:
 * RFC 8461 §3.3 fixes the path, so it cannot live under /api.
 *
 * The domain comes from the Host header, never from the path. That is the whole
 * security model of the route: a caller can only read the policy for a hostname
 * that already points at us, and cannot enumerate customers by walking a path.
 *
 * Four rules, the same ones the BIMI route keeps:
 *
 * 1. The same 404 for everything that is not servable — an unknown host, a
 *    released row, a pending row without a certificate, a releasing row past
 *    its window.
 * 2. No session is read and no cookie is set.
 * 3. `Cache-Control: no-store`, because RFC 8461 §3.3 says senders must not use
 *    HTTP caching; a cached `enforce` policy is one a release cannot recall.
 * 4. A 200 with the body, never a redirect: a sender treats a redirect as a
 *    failure to fetch the policy.
 */

function notFound(response: Response): void {
  response.status(404).type('text/plain; charset=utf-8').send('Not found.');
}

export const hostedMtaStsPublicRouter = Router();

hostedMtaStsPublicRouter.get(
  '/.well-known/mta-sts.txt',
  mtaStsPublicRateLimiter,
  async (request: Request, response: Response) => {
    const body = await mtaStsPolicyForHostname(request.headers.host ?? '');
    if (body === null) {
      notFound(response);
      return;
    }

    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Content-Length', String(Buffer.byteLength(body)));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.status(200).end(body);
  },
);
