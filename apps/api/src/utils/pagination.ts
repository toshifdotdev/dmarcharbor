import type { Request, Response } from 'express';
import { z } from 'zod';

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().min(1).max(64).optional(),
});

export const defaultPageSize = 50;
export const maximumPageSize = 200;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type PaginationResult =
  | { ok: true; limit: number; cursor: string | undefined }
  | { ok: false };

export function parsePagination(request: Request, response: Response): PaginationResult {
  const query = paginationQuerySchema.safeParse(request.query);

  if (!query.success) {
    response.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: `limit must be a whole number between 1 and ${maximumPageSize}, and cursor must be a valid identifier.`,
      },
    });
    return { ok: false };
  }

  return { ok: true, limit: resolveLimit(query.data.limit), cursor: query.data.cursor };
}

export function resolveLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? defaultPageSize, 1), maximumPageSize);
}

export function buildPage<T>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1] as { id?: unknown } | undefined;
  const nextCursor = hasMore && typeof last?.id === 'string' ? last.id : null;

  return {
    items,
    hasMore,
    nextCursor,
  };
}
