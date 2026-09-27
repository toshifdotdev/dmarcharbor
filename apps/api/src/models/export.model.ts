import { z } from 'zod';

export const exportCreateSchema = z.object({
  scope: z.enum(['ORGANIZATION', 'CLIENT', 'DOMAIN']).default('ORGANIZATION'),
  targetId: z.string().trim().min(1).optional(),
  format: z.enum(['JSON', 'CSV']).default('JSON'),
});

export const exportDownloadSchema = z.object({
  token: z.string().trim().min(20).max(200),
});

export type ExportCreateRequest = z.infer<typeof exportCreateSchema>;
