import { z } from 'zod';

export const reportIngestSchema = z.object({
  xml: z.string().trim().min(1).max(5_000_000),
});

export type ReportIngestRequest = z.infer<typeof reportIngestSchema>;
