import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/database/prisma.js';
import { grantPlan } from './helpers/plan.js';
import type { PolicyReadiness } from '../src/services/onboarding.service.js';
import { setProposalReadinessForTests } from '../src/services/policy-proposal/policy-proposal.service.js';
import {
  setHostedDmarcReadinessForTests,
  setHostedDmarcRefreshForTests,
} from '../src/services/hosted-dns/hosted-dmarc.service.js';
import { setHostedDnsProviderForTests, type HostedDnsProvider, type HostedTxt } from '../src/services/hosted-dns/provider.js';

/**
 * Client-approved enforcement end to end: the agency proposes, a portal
 * contact approves or declines, and a hosted record changes on approval.
 * Readiness and the hosted zone are replaced; everything else is real.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const zone = 'hosted.test';

class MemoryDnsProvider implements HostedDnsProvider {
  zone = zone;
  records: HostedTxt[] = [];
  fail = false;
  private next = 1;

  async get(name: string): Promise<HostedTxt[]> {
    return this.records.filter((record) => record.name === name).map((record) => ({ ...record }));
  }

  async create(name: string, content: string, comment: string): Promise<HostedTxt> {
    if (this.fail) throw new Error('Cloudflare refused the record.');
    const record = { id: `rec-${this.next++}`, name, content, comment };
    this.records.push(record);
    return { ...record };
  }

  async update(record: HostedTxt, content: string): Promise<HostedTxt> {
    if (this.fail) throw new Error('Cloudflare refused the change.');
    const stored = this.records.find((entry) => entry.id === record.id);
    if (!stored) throw new Error('Record not found.');
    stored.content = content;
    return { ...stored };
  }

  async remove(recordId: string): Promise<void> {
    this.records = this.records.filter((record) => record.id !== recordId);
  }

  async *listAll(): AsyncIterable<HostedTxt> {
    for (const record of [...this.records]) yield { ...record };
  }
}

function readiness(blockers: string[] = []): PolicyReadiness {
  return {
    level: blockers.length ? 'none' : 'quarantine',
    ready: blockers.length === 0,
    currentPolicy: 'none',
    testing: false,
    daysObserved: 34,
    daysAtCurrentPolicy: 34,
    dkimPassRatePercent: 99.6,
    messagesObserved: 2400,
    passRatePercent: 99.2,
    openAlerts: 0,
    staleAlerts: 0,
    failingSenders: 0,
    observedSenders: 4,
    blockers,
    blockersByLevel: { quarantine: blockers, reject: blockers },
  };
}

let provider: MemoryDnsProvider;
let blockers: string[] = [];

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "policy_proposal", "hosted_dmarc_change", "hosted_dmarc_record", "client_portal_access", "notification", "email_delivery", "rate_limit_bucket", "audit_log", "session", "account", "verification", "two_factor", member, invitation, "user", "organization" CASCADE',
  );
  env.HOSTED_DNS_ZONE = zone;
  provider = new MemoryDnsProvider();
  blockers = [];
  setHostedDnsProviderForTests(provider);
  setHostedDmarcRefreshForTests(async () => undefined);
  setHostedDmarcReadinessForTests(async () => readiness(blockers));
  setProposalReadinessForTests(async () => readiness(blockers));
});

afterEach(() => {
  setHostedDnsProviderForTests(null);
  setHostedDmarcRefreshForTests(null);
  setHostedDmarcReadinessForTests(null);
  setProposalReadinessForTests(null);
});

async function signUp(email: string, name: string) {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-up/email').send({ name, email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  return { agent, email, userId: user.id };
}

async function setup(plan: 'HARBOR' | 'FAIRWAY' = 'HARBOR', record = 'v=DMARC1; p=none; rua=mailto:dmarc@example.test') {
  fixtureId += 1;
  const owner = await signUp(`owner-${Date.now()}-${fixtureId}@agency.test`, 'Agency Owner');
  const workspace = await owner.agent.post('/api/workspaces').send({
    name: 'Northwind IT',
    slug: `northwind-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);
  const organizationId = workspace.body.id as string;
  await grantPlan(organizationId, plan);

  const addClient = async (label: string) => {
    const client = await owner.agent
      .post(`/api/workspaces/${organizationId}/clients`)
      .send({ name: label, slug: `${label.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}-${fixtureId}` });
    expect(client.status).toBe(201);
    const name = `${label.split(' ')[0]!.toLowerCase()}-${Date.now()}-${fixtureId}.example`;
    const domain = await owner.agent
      .post(`/api/workspaces/${organizationId}/clients/${client.body.id}/domains`)
      .send({ name });
    expect(domain.status).toBe(201);
    await prisma.domain.update({
      where: { id: domain.body.id },
      data: { status: 'VERIFIED', verifiedAt: new Date(), dmarcRecord: record, dmarcPolicy: 'none' },
    });
    return { clientId: client.body.id as string, domainId: domain.body.id as string, domainName: name };
  };

  const acme = await addClient('Acme Ltd');
  return { owner, organizationId, acme, addClient };
}

async function invite(fixture: Awaited<ReturnType<typeof setup>>, clientId: string, label: string) {
  const email = `${label}-${Date.now()}-${fixtureId}@client.test`;
  const granted = await fixture.owner.agent
    .post(`/api/workspaces/${fixture.organizationId}/clients/${clientId}/portal-access`)
    .send({ email });
  expect(granted.status).toBe(201);
  return signUp(email, `${label} Contact`);
}

const proposals = (organizationId: string, domainId: string) =>
  `/api/workspaces/${organizationId}/domains/${domainId}/policy-proposals`;

async function hostDomain(organizationId: string, domainId: string, value: string) {
  return prisma.hostedDmarcRecord.create({
    data: {
      organizationId,
      domainId,
      token: `tok${fixtureId}${Date.now()}`.slice(0, 16).toLowerCase(),
      value,
      status: 'ACTIVE',
      delegated: true,
      activatedAt: new Date(),
    },
  });
}

describe('client-approved enforcement', () => {
  it('needs a contact to ask, frozen open points to go ahead, and records who approved', async () => {
    const fixture = await setup();
    const url = proposals(fixture.organizationId, fixture.acme.domainId);

    const nobody = await fixture.owner.agent.post(url).send({ policy: 'quarantine' });
    expect(nobody.status).toBe(409);
    expect(nobody.body.error.code).toBe('NO_PORTAL_CONTACTS');

    const contact = await invite(fixture, fixture.acme.clientId, 'it');
    blockers = ['Only 812 messages observed. At least 1000 are needed before changing policy.'];
    const notReady = await fixture.owner.agent.post(url).send({ policy: 'quarantine' });
    expect(notReady.status).toBe(409);
    expect(notReady.body.error.code).toBe('POLICY_NOT_READY');
    expect(notReady.body.error.blockers).toEqual(blockers);

    const created = await fixture.owner.agent
      .post(url)
      .send({ policy: 'quarantine', note: 'Your mail has passed for a month.', acceptBlockers: true });
    expect(created.status).toBe(201);
    const proposal = created.body.proposal;
    expect(proposal).toMatchObject({ state: 'pending', applyVia: 'manual', blockers, note: 'Your mail has passed for a month.' });
    expect(proposal.from).toMatchObject({ policy: 'none', testing: false });
    expect(proposal.to).toMatchObject({ policy: 'quarantine', testing: false });
    expect(proposal.recordValue).toContain('p=quarantine');
    // The client's own report address is kept, beside ours.
    expect(proposal.recordValue).toMatch(/rua=mailto:[^;]*dmarc@example\.test/);
    expect(proposal.recordValue).toMatch(/rua=mailto:[^;]*@reports\./);

    const request_ = { to: contact.email, subject: { contains: 'asks your approval' } };
    await vi.waitFor(async () => {
      expect(await prisma.emailDelivery.count({ where: request_ })).toBe(1);
    });
    const email = await prisma.emailDelivery.findFirstOrThrow({ where: request_ });
    expect(email.subject).toContain('Northwind IT asks your approval');
    expect(email.text).toContain('Only 812 messages observed');
    expect(email.text).toContain(`/portal/domain/${fixture.acme.domainId}?org=`);

    const open = await contact.agent.get('/api/portal/policy-proposals');
    expect(open.status).toBe(200);
    expect(open.body.proposals).toHaveLength(1);
    expect(open.body.proposals[0].words.headline).toBe(`Send fake email that claims to be from ${fixture.acme.domainName} to spam`);
    expect(open.body.proposals[0].words.evidence).toContain('99.2% of the 2,400 messages');
    expect(open.body.proposals[0]).not.toHaveProperty('createdBy');

    const approved = await contact.agent.post(`/api/portal/policy-proposals/${proposal.id}/approve`).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.proposal.state).toBe('approved');
    expect(approved.body.proposal.decidedByEmail).toBe(contact.email);

    const again = await contact.agent.post(`/api/portal/policy-proposals/${proposal.id}/decline`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PROPOSAL_NOT_PENDING');

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'POLICY_PROPOSAL_APPROVED' } });
    expect(audit.actorUserId).toBe(contact.userId);
    expect(audit.domainId).toBe(fixture.acme.domainId);
    const created_ = await prisma.auditLog.findFirstOrThrow({ where: { action: 'POLICY_PROPOSAL_CREATED' } });
    expect((created_.detail as { blockersAccepted?: string[] }).blockersAccepted).toEqual(blockers);

    const notice = await prisma.notification.findFirstOrThrow({ where: { kind: 'POLICY_APPROVAL', userId: fixture.owner.userId } });
    expect(notice.title).toContain('approved, ready for you to publish');
    expect(notice.body).toContain('p=quarantine');

    // A manual record counts as published once the scan shows it.
    let listed = await fixture.owner.agent.get(url);
    expect(listed.body.proposals[0]).toMatchObject({ state: 'approved', published: false });
    await prisma.domain.update({
      where: { id: fixture.acme.domainId },
      data: { dmarcRecord: proposal.recordValue as string, dmarcPolicy: 'quarantine' },
    });
    listed = await fixture.owner.agent.get(url);
    expect(listed.body.proposals[0].published).toBe(true);
    expect(listed.body).toMatchObject({ contacts: 1, applyVia: 'manual' });
  });

  it('refuses a step that does not tighten what receivers apply, and a domain with no record', async () => {
    const fixture = await setup('HARBOR', 'v=DMARC1; p=quarantine; rua=mailto:dmarc@example.test');
    await invite(fixture, fixture.acme.clientId, 'it');
    const url = proposals(fixture.organizationId, fixture.acme.domainId);

    for (const body of [{ policy: 'quarantine' }, { policy: 'quarantine', testing: true }]) {
      const refused = await fixture.owner.agent.post(url).send(body);
      expect(refused.status, JSON.stringify(body)).toBe(409);
      expect(refused.body.error.code).toBe('NOT_STRICTER');
    }
    expect((await fixture.owner.agent.post(url).send({ policy: 'none' })).status).toBe(400);
    // The trial of reject is a step up from quarantine, though receivers still quarantine.
    expect((await fixture.owner.agent.post(url).send({ policy: 'reject', testing: true })).status).toBe(201);
    expect((await fixture.owner.agent.post(url).send({ policy: 'reject' })).status).toBe(201);

    await prisma.domain.update({ where: { id: fixture.acme.domainId }, data: { dmarcRecord: null } });
    const bare = await fixture.owner.agent.post(url).send({ policy: 'reject' });
    expect(bare.body.error.code).toBe('NO_DMARC_RECORD');
  });

  it('is part of the client portal plan', async () => {
    const fixture = await setup('FAIRWAY');
    const refused = await fixture.owner.agent.post(proposals(fixture.organizationId, fixture.acme.domainId)).send({ policy: 'quarantine' });
    expect(refused.status).toBe(402);
    expect(refused.body.error.feature).toBe('portal.client');
  });

  it("never shows or accepts an answer from another client's contact", async () => {
    const fixture = await setup();
    const beta = await fixture.addClient('Beta Co');
    await invite(fixture, fixture.acme.clientId, 'acme');
    const outsider = await invite(fixture, beta.clientId, 'beta');

    const created = await fixture.owner.agent.post(proposals(fixture.organizationId, fixture.acme.domainId)).send({ policy: 'quarantine' });
    expect(created.status).toBe(201);
    const id = created.body.proposal.id as string;

    expect((await outsider.agent.get('/api/portal/policy-proposals')).body.proposals).toEqual([]);
    expect((await outsider.agent.get(`/api/portal/domains/${fixture.acme.domainId}/policy-proposals`)).body.proposals).toEqual([]);
    const refused = await outsider.agent.post(`/api/portal/policy-proposals/${id}/approve`).send({});
    expect(refused.status).toBe(404);
    expect((await prisma.policyProposal.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');

    // Agency staff are not portal contacts and cannot answer for the client.
    expect((await fixture.owner.agent.post(`/api/portal/policy-proposals/${id}/approve`).send({})).status).toBe(403);
  });

  it('replaces an open request, and stops answers once withdrawn or expired', async () => {
    const fixture = await setup();
    const contact = await invite(fixture, fixture.acme.clientId, 'it');
    const url = proposals(fixture.organizationId, fixture.acme.domainId);

    const first = (await fixture.owner.agent.post(url).send({ policy: 'quarantine', testing: true })).body.proposal;
    const second = (await fixture.owner.agent.post(url).send({ policy: 'quarantine' })).body.proposal;
    expect((await prisma.policyProposal.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('SUPERSEDED');
    expect((await contact.agent.get('/api/portal/policy-proposals')).body.proposals.map((entry: { id: string }) => entry.id)).toEqual([second.id]);

    const withdrawn = await fixture.owner.agent.post(`/api/workspaces/${fixture.organizationId}/policy-proposals/${second.id}/withdraw`);
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.proposal.state).toBe('withdrawn');
    expect((await contact.agent.post(`/api/portal/policy-proposals/${second.id}/approve`).send({})).status).toBe(409);

    const third = (await fixture.owner.agent.post(url).send({ policy: 'quarantine' })).body.proposal;
    await prisma.policyProposal.update({ where: { id: third.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await contact.agent.post(`/api/portal/policy-proposals/${third.id}/approve`).send({});
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe('PROPOSAL_EXPIRED');
    expect((await fixture.owner.agent.get(url)).body.proposals[0].state).toBe('expired');
  });

  it('passes a decline and its reason to the agency, and changes nothing', async () => {
    const fixture = await setup();
    const contact = await invite(fixture, fixture.acme.clientId, 'it');
    const id = (await fixture.owner.agent.post(proposals(fixture.organizationId, fixture.acme.domainId)).send({ policy: 'quarantine' })).body
      .proposal.id as string;

    const declined = await contact.agent
      .post(`/api/portal/policy-proposals/${id}/decline`)
      .send({ reason: 'Our booking system sends as us. Check it first.' });
    expect(declined.status).toBe(200);
    expect(declined.body.proposal).toMatchObject({ state: 'declined', declineReason: 'Our booking system sends as us. Check it first.' });

    const notice = await prisma.notification.findFirstOrThrow({ where: { kind: 'POLICY_APPROVAL' } });
    expect(notice.severity).toBe('WARNING');
    expect(notice.body).toContain('Our booking system sends as us.');
    await vi.waitFor(async () => {
      expect(await prisma.emailDelivery.count({ where: { to: fixture.owner.email, subject: { contains: 'declined' } } })).toBe(1);
    });
    expect((await prisma.domain.findUniqueOrThrow({ where: { id: fixture.acme.domainId } })).dmarcRecord).toContain('p=none');
  });

  it('changes a hosted record on approval, and keeps the approval when the provider refuses', async () => {
    const fixture = await setup();
    const contact = await invite(fixture, fixture.acme.clientId, 'it');
    const hosted = await hostDomain(fixture.organizationId, fixture.acme.domainId, 'v=DMARC1; p=none; rua=mailto:dmarc@example.test');
    const url = proposals(fixture.organizationId, fixture.acme.domainId);

    const first = (await fixture.owner.agent.post(url).send({ policy: 'quarantine' })).body.proposal;
    expect(first.applyVia).toBe('hosted');
    const approved = await contact.agent.post(`/api/portal/policy-proposals/${first.id}/approve`).send({});
    expect(approved.status).toBe(200);

    const row = await prisma.hostedDmarcRecord.findUniqueOrThrow({ where: { id: hosted.id } });
    expect(row.value).toContain('p=quarantine');
    expect(row.version).toBe(2);
    expect(provider.records.some((record) => record.content.includes('p=quarantine'))).toBe(true);
    const applied = await prisma.policyProposal.findUniqueOrThrow({ where: { id: first.id } });
    expect(applied.appliedAt).not.toBeNull();
    expect(applied.applyError).toBeNull();
    const change = await prisma.hostedDmarcChange.findFirstOrThrow({ where: { recordId: hosted.id, reason: 'policy' } });
    expect(change.actorUserId).toBe(contact.userId);

    // Reject is refused by the provider: the approval stands, the record does not move.
    provider.fail = true;
    const second = (await fixture.owner.agent.post(url).send({ policy: 'reject' })).body.proposal;
    expect((await contact.agent.post(`/api/portal/policy-proposals/${second.id}/approve`).send({})).status).toBe(200);
    const stuck = await prisma.policyProposal.findUniqueOrThrow({ where: { id: second.id } });
    expect(stuck.status).toBe('APPROVED');
    expect(stuck.appliedAt).toBeNull();
    expect(stuck.applyError).toContain('Cloudflare refused');
    expect((await prisma.hostedDmarcRecord.findUniqueOrThrow({ where: { id: hosted.id } })).value).toContain('p=quarantine');
    const warning = await prisma.notification.findFirstOrThrow({
      where: { kind: 'POLICY_APPROVAL', policyProposalId: second.id, userId: fixture.owner.userId },
    });
    expect(warning.title).toContain('the record was not changed');

    provider.fail = false;
    const retried = await fixture.owner.agent.post(`/api/workspaces/${fixture.organizationId}/policy-proposals/${second.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body.proposal).toMatchObject({ state: 'approved', published: true, applyError: null });
    expect((await prisma.hostedDmarcRecord.findUniqueOrThrow({ where: { id: hosted.id } })).value).toContain('p=reject');
    expect((await fixture.owner.agent.post(`/api/workspaces/${fixture.organizationId}/policy-proposals/${second.id}/retry`)).status).toBe(409);
  });

  it('leaves a hosted record alone when evidence turns after a proposal made without open points', async () => {
    const fixture = await setup();
    const contact = await invite(fixture, fixture.acme.clientId, 'it');
    const hosted = await hostDomain(fixture.organizationId, fixture.acme.domainId, 'v=DMARC1; p=none; rua=mailto:dmarc@example.test');

    const proposal = (await fixture.owner.agent.post(proposals(fixture.organizationId, fixture.acme.domainId)).send({ policy: 'quarantine' })).body
      .proposal;
    blockers = ['A new sender, Mailchimp, is failing DMARC.'];
    expect((await contact.agent.post(`/api/portal/policy-proposals/${proposal.id}/approve`).send({})).status).toBe(200);

    const row = await prisma.policyProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(row.appliedAt).toBeNull();
    expect(row.applyError).toContain('The evidence changed after this was proposed');
    expect(row.applyError).toContain('Mailchimp');
    expect((await prisma.hostedDmarcRecord.findUniqueOrThrow({ where: { id: hosted.id } })).value).toContain('p=none');
  });
});
