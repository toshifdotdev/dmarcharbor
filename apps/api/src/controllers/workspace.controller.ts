import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';
import { auth } from '../auth/auth.config.js';
import { prisma } from '../database/prisma.js';
import { createWorkspaceSchema, workspaceIdSchema } from '../models/auth.model.js';
import {
  dpaPath,
  recordDpaAcceptance,
  recordTosAcceptance,
  rollbackWorkspaceWithoutAcceptance,
  tosPath,
} from '../services/dpa-acceptance.service.js';
import { workspaceAllowanceFor } from '../services/entitlements/workspace-allowance.service.js';

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

  /**
   * The Terms of Service is checked here, on the same request that creates the
   * workspace.
   *
   * It used to be a checkbox on the billing page and nothing else: no field, no
   * server check, no record. That left two holes. A caller that ignored the UI
   * could start a paid subscription without ever accepting the document the
   * service is provided under, and a customer on the free plan never saw it at
   * all because they never reached billing. An acceptance that exists only in a
   * browser's React state is not an acceptance.
   */
  if (parsed.data.tosAccepted !== true) {
    response.status(400).json({
      error: {
        code: 'TERMS_NOT_ACCEPTED',
        message: 'The Terms of Service must be accepted before a workspace can be created.',
        tosUrl: tosPath,
      },
    });
    return;
  }

  /**
   * The workspace allowance is checked before anything is created.
   *
   * It used to be unbounded, which made the client and domain limits above it
   * meaningless: every extra free workspace came with its own client and its own
   * two domains, so the number of workspaces was the only limit that mattered and
   * nothing enforced it. The allowance comes from the strongest plan the account
   * already holds, so nobody is asked to pay twice for an entitlement they own.
   */
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session?.user?.id) {
    response.status(401).json({ error: { message: 'Sign in to create a workspace.' } });
    return;
  }

  const allowance = await workspaceAllowanceFor(session.user.id);
  if (!allowance.allowed) {
    response.status(402).json({
      error: {
        code: 'WORKSPACE_LIMIT_REACHED',
        message: `Your ${allowance.strongest === 'MOORING' ? 'free' : allowance.strongest.toLowerCase()} plan includes ${allowance.maxWorkspaces} workspace${allowance.maxWorkspaces === 1 ? '' : 's'} and you already have ${allowance.used}. Remove one, or move up a plan to add another.`,
        limit: allowance.maxWorkspaces,
        used: allowance.used,
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
    const actorEmail = session.user.email ?? 'unknown';
    const actorUserId = session.user.id;
    const ipAddress = request.ip ?? null;

    await recordDpaAcceptance({
      organizationId,
      actorUserId,
      actorEmail,
      hasRead: true,
      confirmsAuthority: true,
      ipAddress,
    });

    await recordTosAcceptance({
      organizationId,
      actorUserId,
      actorEmail,
      ipAddress,
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

/**
 * How many workspaces this account may hold, and how many it holds now.
 *
 * Read-only, and deliberately a separate route rather than a side effect of
 * listing or creating. The create-workspace screen has to state the limit before
 * somebody fills the form in, and finding it out by attempting a creation and
 * reading the refusal would spend an allowance to answer a question about whether
 * to spend one. It goes through the same service that enforces it, so the numbers
 * shown and the numbers enforced cannot drift.
 */
export async function readWorkspaceAllowance(request: Request, response: Response): Promise<void> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session?.user?.id) {
    response.status(401).json({ error: { message: 'Sign in to read the workspace allowance.' } });
    return;
  }

  const allowance = await workspaceAllowanceFor(session.user.id);
  response.json(allowance);
}

export async function listWorkspaceMembers(request: Request, response: Response): Promise<void> {  const parsed = workspaceIdSchema.safeParse(request.params.organizationId);

  if (!parsed.success) {
    response.status(400).json({ error: { message: 'A valid workspace identifier is required.' } });
    return;
  }

  const members = await auth.api.listMembers({
    query: { organizationId: parsed.data },
    headers: fromNodeHeaders(request.headers),
  });

  /**
   * The two-step status is visible to owners and admins only.
   *
   * Better Auth's listMembers returns only id, name, email and image for each
   * user, so the flag is joined from the member's account. It is added rather
   * than always present because an analyst has no reason to learn who has and
   * has not enrolled, and the field is omitted entirely for them - not sent as
   * false, which would be a claim.
   */
  const session = response.locals.session as { user?: { id?: string } } | undefined;
  const callerId = session?.user?.id;
  const caller = callerId
    ? await prisma.member.findUnique({
        where: { organizationId_userId: { organizationId: parsed.data, userId: callerId } },
        select: { role: true },
      })
    : null;
  const callerRoles = (caller?.role ?? '').split(',').map((role) => role.trim());
  const maySee = callerRoles.includes('owner') || callerRoles.includes('admin');

  if (!maySee) {
    response.json(members);
    return;
  }

  const list = members as { members?: Array<{ userId: string }> } & Record<string, unknown>;
  const userIds = (list.members ?? []).map((member) => member.userId);
  const flags = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, twoFactorEnabled: true },
  });
  const enabled = new Map(flags.map((user) => [user.id, user.twoFactorEnabled]));

  response.json({
    ...list,
    members: (list.members ?? []).map((member) => ({
      ...member,
      twoFactorEnabled: enabled.get(member.userId) ?? false,
    })),
  });
}
