import { z } from 'zod';

export const forensicIngestSchema = z.object({
  rawEmail: z.string().trim().min(1).max(5_000_000),
});

export const forensicCollectionSchema = z.object({
  collectForensicReports: z.boolean(),
});

export const forensicIdentitySchema = z.object({
  retainForensicPii: z.boolean(),
  confirmLegalBasis: z.boolean().optional().default(false),
  confirmNamePurge: z.boolean().optional().default(false),
});

export const insightsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
});

export type ForensicIngestRequest = z.infer<typeof forensicIngestSchema>;
export type ForensicCollectionRequest = z.infer<typeof forensicCollectionSchema>;
export type ForensicIdentityRequest = z.infer<typeof forensicIdentitySchema>;
