import type { Request, Response } from 'express';
import { resourceIdSchema } from '../models/client.model.js';
import { getDomain } from '../services/client.service.js';
import {
  buildSenderBreakdown,
  newSenderBlockers,
  possibleSpoofingSources,
  senderBreakdownThresholds,
} from '../services/sender-breakdown.service.js';
import { newSenderWindowDays } from '../services/dmarc-rollout.service.js';

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

  const senders = await buildSenderBreakdown(organizationId, domainId.data);

  response.json({
    senders,
    newSenders: senders.filter((sender) => sender.isNew),
    possibleSpoofingSources: possibleSpoofingSources(senders),
    newSenderBlockers: newSenderBlockers(senders),
    thresholds: senderBreakdownThresholds,
    newSenderWindowDays,
  });
}
