import { prisma } from '../../src/database/prisma.js';

/**
 * Gives a workspace a VERIFIED client domain, which is how a workspace proves
 * it controls an email domain before single sign-on admits addresses there
 * (sso.service.ts, provenEmailDomains).
 *
 * Domain names are unique across workspaces, so a row left by an earlier test
 * under another workspace is removed first.
 */
export async function proveSsoDomain(organizationId: string, name = 'northgate.test'): Promise<void> {
  await prisma.domain.deleteMany({ where: { name } });
  const client = await prisma.client.create({
    data: {
      organizationId,
      name: `Internal ${name}`,
      slug: `internal-${name.replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`,
    },
    select: { id: true },
  });
  await prisma.domain.create({
    data: {
      clientId: client.id,
      name,
      slug: `${name.replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`,
      status: 'VERIFIED',
      verifiedAt: new Date(),
    },
  });
}
