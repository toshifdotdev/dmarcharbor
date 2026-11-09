import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';

/**
 * How many Cloudflare for SaaS custom hostnames this deployment holds.
 *
 * Hosted MTA-STS (`mta-sts.<domain>`) and agency custom domains
 * (`portal.<agency>`) are custom hostnames in the same zone, under the same
 * subscription and the same bill, so they share one limit,
 * HOSTED_MTA_STS_HOSTNAME_LIMIT. Counted apart, each feature could fill the
 * limit on its own and the bill would be twice what the operator chose.
 *
 * A released MTA-STS row whose hostname Cloudflare would not delete still
 * holds one, as does an organization whose hostname is stored.
 */
export async function customHostnameCapacity(): Promise<{ full: boolean; used: number; limit: number }> {
  const [mtaSts, agency] = await Promise.all([
    prisma.hostedMtaStsRecord.count({
      where: { OR: [{ status: { not: 'RELEASED' } }, { customHostnameId: { not: null } }] },
    }),
    prisma.organization.count({ where: { customDomainHostnameId: { not: null } } }),
  ]);
  const used = mtaSts + agency;
  const limit = env.HOSTED_MTA_STS_HOSTNAME_LIMIT;
  return { full: used >= limit, used, limit };
}
