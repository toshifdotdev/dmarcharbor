import { z } from 'zod';

const entitlementKeySchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-z]+(\.[a-zA-Z]+)+$/, 'An entitlement looks like reports.forensic');

export const planChangeSchema = z.object({
  plan: z.enum(['MOORING', 'FAIRWAY', 'HARBOR', 'ADMIRALTY']),
  status: z.enum(['ACTIVE', 'TRIALING', 'CANCELLED', 'PAST_DUE', 'EXPIRED']).optional(),
  currentPeriodEnd: z.string().datetime().nullable().optional(),
  reason: z.string().trim().max(280).optional(),
});

export const entitlementOverrideSchema = z.object({
  entitlement: entitlementKeySchema,
  enabled: z.boolean(),
  reason: z.string().trim().min(3).max(280),
  expiresAt: z.string().datetime().nullable().optional(),
});

export type PlanChangeRequest = z.infer<typeof planChangeSchema>;
export type EntitlementOverrideRequest = z.infer<typeof entitlementOverrideSchema>;
