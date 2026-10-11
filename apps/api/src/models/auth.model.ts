import { z } from 'zod';

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),

  /**
   * The Terms of Service, required.
   *
   * Same reasoning as the DPA below and in the same place: a checkbox that only
   * exists in the browser is not an acceptance. This one was in a worse position
   * than the DPA, because it lived on the billing page. A customer on the free
   * plan never reached billing and so never accepted the document the service is
   * provided under, while the paid path could be reached by a caller that ignored
   * the UI.
   *
   * Deliberately optional in the schema, for the same reason as the DPA: the
   * refusal has to be ours, carrying the document URL, rather than a generic
   * "enter a valid workspace name and slug" at the moment someone needs to go and
   * read what they are being asked to accept.
   */
  tosAccepted: z.boolean().optional(),

  /**
   * The two Data Processing Agreement confirmations, required.
   *
   * They live on the creation call rather than a follow-up because that is the
   * only arrangement where refusing is possible. The welcome screen collected both
   * boxes in a server action and never called the endpoint that records them, so
   * every workspace in existence had `dpaAcceptedAt: null` and the compliance
   * evidence chain recorded nothing at all. Recording it afterwards would have left
   * the same gap with a second step in it.
   *
   * `confirmsAuthority` is the one that matters legally: an employee setting up a
   * workspace has not necessarily been authorised by their firm to bind it to a
   * data processing agreement, and that is a question for the person ticking it,
   * not something the server can infer.
   *
   * Deliberately optional in the schema so the refusal is ours rather than a
   * generic validation failure. A missing flag arrives here as `undefined`, which
   * is falsey, and the controller answers with the document URL so the client can
   * show the agreement. Making it required here instead would return a bare
   * "enter a valid workspace name and slug", which is both wrong and useless at
   * exactly the moment someone needs to read what they are agreeing to.
   */
  dpaHasRead: z.boolean().optional(),
  dpaConfirmsAuthority: z.boolean().optional(),
});

export const workspaceIdSchema = z.string().trim().min(1);

export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceSchema>;
