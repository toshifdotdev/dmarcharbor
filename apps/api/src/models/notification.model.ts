import { z } from 'zod';

export const notificationListQuerySchema = z.object({
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const reportDigestCreateSchema = z.object({
  domainId: z.string().trim().min(1),
  frequency: z.enum(['WEEKLY', 'MONTHLY']).default('WEEKLY'),
  sendHourUtc: z.number().int().min(0).max(23).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional(),
  recipientEmails: z.array(z.string().trim().email()).min(1).max(20),
  includeForensics: z.boolean().optional().default(false),
});

export const reportDigestUpdateSchema = z.object({
  frequency: z.enum(['WEEKLY', 'MONTHLY']).optional(),
  sendHourUtc: z.number().int().min(0).max(23).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional(),
  recipientEmails: z.array(z.string().trim().email()).min(1).max(20).optional(),
  includeForensics: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export type ReportDigestCreateRequest = z.infer<typeof reportDigestCreateSchema>;
export type ReportDigestUpdateRequest = z.infer<typeof reportDigestUpdateSchema>;
