import { z } from 'zod';

export const erasureRequestSchema = z.object({
  scope: z.enum(['ORGANIZATION', 'CLIENT', 'DOMAIN']).default('ORGANIZATION'),
  targetId: z.string().trim().min(1).optional(),
  reason: z.string().trim().max(280).optional(),
});

export const erasureExecuteSchema = z.object({
  confirmNamePurge: z.literal(true),
});

export type ErasureRequestInput = z.infer<typeof erasureRequestSchema>;
