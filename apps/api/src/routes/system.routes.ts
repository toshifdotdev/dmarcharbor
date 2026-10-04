import { Router } from 'express';
import { prisma } from '../database/prisma.js';
import { env } from '../config/env.js';
import { listAuditEvents } from '../services/audit.service.js';
import { planCatalogResponse } from '../services/entitlements/entitlement.service.js';
import { alwaysAllowedEntitlements } from '../services/entitlements/plan-catalog.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { paginationQuerySchema } from '../utils/pagination.js';
import { sendError } from '../utils/api-error.js';
import { openApiDocument } from '../openapi.js';
import { capabilities } from '../services/capabilities.service.js';

export const systemRouter = Router();

const readinessTimeoutMs = 3_000;

/**
 * Public capability probe.
 *
 * Read by the marketing and pricing pages before anyone has an account, so it takes
 * no authentication. It answers which sign-in methods exist and which currencies can
 * actually be paid in, which is what stops the pricing page advertising a price the
 * checkout would then refuse.
 */
systemRouter.get('/capabilities', async (_request, response) => {
  response.json(await capabilities());
});

systemRouter.get('/health', (_request, response) => {
  response.json({ status: 'ok', service: 'dmarcharbor-api' });
});

systemRouter.get('/ready', async (_request, response) => {
  const startedAt = Date.now();

  try {
    await Promise.race([
      prisma.$queryRawUnsafe('SELECT 1'),
      new Promise((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Database readiness check timed out.')),
          readinessTimeoutMs,
        );
        timer.unref?.();
      }),
    ]);

    response.json({
      status: 'ready',
      checks: {
        database: { status: 'ok', latencyMs: Date.now() - startedAt },
      },
    });
  } catch (error) {
    response.status(503).json({
      status: 'not_ready',
      checks: {
        database: {
          status: 'error',
          error: error instanceof Error ? error.message : 'Database check failed.',
        },
      },
    });
  }
});

systemRouter.get('/meta', (_request, response) => {
  response.json({
    service: 'dmarcharbor-api',
    environment: env.NODE_ENV,
    retention: {
      reportDays: env.REPORT_RETENTION_DAYS,
      forensicDays: env.FORENSIC_RETENTION_DAYS,
      forensicPiiDays: env.FORENSIC_PII_RETENTION_DAYS,
    },
    alerting: {
      evaluationIntervalMinutes: env.ALERT_EVALUATION_INTERVAL_MINUTES,
      rollupHours: env.ALERT_ROLLUP_HOURS,
      staleDays: env.ALERT_STALE_DAYS,
    },
    schedulerDisabled: env.ALERT_SCHEDULER_DISABLED,
    plans: planCatalogResponse(),
    entitlements: {
      alwaysAllowed: [...alwaysAllowedEntitlements],
      quotas: ['client', 'activeDomain', 'member'],
    },
  });
});

systemRouter.get('/docs/openapi.json', (_request, response) => {
  response.json(openApiDocument);
});

systemRouter.get(
  '/workspaces/:organizationId/audit-events',
  requireSession,
  requireOrganizationPermission('report', 'read'),
  async (request, response) => {
    const query = paginationQuerySchema.safeParse(request.query);
    const domainId = typeof request.query.domainId === 'string' ? request.query.domainId : undefined;
    const action = typeof request.query.action === 'string' ? request.query.action : undefined;

    // Awaited rather than floated. A floating promise with no rejection handler
    // is fatal: Node treats an unhandled rejection as an uncaught exception and
    // exits the process, so one transient database error on this one read route
    // would take down the API for every tenant. Errors are mapped to the same
    // envelope every other route uses so a failure is a 500 the caller can see
    // rather than a dropped connection.
    try {
      const events = await listAuditEvents(response.locals.organizationId, {
        domainId,
        action,
        limit: query.success ? query.data.limit : undefined,
      });
      response.json({ items: events });
    } catch (error) {
      // Logged, not returned. A driver error carries the host, port, database
      // name and sometimes the failing statement, which is exactly the detail
      // the production guards in config/env.ts exist to keep off the wire.
      console.error(
        `[audit-events] ${response.locals.requestId ?? 'no-request-id'} read failed:`,
        error instanceof Error ? error.message : error,
      );
      sendError(response, 500, 'The audit trail could not be read.');
    }
  },
);
