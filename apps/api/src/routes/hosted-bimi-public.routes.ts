import { Router, type Request, type Response } from 'express';
import { bimiAssetForPublicPath } from '../services/hosted-dns/hosted-bimi.service.js';
import { bimiPublicRateLimiter } from '../middleware/rate-limit.middleware.js';

/**
 * The public bytes a published BIMI record points at.
 *
 * Mounted at the host root rather than under /api, like `wellKnownRouter`: the
 * URL is baked into a customer's DNS, so it has to be short, stable and free of
 * anything that looks like an API version.
 *
 * Four rules hold for every response here:
 *
 * 1. The same 404 for everything that is not servable. An unknown token, a
 *    released record, an unknown hash prefix and an expired grace period all
 *    answer "Not found." with no hint of which one it was.
 * 2. No session is read and no cookie is written. This is an unauthenticated
 *    endpoint that mailbox providers call.
 * 3. The content type is explicit and `nosniff` is set, because an SVG served
 *    as anything else is a script execution surface.
 * 4. The CSP is tightened to what an SVG needs and nothing else. helmet's
 *    `default-src 'none'` would block the inline style attributes a Tiny PS
 *    logo uses, so `style-src 'unsafe-inline'` is added and everything else
 *    stays closed.
 */

const svgContentSecurityPolicy = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function notFound(response: Response): void {
  response.status(404).type('text/plain; charset=utf-8').send('Not found.');
}

function baseHeaders(response: Response, contentType: string, length: number): void {
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', String(length));
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', svgContentSecurityPolicy);
  // Mailbox providers fetch rarely and cache; an hour is short enough that a
  // replaced logo appears the same day and long enough to be worth caching.
  response.setHeader('Cache-Control', 'public, max-age=3600');
  // The bytes are fetched by a mail client or a scanner, from another origin,
  // which the strict default would block.
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  response.setHeader('Referrer-Policy', 'no-referrer');
}

export const hostedBimiPublicRouter = Router();

hostedBimiPublicRouter.get(
  '/bimi/:token/:file',
  bimiPublicRateLimiter,
  async (request: Request, response: Response) => {
    const token = String(request.params.token ?? '');
    const file = String(request.params.file ?? '');
    const match = /^([0-9a-f]{12})\.(svg|pem)$/.exec(file);
    if (!match) {
      notFound(response);
      return;
    }

    const asset = await bimiAssetForPublicPath({
      token,
      sha12: match[1]!,
      kind: match[2] === 'svg' ? 'LOGO' : 'CERTIFICATE',
    });
    if (!asset) {
      notFound(response);
      return;
    }

    baseHeaders(response, asset.contentType, asset.bytes.length);
    // HEAD is answered by Express through this handler, and `end` with no body
    // is what makes the Content-Length above correct for it as well.
    response.status(200).end(request.method === 'HEAD' ? undefined : asset.bytes);
  },
);
