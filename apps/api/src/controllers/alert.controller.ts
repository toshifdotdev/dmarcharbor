import type { Request, Response } from 'express';
import {
  alertRuleCreateSchema,
  alertRuleUpdateSchema,
  notificationPreferenceSchema,
} from '../models/alert.model.js';
import { resourceIdSchema } from '../models/client.model.js';
import { recordAuditEvent } from '../services/audit.service.js';
import { assertFeature } from '../services/entitlements/entitlement.service.js';
import { buildPage, parsePagination } from '../utils/pagination.js';
import {
  acknowledgeAlertEvent,
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

  // Spoofing detection is a separate licence from plain email alerts, because
  // it is the feature an agency is actually buying rather than a notification
  // preference.
  const metric = body.data.metric as string;
  await assertFeature(
    response.locals.organizationId,
    metric === 'NEW_UNAUTHENTICATED_SOURCE' ? 'alerts.spoofing' : 'alerts.email',
  );

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
    maxReminderLevel: body.data.maxReminderLevel ?? 3,
    recipientUserIds: body.data.recipientUserIds,
  });

  if (!rule) {
    response.status(404).json({ error: { message: 'Domain not found in this workspace.' } });
    return;
  }

  await recordAuditEvent({
    organizationId: response.locals.organizationId,
    domainId: body.data.domainId,
    actorUserId: response.locals.session?.user?.id,
    action: 'ALERT_RULE_CREATED',
    targetType: 'alert_rule',
    targetId: rule.id,
    detail: { metric: rule.metric, operator: rule.operator, threshold: rule.threshold },
    requestId: response.locals.requestId,
  });

  response.status(201).json(rule);
}

export async function listAlertRulesController(request: Request, response: Response): Promise<void> {
  const page = parsePagination(request, response);
  if (!page.ok) {
    return;
  }

  const rows = await listAlertRules(response.locals.organizationId, {
    limit: page.limit,
    cursor: page.cursor,
  });

  response.json(buildPage(rows, page.limit));
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

  await recordAuditEvent({
    organizationId: response.locals.organizationId,
    actorUserId: response.locals.session?.user?.id,
    action: 'ALERT_RULE_UPDATED',
    targetType: 'alert_rule',
    targetId: rule.id,
    detail: { threshold: rule.threshold, enabled: rule.enabled },
    requestId: response.locals.requestId,
  });

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

  await recordAuditEvent({
    organizationId: response.locals.organizationId,
    actorUserId: response.locals.session?.user?.id,
    action: 'ALERT_RULE_DELETED',
    targetType: 'alert_rule',
    targetId: ruleId,
    requestId: response.locals.requestId,
  });

  response.status(204).send();
}

export async function listAlertEventsController(request: Request, response: Response): Promise<void> {
  const page = parsePagination(request, response);
  if (!page.ok) {
    return;
  }

  const { rows, limit } = await listAlertEvents(response.locals.organizationId, {
    domainId: typeof request.query.domainId === 'string' ? request.query.domainId : undefined,
    limit: page.limit,
    cursor: page.cursor,
  });

  response.json(
    buildPage(
      rows.map((event) => ({
        ...event,
        status: event.acknowledgedAt
          ? 'ACKNOWLEDGED'
          : event.resolvedAt
            ? 'RESOLVED'
            : event.staleAt
              ? 'STALE'
              : 'OPEN',
      })),
      limit,
    ),
  );
}

export async function acknowledgeAlertEventController(request: Request, response: Response): Promise<void> {
  const eventId = parseId(request.params.eventId);
  if (!eventId) {
    response.status(400).json({ error: { message: 'A valid alert identifier is required.' } });
    return;
  }

  const outcome = await acknowledgeAlertEvent(
    response.locals.organizationId,
    eventId,
    response.locals.session?.user?.id,
  );

  if (outcome === 'not_found') {
    response.status(404).json({ error: { message: 'Alert not found in this workspace.' } });
    return;
  }

  if (outcome === 'already_handled') {
    response.status(409).json({ error: { message: 'This alert has already been acknowledged or resolved.' } });
    return;
  }

  await recordAuditEvent({
    organizationId: response.locals.organizationId,
    actorUserId: response.locals.session?.user?.id,
    action: 'ALERT_ACKNOWLEDGED',
    targetType: 'alert_event',
    targetId: eventId,
    requestId: response.locals.requestId,
  });

  response.json({ acknowledged: true });
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
