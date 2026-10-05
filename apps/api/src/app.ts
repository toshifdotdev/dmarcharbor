import { toNodeHandler } from 'better-auth/node';
import { authOptionsRouter } from './routes/auth.routes.js';
import cors from 'cors';
import express from 'express';
import { auth } from './auth/auth.config.js';
import { env } from './config/env.js';
import { alertRouter } from './routes/alert.routes.js';
import { onboardingRouter, publicReportRouter } from './routes/onboarding.routes.js';
import { scanRouter } from './routes/scan.routes.js';
import { clientRouter } from './routes/client.routes.js';
import { entitlementRouter } from './routes/entitlement.routes.js';
import { exportRouter } from './routes/export.routes.js';
import { erasureRouter } from './routes/erasure.routes.js';
import { apiV1Router } from './routes/api-v1.routes.js';
import { apiKeyRouter } from './routes/api-key.routes.js';
import { webhookRouter } from './routes/webhook.routes.js';
import { portalRouter } from './routes/portal.routes.js';
import { brandingRouter } from './routes/branding.routes.js';
import { reportInboxRouter } from './routes/report-inbox.routes.js';
import { slackRouter } from './routes/slack.routes.js';
import { dpaRouter, wellKnownRouter } from './routes/dpa.routes.js';
import { ssoRouter } from './routes/sso.routes.js';
import { billingRouter } from './routes/billing.routes.js';
import { refundRouter } from './routes/refund.routes.js';
import { trustRouter } from './routes/trust.routes.js';
import { portalErrorHandler } from './middleware/portal.middleware.js';
import { domainScanRouter } from './routes/domain-scan.routes.js';
import { forensicRouter } from './routes/forensic.routes.js';
import { inboundReportRouter } from './routes/inbound-report.routes.js';
import { notificationRouter } from './routes/notification.routes.js';
import { reportRouter } from './routes/report.routes.js';
import { sessionRouter } from './routes/session.routes.js';
import { sessionManagementRouter } from './routes/session-management.routes.js';
import { systemRouter } from './routes/system.routes.js';
import { requestContext } from './middleware/request-context.middleware.js';
import { createAuthRateLimiter, createWorkspaceRateLimiter } from './middleware/rate-limit.middleware.js';
import { sendError } from './utils/api-error.js';
import helmet from 'helmet';

export function createApp(): express.Express {
  const app = express();

  /**
   * Tell Express how many proxies sit in front of this process.
   *
   * Without it, `request.ip` is the address of the nearest proxy, so every
   * IP-keyed rate limiter collapses into a single bucket for the whole service
   * the moment this is deployed behind a load balancer, an ingress or a CDN.
   * One tenant exhausting that bucket then denies the service to every other
   * tenant, and audit records show the proxy's address rather than the
   * customer's.
   *
   * Defaults to zero, which trusts nothing. A wrong non-zero value is worse
   * than no setting at all, because a client can then forge `X-Forwarded-For`
   * and walk straight past every limit, so it is explicit and never guessed.
   */
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  if (env.NODE_ENV === 'production' && env.TRUST_PROXY_HOPS === 0) {
    console.warn(
      '[config] TRUST_PROXY_HOPS is 0 in production. If this service sits behind a load balancer or ingress, ' +
        'every IP-keyed rate limit will share one bucket across all tenants until it is set to the real hop count.',
    );
  }

  /**
   * Response headers.
   *
   * `crossOriginResourcePolicy` is relaxed to cross-origin because the browser
   * application is served from a different origin to this API and reads these
   * responses with credentials; the strict default would block them. The
   * cross-origin embedding policy is disabled for the same reason: it breaks
   * loading assets across origins, which a CSP here cannot meaningfully police
   * since this service returns JSON and no HTML.
   *
   * Note this protects API responses. The dashboard HTML is served by apps/web,
   * which sets no security headers of its own and needs the same treatment
   * there, most importantly a CSP, which is the one header that only matters on
   * a page that renders markup.
   */
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'none'"],
          'form-action': ["'none'"],
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
      frameguard: { action: 'deny' },
    }),
  );

  app.use(requestContext);
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));
  // Ahead of the Better Auth handler, which owns /api/auth/* and would otherwise
  // answer this itself. Read by the sign-in page, so it cannot require a session.
  app.use('/api/auth', authOptionsRouter);

  // Ahead of the Better Auth handler so it covers every auth path, not only the
  // ones this codebase registers. There is no MFA, so this is the only brake
  // on credential stuffing.
  app.use('/api/auth', createAuthRateLimiter());

  app.all('/api/auth/*splat', toNodeHandler(auth));
  app.use('/api', systemRouter);
  app.use('/api', inboundReportRouter);
  app.use('/api', publicReportRouter);
  app.use('/api', reportRouter);
  app.use('/api', forensicRouter);
  app.use('/api', alertRouter);
  app.use('/api', onboardingRouter);
  app.use('/api', notificationRouter);
  // The raw body is retained alongside the parsed one because both payment
  // providers sign the exact bytes they sent. Re-serialising the parsed object
  // produces different bytes, so a signature verified against it fails
  // intermittently, which is the classic "webhook works sometimes" bug.
  app.use(
    express.json({
      limit: '10kb',
      verify: (request, _response, buffer) => {
        (request as unknown as { rawBody?: string }).rawBody = buffer.toString('utf8');
      },
    }),
  );
  app.use('/api', sessionRouter);
  app.use('/api', sessionManagementRouter);

  /**
   * A brake on the authenticated surface, which had no limit of any kind.
   *
   * Mounted after the routers that are deliberately public (report shares, inbound
   * reports, the compliance verifier) and after the session router that establishes
   * workspace context, so this covers the routes that cost real work: exports,
   * erasures, packs, scans, billing and webhooks. Each of those already has its own
   * narrower limiter where one made sense; this is the backstop that used to be absent.
   */
  app.use('/api', createWorkspaceRateLimiter());

  app.use('/api', clientRouter);
  app.use('/api', entitlementRouter);
  app.use('/api', exportRouter);
  app.use('/api', erasureRouter);
  app.use('/api', apiKeyRouter);
  app.use('/api', webhookRouter);
  app.use('/api', portalRouter);
  app.use('/api', brandingRouter);
  app.use('/api', billingRouter);
  app.use('/api', refundRouter);
  app.use('/api', trustRouter);
  app.use('/api', reportInboxRouter);
app.use('/api', slackRouter);
app.use('/api', dpaRouter);
// RFC 9116 requires this at the host root, and a header-only document should not
// depend on a JavaScript runtime starting up to be found.
app.use(wellKnownRouter);
  app.use('/api', ssoRouter);
  app.use(portalErrorHandler);
  app.use('/api/v1', apiV1Router);
  app.use('/api', domainScanRouter);
  app.use('/api', scanRouter);

  app.use('/api', (_request, response) => {
    sendError(response, 404, 'The requested endpoint does not exist.');
  });

  return app;
}
