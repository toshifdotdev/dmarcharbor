import { z } from 'zod';

export const dmarcRecordQuerySchema = z.object({
  policy: z.enum(['none', 'quarantine', 'reject']).default('none'),
  pct: z
    .string()
    .trim()
    .regex(/^\d{1,3}$/, 'pct must be a whole number between 0 and 100')
    .transform((value) => Number(value))
    .refine((value) => value >= 0 && value <= 100, 'pct must be between 0 and 100')
    .optional(),
  forensics: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export const reportShareCreateSchema = z.object({
  domainId: z.string().trim().min(1),
  includeForensics: z.boolean().optional().default(false),
  includeSources: z.boolean().optional().default(true),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export type DmarcRecordQuery = z.infer<typeof dmarcRecordQuerySchema>;
export type ReportShareCreateRequest = z.infer<typeof reportShareCreateSchema>;
