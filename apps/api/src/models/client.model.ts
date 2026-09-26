import { z } from 'zod';

export const createClientSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

export const createDomainSchema = z.object({
  name: z.string().trim().min(3).max(253),
});

export const resourceIdSchema = z.string().trim().min(1);

export type CreateClientRequest = z.infer<typeof createClientSchema>;
export type CreateDomainRequest = z.infer<typeof createDomainSchema>;
