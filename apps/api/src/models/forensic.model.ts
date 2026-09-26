import { z } from 'zod';

export const forensicIngestSchema = z.object({
  rawEmail: z.string().trim().min(1).max(5_000_000),
});

export const forensicCollectionSchema = z.object({
  collectForensicReports: z.boolean(),
});

export const forensicListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type ForensicIngestRequest = z.infer<typeof forensicIngestSchema>;
export type ForensicCollectionRequest = z.infer<typeof forensicCollectionSchema>;
