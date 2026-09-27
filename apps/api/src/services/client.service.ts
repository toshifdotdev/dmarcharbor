import { prisma } from '../database/prisma.js';
import { emitEvent } from './webhook.service.js';
import { normalizeDomain } from '../scanner/domain.js';
import { systemDnsReader } from '../scanner/dns.js';
import type { CreateClientRequest, CreateDomainRequest } from '../models/client.model.js';

export async function listClients(organizationId: string) {
  return prisma.client.findMany({
    where: { organizationId },
    include: { domains: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createClient(organizationId: string, input: CreateClientRequest) {
  return prisma.client.create({
    data: {
      organizationId,
      name: input.name,
      slug: input.slug,
    },
  });
}

export async function listDomains(organizationId: string, clientId?: string) {
  return prisma.domain.findMany({
    where: {
      client: { organizationId },
      ...(clientId ? { clientId } : {}),
    },
    include: { client: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createDomain(organizationId: string, clientId: string, input: CreateDomainRequest) {
  const client = await prisma.client.findFirst({
    where: { id: clientId, organizationId },
    select: { id: true },
  });

  if (!client) {
    return null;
  }

  return prisma.domain.create({
    data: {
      clientId,
      name: normalizeDomain(input.name),
    },
  });
}

export async function getDomain(organizationId: string, domainId: string) {
  return prisma.domain.findFirst({
    where: { id: domainId, client: { organizationId } },
    include: { client: true },
  });
}

export async function verifyDomain(organizationId: string, domainId: string) {
  const domain = await getDomain(organizationId, domainId);

  if (!domain) {
    return null;
  }

  const host = `_dmarc-harbor-verification.${domain.name}`;
  const expectedValue = `dmarc-harbor-verification=${domain.verificationToken}`;
  const lookup = await systemDnsReader.resolveTxt(host);
  const verified = lookup.status === 'found' && lookup.value?.some((chunks) => chunks.join('') === expectedValue) === true;
  let updatedDomain = domain;

  if (verified) {
    const firstTime = domain.status !== 'VERIFIED';
    updatedDomain = await prisma.domain.update({
      where: { id: domain.id },
      data: { status: 'VERIFIED', verifiedAt: new Date() },
      include: { client: true },
    });

    // Emitted only on the transition, so a re-check of an already verified
    // domain does not fire a second event and train the integration to ignore it.
    if (firstTime) {
      await emitEvent(organizationId, 'domain.verified', {
        domainId: domain.id,
        domainName: domain.name,
        clientId: domain.clientId,
        verifiedAt: new Date().toISOString(),
      });
    }
  } else if (lookup.status === 'missing' && domain.status === 'VERIFIED') {
    updatedDomain = await prisma.domain.update({
      where: { id: domain.id },
      data: { status: 'FAILED', verifiedAt: null },
      include: { client: true },
    });
  }

  return {
    domain: updatedDomain,
    verification: {
      host,
      type: 'TXT',
      value: expectedValue,
      verified,
      lookupStatus: lookup.status,
      error: lookup.error,
    },
  };
}
