import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { systemDnsReader } from '../src/scanner/dns.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE');
}

async function createWorkspace(): Promise<{ agent: ReturnType<typeof request.agent>; organizationId: string }> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `agency-${Date.now()}-${fixtureId}@example.com`;
  const signUp = await agent.post('/api/auth/sign-up/email').send({
    name: 'Agency Owner',
    email,
    password,
  });
  expect(signUp.status).toBe(200);

  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const signIn = await agent.post('/api/auth/sign-in/email').send({ email, password });
  expect(signIn.status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Client Operations',
    slug: `client-operations-${Date.now()}-${fixtureId}`,
  });
  expect(workspace.status).toBe(201);

  return { agent, organizationId: workspace.body.id as string };
}

describe('clients and domains', () => {
  beforeAll(resetDatabase);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates and lists workspace clients and domains', async () => {
    const { agent, organizationId } = await createWorkspace();
    const clientResponse = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
      name: 'Northwind Industries',
      slug: 'northwind-industries',
    });

    expect(clientResponse.status).toBe(201);
    expect(clientResponse.body.name).toBe('Northwind Industries');

    const duplicateClient = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
      name: 'Northwind Industries',
      slug: 'northwind-industries',
    });
    expect(duplicateClient.status).toBe(409);

    const domainResponse = await agent.post(`/api/workspaces/${organizationId}/clients/${clientResponse.body.id}/domains`).send({
      name: 'Example.COM',
    });

    expect(domainResponse.status).toBe(201);
    expect(domainResponse.body.name).toBe('example.com');
    expect(domainResponse.body.status).toBe('PENDING');
    expect(domainResponse.body.verificationToken).toBeTruthy();

    const invalidDomain = await agent.post(`/api/workspaces/${organizationId}/clients/${clientResponse.body.id}/domains`).send({
      name: 'localhost',
    });
    expect(invalidDomain.status).toBe(400);

    const domains = await agent.get(`/api/workspaces/${organizationId}/clients/${clientResponse.body.id}/domains`);
    expect(domains.status).toBe(200);
    expect(domains.body).toHaveLength(1);
    expect(domains.body[0].id).toBe(domainResponse.body.id);

    const clients = await agent.get(`/api/workspaces/${organizationId}/clients`);
    expect(clients.status).toBe(200);
    expect(clients.body).toHaveLength(1);
    expect(clients.body[0].domains).toHaveLength(1);
  });

  it('verifies a domain when its TXT record contains the expected token', async () => {
    const { agent, organizationId } = await createWorkspace();
    const clientResponse = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
      name: 'Verification Client',
      slug: `verification-client-${Date.now()}`,
    });
    expect(clientResponse.status).toBe(201);

    const domainResponse = await agent.post(`/api/workspaces/${organizationId}/clients/${clientResponse.body.id}/domains`).send({
      name: 'verify.invalid',
    });
    expect(domainResponse.status).toBe(201);

    const lookup = vi.spyOn(systemDnsReader, 'resolveTxt').mockResolvedValue({
      status: 'found',
      value: [[`dmarc-harbor-verification=${domainResponse.body.verificationToken}`]],
    });

    const verification = await agent.post(`/api/workspaces/${organizationId}/domains/${domainResponse.body.id}/verify`);

    expect(verification.status).toBe(200);
    expect(verification.body.verification.verified).toBe(true);
    expect(verification.body.domain.status).toBe('VERIFIED');
    expect(verification.body.verification.host).toBe(`_dmarc-harbor-verification.verify.invalid`);
    expect(lookup).toHaveBeenCalledWith(`_dmarc-harbor-verification.verify.invalid`);

    lookup.mockResolvedValue({ status: 'missing' });
    const failedVerification = await agent.post(`/api/workspaces/${organizationId}/domains/${domainResponse.body.id}/verify`);
    expect(failedVerification.status).toBe(200);
    expect(failedVerification.body.verification.verified).toBe(false);
    expect(failedVerification.body.domain.status).toBe('FAILED');

    lookup.mockRestore();
  });

  it('enforces workspace role permissions', async () => {
    const { agent, organizationId } = await createWorkspace();
    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'viewer' } });

    const createResponse = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
      name: 'Forbidden Client',
      slug: 'forbidden-client',
    });
    expect(createResponse.status).toBe(403);

    const readResponse = await agent.get(`/api/workspaces/${organizationId}/clients`);
    expect(readResponse.status).toBe(200);
  });

  it('rejects workspace access from users who are not members', async () => {
    const { organizationId } = await createWorkspace();
    const otherAgent = request.agent(app);
    const otherEmail = `other-${Date.now()}@example.com`;
    const signUp = await otherAgent.post('/api/auth/sign-up/email').send({
      name: 'Other User',
      email: otherEmail,
      password,
    });
    expect(signUp.status).toBe(200);
    await prisma.user.update({ where: { email: otherEmail }, data: { emailVerified: true } });
    const signIn = await otherAgent.post('/api/auth/sign-in/email').send({ email: otherEmail, password });
    expect(signIn.status).toBe(200);

    const response = await otherAgent.get(`/api/workspaces/${organizationId}/clients`);
    expect(response.status).toBe(403);
  });
});
