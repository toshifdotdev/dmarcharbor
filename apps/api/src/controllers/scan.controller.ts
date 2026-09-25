import type { Request, Response } from 'express';
import { DomainValidationError } from '../scanner/domain.js';
import { executeScan } from '../services/scan.service.js';
import { scanRequestSchema } from '../models/scan.model.js';

export async function scanController(request: Request, response: Response): Promise<void> {
  const parsed = scanRequestSchema.safeParse(request.body);

  if (!parsed.success) {
    response.status(400).json({ error: { message: 'Enter a valid domain to scan.' } });
    return;
  }

  try {
    const result = await executeScan(parsed.data);
    response.json(result);
  } catch (error) {
    if (error instanceof DomainValidationError) {
      response.status(400).json({ error: { message: error.message } });
      return;
    }

    response.status(500).json({ error: { message: 'The scan could not be completed.' } });
  }
}
