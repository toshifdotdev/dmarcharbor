import { z } from 'zod';

const metricSchema = z.enum([
  'FAILURE_COUNT',
  'FAILURE_RATE',
  'SOURCE_IP_VOLUME',
  'FORENSIC_FAILURES',
  'REPORT_SILENCE',
]);

const operatorSchema = z.enum(['GREATER_THAN', 'GREATER_THAN_OR_EQUAL', 'LESS_THAN']);

export const alertRuleCreateSchema = z.object({
  domainId: z.string().trim().min(1),
  name: z.string().trim().min(3).max(100),
  metric: metricSchema,
  operator: operatorSchema,
  threshold: z.number().int().min(0).max(1_000_000),
  windowMinutes: z.number().int().min(5).max(43_200).optional(),
  cooldownMinutes: z.number().int().min(5).max(43_200).optional(),
  maxReminderLevel: z.number().int().min(1).max(5).optional(),
  recipientUserIds: z.array(z.string().trim().min(1)).min(1).max(50),
});

export const alertRuleUpdateSchema = z.object({
  name: z.string().trim().min(3).max(100).optional(),
  threshold: z.number().int().min(0).max(1_000_000).optional(),
  windowMinutes: z.number().int().min(5).max(43_200).optional(),
  cooldownMinutes: z.number().int().min(5).max(43_200).optional(),
  maxReminderLevel: z.number().int().min(1).max(5).optional(),
  enabled: z.boolean().optional(),
  recipientUserIds: z.array(z.string().trim().min(1)).min(1).max(50).optional(),
});

export const alertEventQuerySchema = z.object({
  domainId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const notificationPreferenceSchema = z.object({
  emailAlerts: z.boolean().optional(),
  quietHoursStart: z.string().trim().nullable().optional(),
  quietHoursEnd: z.string().trim().nullable().optional(),
  onlyHighRiskAlerts: z.boolean().optional(),
});

export type AlertRuleCreateRequest = z.infer<typeof alertRuleCreateSchema>;
export type AlertRuleUpdateRequest = z.infer<typeof alertRuleUpdateSchema>;
export type NotificationPreferenceRequest = z.infer<typeof notificationPreferenceSchema>;
