import type { Request, Response } from 'express';
import {
  alertEventQuerySchema,
  alertRuleCreateSchema,
  alertRuleUpdateSchema,
  notificationPreferenceSchema,
} from '../models/alert.model.js';
import { resourceIdSchema } from '../models/client.model.js';
import {
  createAlertRule,
  deleteAlertRule,
  listAlertEvents,
  listAlertRules,
  updateAlertRule,
} from '../services/alert.service.js';
import {
  getNotificationPreference,
  updateNotificationPreference,
} from '../services/notification-preference.service.js';

function parseId(value: string | string[] | undefined): string | null {
  const parsed = resourceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function createAlertRuleController(request: Request, response: Response): Promise<void> {
  const body = alertRuleCreateSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: { message: 'A complete alert rule definition is required.' } });
    return;
  }

  const rule = await createAlertRule({
    organizationId: response.locals.organizationId,
    domainId: body.data.domainId,
    createdById: response.locals.session?.user?.id,
    name: body.data.name,
    metric: body.data.metric,
    operator: body.data.operator,
    threshold: body.data.threshold,
    windowMinutes: body.data.windowMinutes ?? 1440,
    cooldownMinutes: body.data.cooldownMinutes ?? 1440,
    recipientUserIds: body.data.recipientUserIds,
  });

  if (!rule) {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }

  response.status(201).json(rule);
}

export async function listAlertRulesController(_request: Request, response: Response): Promise<void> {
  response.json(await listAlertRules(response.locals.organizationId));
}

export async function updateAlertRuleController(request: Request, response: Response): Promise<void> {
  const ruleId = parseId(request.params.ruleId);
  const body = alertRuleUpdateSchema.safeParse(request.body);
  if (!ruleId || !body.success) {
    response.status(400).json({ error: { message: 'A valid rule and updates are required.' } });
    return;
  }

  const rule = await updateAlertRule(response.locals.organizationId, ruleId, body.data);
  if (!rule) {
    response.status(404).json({ error: { message: 'Alert rule not found in this workspace.' } });
    return;
  }

  response.json(rule);
}

export async function deleteAlertRuleController(request: Request, response: Response): Promise<void> {
  const ruleId = parseId(request.params.ruleId);
  if (!ruleId) {
    response.status(400).json({ error: { message: 'A valid rule identifier is required.' } });
    return;
  }

  const deleted = await deleteAlertRule(response.locals.organizationId, ruleId);
  if (!deleted) {
    response.status(404).json({ error: { message: 'Alert rule not found in this workspace.' } });
    return;
  }

  response.status(204).send();
}

export async function listAlertEventsController(request: Request, response: Response): Promise<void> {
  const query = alertEventQuerySchema.safeParse(request.query);
  const events = await listAlertEvents(response.locals.organizationId, {
    domainId: query.success ? query.data.domainId : undefined,
    limit: query.success ? query.data.limit : undefined,
  });

  response.json(events);
}

export async function getNotificationPreferenceController(request: Request, response: Response): Promise<void> {
  response.json(await getNotificationPreference(request.params.userId as string));
}

export async function updateNotificationPreferenceController(request: Request, response: Response): Promise<void> {
  const body = notificationPreferenceSchema.safeParse(request.body);
  if (!body.success) {
    response.status(400).json({ error: { message: 'Valid notification preferences are required.' } });
    return;
  }

  const sessionUserId = response.locals.session?.user?.id;
  if (!sessionUserId || sessionUserId !== request.params.userId) {
    response.status(403).json({ error: { message: 'You can only change your own notification preferences.' } });
    return;
  }

  try {
    response.json(await updateNotificationPreference(sessionUserId, body.data));
  } catch (error) {
    response.status(400).json({
      error: { message: error instanceof Error ? error.message : 'The preferences could not be saved.' },
    });
  }
}
