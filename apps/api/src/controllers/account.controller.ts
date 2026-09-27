import type { Request, Response } from 'express';

export function getMe(_request: Request, response: Response): void {
  response.json(response.locals.session);
}
