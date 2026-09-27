import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';
import { auth } from '../auth/auth.config.js';
import { prisma } from '../database/prisma.js';
import { resourceIdSchema } from '../models/client.model.js';
import { entitlementOverrideSchema, planChangeSchema } from '../models/entitlement.model.js';
import { recordAuditEvent } from '../services/audit.service.js';
import {
  planCatalogResponse,
  removeOverride,
  resolveEntitlements,
  setOrganizationPlan,
  setOverride,
} from '../services/entitlements/entitlement.service.js';
import { planCatalog, planLabel } from '../services/entitlements/plan-catalog.js';

async function canManageBilling(request: Request, organizationId: string): Promise<boolean> {
  try {
    const permission = await auth.api.hasPermission({
      headers: fromNodeHeaders(request.headers),
      body: { organizationId, permissions: { billing: ['update'] } },
    });
    return permission.success;
  } catch {
    return false;
  }
}

export async function listEntitlementsController(request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  const entitlements = await resolveEntitlements(organizationId);

  if (await canManageBilling(request, organizationId)) {
    response.json(entitlements);
    return;
  }

  response.json({
    ...entitlements,
    overrides: entitlements.overrides.map((override) => ({
      entitlement: override.entitlement,
      enabled: override.enabled,
      expiresAt: override.expiresAt,
    })),
  });
}

export async function listPlanCatalogController(_request: Request, response: Response): Promise<void> {
  response.json({ plans: planCatalogResponse(), order: Object.keys(planCatalog) });
}

export async function changePlanController(request: Request, response: Response): Promise<void> {
  const body = planChangeSchema.safeParse(request.body);

  if (!body.success) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'A valid plan and optional status are required.' },
    });
    return;
  }

  const organizationId = response.locals.organizationId;
  const before = await resolveEntitlements(organizationId);

  await setOrganizationPlan(organizationId, body.data.plan, {
    ...(body.data.status ? { status: body.data.status } : {}),
    ...(body.data.currentPeriodEnd !== undefined
      ? { currentPeriodEnd: body.data.currentPeriodEnd ? new Date(body.data.currentPeriodEnd) : null }
      : {}),
  });

  await recordAuditEvent({
    organizationId,
    actorUserId: response.locals.session?.user?.id,
    action: 'PLAN_CHANGED',
    targetType: 'organization',
    targetId: organizationId,
    detail: {
      from: before.plan,
      to: body.data.plan,
      fromLabel: before.label,
      toLabel: planLabel(body.data.plan),
      reason: body.data.reason ?? null,
    },
    requestId: response.locals.requestId,
  });

  response.json(await resolveEntitlements(organizationId));
}

export async function setOverrideController(request: Request, response: Response): Promise<void> {
  const body = entitlementOverrideSchema.safeParse(request.body);

  if (!body.success) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: body.error.issues[0]?.message ?? 'An entitlement, enabled flag and reason are required.',
      },
    });
    return;
  }

  const organizationId = response.locals.organizationId;

  await setOverride(organizationId, {
    entitlement: body.data.entitlement,
    enabled: body.data.enabled,
    reason: body.data.reason,
    expiresAt: body.data.expiresAt ? new Date(body.data.expiresAt) : null,
    createdById: response.locals.session?.user?.id,
  });

  await recordAuditEvent({
    organizationId,
    actorUserId: response.locals.session?.user?.id,
    action: 'ENTITLEMENT_OVERRIDE_SET',
    targetType: 'organization',
    targetId: organizationId,
    detail: {
      entitlement: body.data.entitlement,
      enabled: body.data.enabled,
      reason: body.data.reason,
      expiresAt: body.data.expiresAt ?? null,
    },
    requestId: response.locals.requestId,
  });

  response.json(await resolveEntitlements(organizationId));
}

export async function removeOverrideController(request: Request, response: Response): Promise<void> {
  const entitlement = resourceIdSchema.safeParse(request.params.entitlement);

  if (!entitlement.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid entitlement key is required.' } });
    return;
  }

  const organizationId = response.locals.organizationId;
  const removed = await removeOverride(organizationId, entitlement.data);

  if (removed) {
    await recordAuditEvent({
      organizationId,
    actorUserId: response.locals.session?.user?.id,
      action: 'ENTITLEMENT_OVERRIDE_REMOVED',
      targetType: 'organization',
      targetId: organizationId,
      detail: { entitlement: entitlement.data },
      requestId: response.locals.requestId,
    });
  }

  response.json(await resolveEntitlements(organizationId));
}

export async function planOverviewController(_request: Request, response: Response): Promise<void> {
  const organizationId = response.locals.organizationId;
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { plan: true },
  });

  response.json({
    currentPlan: organization?.plan ?? 'MOORING',
    plans: planCatalogResponse(),
  });
}
