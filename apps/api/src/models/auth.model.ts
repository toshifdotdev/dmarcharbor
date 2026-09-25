import { z } from 'zod';

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

export const workspaceIdSchema = z.string().trim().min(1);

export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceSchema>;
