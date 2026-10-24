import { z } from 'zod';

export const dmarcRecordQuerySchema = z.object({
  policy: z.enum(['none', 'quarantine', 'reject']).default('none'),
  /**
   * Testing mode (RFC 9989 t=y). pct is no longer accepted: RFC 9989 retired
   * it, and a request for one is refused with a pointer to `testing` rather
   * than silently ignored.
   */
  testing: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  np: z.enum(['none', 'quarantine', 'reject']).optional(),
  pct: z
    .unknown()
    .optional()
    .refine((value) => value === undefined, {
      message: 'pct was retired by RFC 9989 and is no longer generated. Use testing=true for testing mode (t=y).',
    }),
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
