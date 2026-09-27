import { Router } from 'express';
import { prisma } from '../database/prisma.js';
import { env } from '../config/env.js';
import { listAuditEvents } from '../services/audit.service.js';
import { planCatalogResponse } from '../services/entitlements/entitlement.service.js';
import { alwaysAllowedEntitlements } from '../services/entitlements/plan-catalog.js';
import { requireSession } from '../middleware/auth.middleware.js';
import { requireOrganizationPermission } from '../middleware/organization-permission.middleware.js';
import { paginationQuerySchema } from '../utils/pagination.js';
import { openApiDocument } from '../openapi.js';

export const systemRouter = Router();

const readinessTimeoutMs = 3_000;

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
  (request, response) => {
    const query = paginationQuerySchema.safeParse(request.query);
    const domainId = typeof request.query.domainId === 'string' ? request.query.domainId : undefined;
    const action = typeof request.query.action === 'string' ? request.query.action : undefined;

    void listAuditEvents(response.locals.organizationId, {
      domainId,
      action,
      limit: query.success ? query.data.limit : undefined,
    }).then((events) => {
      response.json({ items: events });
    });
  },
);
