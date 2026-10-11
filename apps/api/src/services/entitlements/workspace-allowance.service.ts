import { prisma } from '../../database/prisma.js';
import { planCatalog, type PlanDefinition } from './plan-catalog.js';
import type { PlanTier } from '@prisma/client';

/**
 * How many workspaces a person may hold, and how many they hold now.
 *
 * Counted across every workspace the user is a member of, not one workspace,
 * because the allowance is a property of the account and not of the container.
 * Without that, the freedom to make a second workspace would each carry its own
 * free allowance, and the client and domain limits above it would mean nothing.
 *
 * The allowance itself comes from the strongest plan the account holds rather
 * than the sum of its plans' allowances. Owning one Admiralty workspace has
 * already bought the entitlement, and adding a second workspace is not a second
 * purchase. Summing instead would mean three Fairway workspaces entitle someone
 * to six, which is the top tier's allowance bought at a third of its price.
 */
export interface WorkspaceAllowance {
  /** The strongest plan the account holds, which sets the allowance. */
  strongest: PlanTier;
  maxWorkspaces: number;
  used: number;
  remaining: number;
  /** True when another workspace can be created. */
  allowed: boolean;
}

const tierRank: Record<PlanTier, number> = {
  MOORING: 0,
  FAIRWAY: 1,
  HARBOR: 2,
  ADMIRALTY: 3,
};

export async function workspaceAllowanceFor(userId: string): Promise<WorkspaceAllowance> {
  const memberships = await prisma.member.findMany({
    where: { userId },
    select: { organization: { select: { plan: true } } },
  });

  const plans = memberships.map((membership) => membership.organization.plan);
  const used = plans.length;

  let strongest: PlanTier = 'MOORING';
  for (const plan of plans) {
    if (tierRank[plan] > tierRank[strongest]) strongest = plan;
  }

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
