import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';
import { auth } from '../auth/auth.config.js';
import { createWorkspaceSchema, workspaceIdSchema } from '../models/auth.model.js';
import {
  dpaPath,
  recordDpaAcceptance,
  rollbackWorkspaceWithoutAcceptance,
} from '../services/dpa-acceptance.service.js';

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
  if (typeof organizationId !== 'string') {
    // Better Auth did not hand back an id, so there is nothing the caller could
    // use and nothing for us to record against. Answering 201 would leave the
    // client believing a workspace exists.
    response.status(502).json({ error: { message: 'The workspace could not be created.' } });
    return;
  }

  /**
   * The acceptance is recorded on the same request, and if it fails the
   * workspace does not survive.
   *
   * Better Auth commits the organisation inside its own call, so the acceptance
   * cannot join that transaction. A throw between them therefore left the
   * workspace existing with `dpaVersion: null` - which is not a missing optional
   * field but a workspace reporting `requiresReconsent: true` for ever, with no
   * API route that could clear it. Rolling the workspace back leaves nothing
   * behind instead of something half-created.
   */
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    await recordDpaAcceptance({
      organizationId,
      actorUserId: session?.user?.id ?? null,
      actorEmail: session?.user?.email ?? 'unknown',
      hasRead: true,
      confirmsAuthority: true,
      ipAddress: request.ip ?? null,
    });
  } catch (error) {
    await rollbackWorkspaceWithoutAcceptance(organizationId);

    console.error(
      `[workspace] rolling back ${organizationId} because the DPA acceptance could not be recorded:`,
      error instanceof Error ? error.message : error,
    );

    response.status(500).json({
      error: {
        message: 'The workspace could not be created because the agreement could not be recorded. Nothing has been created.',
      },
    });
    return;
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
