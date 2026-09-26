import type { Request, Response } from 'express';
import { processInboundDmarcEmail } from '../services/inbound-report.service.js';
import { verifyReportWebhookSignature } from '../services/report-webhook.service.js';

export async function inboundReportController(request: Request, response: Response): Promise<void> {
  const rawEmail = typeof request.body === 'string' ? request.body : '';
  const signature = request.header('x-dmarc-signature');

  if (!rawEmail) {
    response.status(400).json({ error: { message: 'A raw report email is required.' } });
    return;
  }

  if (!verifyReportWebhookSignature(rawEmail, signature)) {
    response.status(401).json({ error: { message: 'Invalid report webhook signature.' } });
    return;
  }

  try {
    const result = await processInboundDmarcEmail(rawEmail);
    response.json(result);
  } catch {
    response.status(500).json({ error: { message: 'The inbound report email could not be processed.' } });
  }
}
