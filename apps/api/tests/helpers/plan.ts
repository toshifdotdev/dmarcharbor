import { setOrganizationPlan } from '../../src/services/entitlements/entitlement.service.js';
import type { PlanTier } from '@prisma/client';

/**
 * Moves a test workspace onto a plan that includes the feature under test.
 *
 * Every new workspace starts on the free Mooring plan, which deliberately
 * excludes forensics, portals and API access. A test that exercises one of
 * those features has to opt in, the same way a paying customer would.
 */
export async function grantPlan(organizationId: string, plan: PlanTier = 'ADMIRALTY'): Promise<void> {
  await setOrganizationPlan(organizationId, plan, {
    status: 'ACTIVE',
    currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  });
}
