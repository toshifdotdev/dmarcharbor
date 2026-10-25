import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { systemDnsReader } from '../src/scanner/dns.js';
import { grantPlan } from './helpers/plan.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE');
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
    slug: `client-operations-${Date.now()}-${fixtureId}`, tosAccepted: true, dpaHasRead: true, dpaConfirmsAuthority: true});
  expect(workspace.status).toBe(201);

  const organizationId = workspace.body.id as string;
  await grantPlan(organizationId);

  return { agent, organizationId: workspace.body.id as string };
}

describe('clients and domains', () => {
  beforeAll(resetDatabase);

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

  it('persists an authenticated scan and updates the domain summary', async () => {
    const { agent, organizationId } = await createWorkspace();
    const clientResponse = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
      name: 'Scan Client',
      slug: `scan-client-${Date.now()}`,
    });
    expect(clientResponse.status).toBe(201);

    const domainResponse = await agent.post(`/api/workspaces/${organizationId}/clients/${clientResponse.body.id}/domains`).send({
      name: 'scan.test',
    });
    expect(domainResponse.status).toBe(201);
    await prisma.domain.update({
      where: { id: domainResponse.body.id },
      data: { status: 'VERIFIED', verifiedAt: new Date() },
    });

    const txtLookup = vi.spyOn(systemDnsReader, 'resolveTxt').mockImplementation(async (name) => {
      if (name === '_dmarc.scan.test') {
        return { status: 'found', value: [['v=DMARC1; p=reject; rua=mailto:reports@example.com']] };
      }
      if (name === 'scan.test') {
        return { status: 'found', value: [['v=spf1 include:_spf.example.com ~all']] };
      }
      if (name === 'default._domainkey.scan.test') {
        return { status: 'found', value: [['v=DKIM1; k=rsa; p=key']] };
      }
      // The scanner follows includes now, so the one in the SPF record has to
      // exist: an include of a name with no SPF record is a permanent error.
      if (name === '_spf.example.com') {
        return { status: 'found', value: [['v=spf1 ip4:192.0.2.0/24 ~all']] };
      }
      return { status: 'missing' };
    });
    const mxLookup = vi.spyOn(systemDnsReader, 'resolveMx').mockResolvedValue({
      status: 'found',
      value: [{ exchange: 'mx.scan.test', priority: 10 }],
    });

    try {
      const scan = await agent.post(`/api/workspaces/${organizationId}/domains/${domainResponse.body.id}/scans`);

      expect(scan.status).toBe(201);
      expect(scan.body.status).toBe('COMPLETED');
      expect(scan.body.result.status).toBe('healthy');
      expect(scan.body.result.score).toBe(100);
      expect(scan.body.domain.name).toBe('scan.test');
      expect(scan.body.requestedBy).toBeTruthy();

      const history = await agent.get(`/api/workspaces/${organizationId}/domains/${domainResponse.body.id}/scans`);
      expect(history.status).toBe(200);
      expect(history.body.rows).toHaveLength(1);
      expect(history.body.rows[0].id).toBe(scan.body.id);
      expect(history.body.rows[0].trigger).toBe('MANUAL');
      expect(history.body.rows[0].changeCount).toBe(0);

      const detail = await agent.get(`/api/workspaces/${organizationId}/scans/${scan.body.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.id).toBe(scan.body.id);
      expect(detail.body.result.dmarc.policy).toBe('reject');

      const domains = await agent.get(`/api/workspaces/${organizationId}/clients/${clientResponse.body.id}/domains`);
      expect(domains.status).toBe(200);
      expect(domains.body[0].score).toBe(100);
      expect(domains.body[0].dmarcPolicy).toBe('reject');
      expect(domains.body[0].lastScanAt).toBeTruthy();
      expect(domains.body[0].dkimSelectors).toEqual(['default']);
      expect(domains.body[0].mxRecords).toEqual([{ exchange: 'mx.scan.test', priority: 10 }]);
    } finally {
      txtLookup.mockRestore();
      mxLookup.mockRestore();
    }
  });

  it('requires domain verification before an authenticated scan', async () => {
    const { agent, organizationId } = await createWorkspace();
    const clientResponse = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
      name: 'Pending Scan Client',
      slug: `pending-scan-client-${Date.now()}`,
    });
    const domainResponse = await agent.post(`/api/workspaces/${organizationId}/clients/${clientResponse.body.id}/domains`).send({
      name: 'pending.test',
    });

    const scan = await agent.post(`/api/workspaces/${organizationId}/domains/${domainResponse.body.id}/scans`);

    expect(scan.status).toBe(409);
    const history = await agent.get(`/api/workspaces/${organizationId}/domains/${domainResponse.body.id}/scans`);
    expect(history.status).toBe(200);
    expect(history.body.rows).toHaveLength(0);
  });

  it('enforces workspace role permissions', async () => {
    const { agent, organizationId } = await createWorkspace();
    const clientResponse = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
      name: 'Permission Client',
      slug: `permission-client-${Date.now()}`,
    });
    const domainResponse = await agent.post(`/api/workspaces/${organizationId}/clients/${clientResponse.body.id}/domains`).send({
      name: 'permission.test',
    });
    await prisma.domain.update({
      where: { id: domainResponse.body.id },
      data: { status: 'VERIFIED', verifiedAt: new Date() },
    });
    await prisma.member.updateMany({ where: { organizationId }, data: { role: 'viewer' } });

    const createResponse = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
      name: 'Forbidden Client',
      slug: 'forbidden-client',
    });
    expect(createResponse.status).toBe(403);

    const scanResponse = await agent.post(`/api/workspaces/${organizationId}/domains/${domainResponse.body.id}/scans`);
    expect(scanResponse.status).toBe(403);

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

describe('bulk domain import from the console', () => {
  beforeAll(resetDatabase);

  // A name prefix per test. Domain names are unique across the whole
  // installation, not per workspace, so two tests that both used "taken.example"
  // would leave the second one asserting against the first one's row.
  let testNumber = 0;
  function uniqueName(label: string): string {
    testNumber += 1;
    return `bulk-${testNumber}-${label}.example`;
  }

  async function workspaceWithClient(): Promise<{
    agent: ReturnType<typeof request.agent>;
    organizationId: string;
    clientId: string;
  }> {
    const { agent, organizationId } = await createWorkspace();
    const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
      name: 'Bulk Agency',
      slug: `bulk-agency-${Date.now()}-${fixtureId}`,
    });
    expect(client.status).toBe(201);
    return { agent, organizationId, clientId: client.body.id as string };
  }

  it('imports many domains in one request and reports each row', async () => {
    const { agent, organizationId, clientId } = await workspaceWithClient();

    const response = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains/bulk`)
      .send({ domains: [uniqueName('one'), uniqueName('two'), uniqueName('three')] });

    expect(response.status).toBe(201);
    expect(response.body.created).toBe(3);
    expect(response.body.failed).toBe(0);
    expect(response.body.domains).toHaveLength(3);
    // The console renders a setup link per row and a DNS record to copy, so a row
    // missing a slug or a verification value would render a dead link or an
    // instruction the operator cannot follow.
    for (const domain of response.body.domains) {
      expect(domain.slug).toBeTruthy();
      expect(domain.verificationHost).toContain('_dmarc-harbor');
      expect(domain.verificationValue).toBeTruthy();
    }
  });

  it('creates nothing on a second run of the same list', async () => {
    // Deliberately one workspace for both runs. A second workspace would not do:
    // domain names are unique across the whole installation, so the same names
    // would come back as "already monitored by another workspace" and the test
    // would pass for the wrong reason.
    const { agent, organizationId, clientId } = await workspaceWithClient();
    const body = { domains: [uniqueName('repeat-one'), uniqueName('repeat-two')] };

    const first = await agent.post(`/api/workspaces/${organizationId}/clients/${clientId}/domains/bulk`).send(body);
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(2);

    // A paste that gets re-run must not create a second copy of anything, and
    // must say so per row rather than reporting success.
    const second = await agent.post(`/api/workspaces/${organizationId}/clients/${clientId}/domains/bulk`).send(body);
    expect(second.status).toBe(201);
    expect(second.body.created).toBe(0);
    expect(second.body.failed).toBe(2);
    expect(second.body.failures[0].reason).toMatch(/already in this workspace/i);

    const stored = await prisma.domain.count({ where: { name: body.domains[0], client: { organizationId } } });
    expect(stored).toBe(1);
  });

  it('marks a domain repeated inside one paste instead of creating it twice', async () => {
    const { agent, organizationId, clientId } = await workspaceWithClient();
    const doubled = uniqueName('doubled');

    const response = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains/bulk`)
      .send({ domains: [doubled, doubled] });

    expect(response.status).toBe(201);
    expect(response.body.created).toBe(1);
    expect(response.body.failed).toBe(1);

    const stored = await prisma.domain.count({ where: { name: doubled, client: { organizationId } } });
    expect(stored).toBe(1);
  });

  it('refuses a paste past the per-call limit, naming the limit', async () => {
    const { agent, organizationId, clientId } = await workspaceWithClient();

    // 501 short names is comfortably over the 500 cap yet well under the size at
    // which the body parser objects, so this asserts the cap itself and not the
    // parser. The message matters: a bare 413 tells an operator nothing about
    // what to change.
    const domains = Array.from({ length: 501 }, (_unused, index) => `cap-${index}.example`);
    const response = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains/bulk`)
      .send({ domains });

    expect(response.status).toBe(402);
    expect(response.body.error.message).toMatch(/up to 500 domains/i);
  });

  it('keeps a bulk import to one client even when another client owns the name', async () => {
    const { agent, organizationId, clientId } = await workspaceWithClient();
    const other = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
      name: 'Other Agency',
      slug: `other-agency-${Date.now()}-${fixtureId}`,
    });
    expect(other.status).toBe(201);

    const taken = uniqueName('taken');
    const response = await agent
      .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains/bulk`)
      .send({ domains: [taken] });
    expect(response.status).toBe(201);
    expect(response.body.created).toBe(1);

    const crossClient = await agent
      .post(`/api/workspaces/${organizationId}/clients/${other.body.id as string}/domains/bulk`)
      .send({ domains: [taken] });

    expect(crossClient.status).toBe(201);
    expect(crossClient.body.created).toBe(0);
    expect(crossClient.body.failed).toBe(1);
  });

  it('rejects a bulk import from a user outside the workspace', async () => {
    const { organizationId, clientId } = await workspaceWithClient();
    const outsider = request.agent(app);
    const email = `bulk-outsider-${Date.now()}@example.com`;
    await outsider.post('/api/auth/sign-up/email').send({ name: 'Outsider', email, password });
    await prisma.user.update({ where: { email }, data: { emailVerified: true } });
    await outsider.post('/api/auth/sign-in/email').send({ email, password });

    const response = await outsider
      .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains/bulk`)
      .send({ domains: [uniqueName('not-mine')] });

    expect(response.status).toBe(403);
  });
});
