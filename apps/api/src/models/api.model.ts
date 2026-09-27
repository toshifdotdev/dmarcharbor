import { z } from 'zod';

export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(3).max(80),
  scopes: z.array(z.enum(['read', 'write'])).min(1).max(2).default(['read']),
  expiresInDays: z.number().int().min(1).max(1095).optional(),
});

// Row level problems are intentionally NOT rejected by the schema. A bulk
// import from a client CRM should report one bad row and still create the rest,
// so the shape is validated here and the values are judged per row by the
// service. Only a structurally invalid request is a 400.
export const bulkClientsSchema = z.object({
  clients: z
    .array(
      z.object({
        name: z.string().max(200),
        slug: z.string().max(48).optional(),
        domains: z.array(z.string().max(300)).max(200).optional().default([]),
      }),
    )
    .min(1),
});

export const bulkDomainsSchema = z.object({
  clientId: z.string().trim().min(1),
  domains: z.array(z.string().max(300)).min(1),
});

export const apiClientCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(48).optional(),
  domains: z.array(z.string().trim().min(1).max(253)).max(100).optional().default([]),
});

export const apiDomainCreateSchema = z.object({
  clientId: z.string().trim().min(1),
  name: z.string().trim().min(1).max(253),
});

export type ApiKeyCreateRequest = z.infer<typeof apiKeyCreateSchema>;
export type BulkClientsRequest = z.infer<typeof bulkClientsSchema>;
export type BulkDomainsRequest = z.infer<typeof bulkDomainsSchema>;
