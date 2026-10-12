import { prisma } from '../../database/prisma.js';
import { planCatalog, type PlanDefinition } from './plan-catalog.js';
import type { PlanTier } from '@prisma/client';

/**
 * How many workspaces an account may hold, and how many it holds now.
 *
 * Counted across every workspace the user owns, not within one, because the
 * allowance is a property of the account rather than of a container. Without
 * that, each workspace would carry its own free allowance and the limits above it
 * would mean nothing.
 *
 * The allowance is the plan on the account itself. It used to be derived by
 * taking the strongest plan among the workspaces owned, which was a stand-in for
 * an account plan that did not exist yet; now that the plan lives on the account
 * there is nothing to derive, and a workspace added before a purchase cannot
 * raise the ceiling the buyer is entitled to.
 */
export interface WorkspaceAllowance {
  /** The plan the account holds, which sets the allowance. */
  strongest: PlanTier;
  maxWorkspaces: number;
  used: number;
  remaining: number;
  /** True when another workspace can be created. */
  allowed: boolean;
}

export async function workspaceAllowanceFor(userId: string): Promise<WorkspaceAllowance> {
  const [account, owned] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true },
    }),
    prisma.member.findMany({
      where: { userId, role: 'owner' },
      select: { organizationId: true },
      distinct: ['organizationId'],
    }),
  ]);

  const strongest: PlanTier = account?.plan ?? 'MOORING';
  const used = owned.length;

  const definition: PlanDefinition = planCatalog[strongest];
  const remaining = Math.max(0, definition.maxWorkspaces - used);

  return {
    strongest,
    maxWorkspaces: definition.maxWorkspaces,
    used,
    remaining,
    allowed: remaining > 0,
  };
}
