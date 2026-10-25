import type { Request, Response } from 'express';
import { z } from 'zod';
import { resourceIdSchema } from '../models/client.model.js';
import { getDomain } from '../services/client.service.js';
import { EntitlementError } from '../services/entitlements/entitlement.service.js';
import {
  buildSenderBreakdown,
  newSenderBlockers,
  possibleSpoofingSources,
  senderBreakdownThresholds,
} from '../services/sender-breakdown.service.js';
import { newSenderWindowDays } from '../services/dmarc-rollout.service.js';
import {
  SenderReviewError,
  bulkReviewSendersByService,
  reviewSender,
  setSenderOwner,
} from '../services/senders/sender-review.service.js';

const reviewSchema = z.object({
  senderKey: z.string().trim().min(1).max(320),
  status: z.enum(['APPROVED', 'NOT_OURS', 'UNREVIEWED']),
  note: z.string().max(280).nullable().optional(),
});

const ownerSchema = z.object({
  senderKey: z.string().trim().min(1).max(320),
  ownerUserId: z.string().trim().min(1).nullable(),
});

const bulkSchema = z.object({
  serviceId: z.string().trim().min(1).max(120),
  status: z.enum(['APPROVED', 'NOT_OURS', 'UNREVIEWED']),
});

function sendError(response: Response, error: unknown): void {
  if (error instanceof SenderReviewError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details ?? {}) } });
    return;
  }
  if (error instanceof EntitlementError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message, ...error.details } });
    return;
  }
  response.status(500).json({ error: { code: 'INTERNAL', message: 'The sender decision could not be saved.' } });
}

export async function senderBreakdownController(request: Request, response: Response): Promise<void> {
  const domainId = resourceIdSchema.safeParse(request.params.domainId);
  if (!domainId.success) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'A valid domain identifier is required.' } });
    return;
  }

  const organizationId = response.locals.organizationId;
  const domain = await getDomain(organizationId, domainId.data);
  if (!domain) {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Domain not found in this workspace.' } });
    return;
  }

  // The resolved id: the path may carry the slug, and child rows key on id.
  const senders = await buildSenderBreakdown(organizationId, domain.id);

  response.json({
    senders,
    newSenders: senders.filter((sender) => sender.isNew),
    possibleSpoofingSources: possibleSpoofingSources(senders),
    newSenderBlockers: newSenderBlockers(senders),
    thresholds: senderBreakdownThresholds,
    newSenderWindowDays,
  });
}

export async function reviewSenderController(request: Request, response: Response): Promise<void> {
  const domainId = resourceIdSchema.safeParse(request.params.domainId);
  const body = reviewSchema.safeParse(request.body);
  if (!domainId.success || !body.success) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'A sender key and a status of APPROVED, NOT_OURS or UNREVIEWED are required.',
      },
    });
    return;
  }

  try {
    const domain = await getDomain(response.locals.organizationId, domainId.data);
    if (!domain) {
      response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Domain not found in this workspace.' } });
      return;
    }
    const result = await reviewSender({
      organizationId: response.locals.organizationId,
      domainId: domain.id,
      senderKey: body.data.senderKey,
      status: body.data.status,
      note: body.data.note,
      actorUserId: response.locals.session?.user?.id,
    });
    response.json(result);
  } catch (error) {
    sendError(response, error);
  }
}

export async function setSenderOwnerController(request: Request, response: Response): Promise<void> {
  const domainId = resourceIdSchema.safeParse(request.params.domainId);
  const body = ownerSchema.safeParse(request.body);
  if (!domainId.success || !body.success) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'A sender key and an owner user id, or null, are required.' },
    });
    return;
  }

  try {
    const domain = await getDomain(response.locals.organizationId, domainId.data);
    if (!domain) {
      response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Domain not found in this workspace.' } });
      return;
    }
    const result = await setSenderOwner({
      organizationId: response.locals.organizationId,
      domainId: domain.id,
      senderKey: body.data.senderKey,
      ownerUserId: body.data.ownerUserId,
      actorUserId: response.locals.session?.user?.id,
    });
    response.json(result);
  } catch (error) {
    sendError(response, error);
  }
}

export async function bulkReviewSendersController(request: Request, response: Response): Promise<void> {
  const clientId = resourceIdSchema.safeParse(request.params.clientId);
  const body = bulkSchema.safeParse(request.body);
  if (!clientId.success || !body.success) {
    response.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'A service id and a review status are required.' },
    });
    return;
  }

  try {
    const result = await bulkReviewSendersByService({
      organizationId: response.locals.organizationId,
      clientId: clientId.data,
      serviceId: body.data.serviceId,
      status: body.data.status,
      actorUserId: response.locals.session?.user?.id,
    });
    response.json(result);
  } catch (error) {
    sendError(response, error);
  }
}
