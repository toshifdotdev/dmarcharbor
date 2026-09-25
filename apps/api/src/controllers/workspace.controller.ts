import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';
import { auth } from '../auth/auth.config.js';
import { createWorkspaceSchema, workspaceIdSchema } from '../models/auth.model.js';

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

  const workspace = await auth.api.createOrganization({
    body: parsed.data,
    headers: fromNodeHeaders(request.headers),
  });
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
