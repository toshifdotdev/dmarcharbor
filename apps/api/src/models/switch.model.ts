import { z } from 'zod';

/**
 * Up to 100 domains in one switch import.
 *
 * The cap is enforced by the schema so an oversized paste is a plain 400 with
 * the limit in the message, rather than a 256KB body parser refusing first.
 */
export const switchKitImportSchema = z.object({
  domains: z.array(z.string().trim().min(1).max(300)).min(1).max(100),
});

export type SwitchKitImportRequest = z.infer<typeof switchKitImportSchema>;
