import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';
import { auth } from '../auth/auth.config.js';
import { createWorkspaceSchema, workspaceIdSchema } from '../models/auth.model.js';
import { dpaPath, recordDpaAcceptance } from '../services/dpa-acceptance.service.js';

export async function listWorkspaces(request: Request, response: Response): Promise<void> {
  const workspaces = await auth.api.listOrganizations({ headers: fromNodeHeaders(request.headers) });
  response.json(workspaces);
}

export async function createWorkspace(request: Request, response: Response): Promise<void> {
  const parsed = createWorkspaceSchema.safeParse(request.body);

  if (!parsed.success) {
    response.status(400).json({ error: { message: 'Enter a valid workspace name and slug.' } });
    return;
  }

  /**
   * The agreement is checked before anything is created.
   *
   * A workspace that cannot exist without the acceptance recorded is an
   * enforcement. One created first and accepted afterwards is a form, and a form
   * can be skipped by calling the API directly, which is exactly what was
   * happening: `POST /api/workspaces` had no opinion about the DPA at all, and the
   * acceptance endpoint that did exist was never called from anywhere in the app.
   */
  if (!parsed.data.dpaHasRead || !parsed.data.dpaConfirmsAuthority) {
    response.status(400).json({
      error: {
        code: 'DPA_NOT_ACCEPTED',
        message: 'The Data Processing Agreement must be read and accepted before a workspace can be created.',
        // The client needs to know it has to show the document, not just complain.
        dpaUrl: dpaPath,
      },
    });
    return;
  }

  const workspace = await auth.api.createOrganization({
    // The confirmations are ours, not Better Auth's, so they are stripped before
    // the body is handed over rather than relying on it to ignore extras.
    body: { name: parsed.data.name, slug: parsed.data.slug },
    headers: fromNodeHeaders(request.headers),
  });

  const organizationId = (workspace as { id?: unknown }).id;
  if (typeof organizationId === 'string') {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    await recordDpaAcceptance({
      organizationId,
      actorUserId: session?.user?.id ?? null,
      actorEmail: session?.user?.email ?? 'unknown',
      hasRead: true,
      confirmsAuthority: true,
      ipAddress: request.ip ?? null,
    });
  }

  response.status(201).json(workspace);
}

export async function listWorkspaceMembers(request: Request, response: Response): Promise<void> {
  const parsed = workspaceIdSchema.safeParse(request.params.organizationId);

  if (!parsed.success) {
    response.status(400).json({ error: { message: 'A valid workspace identifier is required.' } });
    return;
  }

  const members = await auth.api.listMembers({
    query: { organizationId: parsed.data },
    headers: fromNodeHeaders(request.headers),
  });
  response.json(members);
}
