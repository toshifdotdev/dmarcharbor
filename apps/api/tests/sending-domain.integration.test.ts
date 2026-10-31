import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index.js';
import { prisma } from '../src/database/prisma.js';
import { env } from '../src/config/env.js';
import { grantPlan } from './helpers/plan.js';
import { addressOf } from '../src/email/sender.js';
import { resolveBranding } from '../src/services/branding.service.js';
import { deleteWorkspace } from '../src/services/lifecycle-deletion.service.js';
import {
  SendingDomainProviderError,
  setSendingDomainProviderForTests,
  type ProviderDomain,
  type SendingDomainProvider,
  type SendingDomainRecord,
} from '../src/services/branding/sending-domain-provider.js';

/**
 * The agency's support contact (Harbor and up) and its own sending domain
 * (Admiralty), end to end through the routes, with the email provider replaced
 * by a fake that records every call.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const agencyName = 'Wistholm IT';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "email_delivery", "rate_limit_bucket", "client_portal_access", "entitlement_override", "subscription", "audit_log", "notification", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "two_factor", "user" CASCADE',
  );
}

/** A provider that answers like Resend and remembers what it was asked. */
class FakeProvider implements SendingDomainProvider {
  created: string[] = [];
  verified: string[] = [];
  removed: string[] = [];
  statuses = new Map<string, { name: string; status: string }>();
  /** Runs inside `create`, before it answers, to stage a race. */
  duringCreate: ((name: string) => Promise<void>) | null = null;
  failCreate: string | null = null;
  private next = 0;

  private records(name: string, status: string): SendingDomainRecord[] {
    const recordStatus = status === 'verified' ? 'verified' : 'pending';
    return [
      { record: 'DKIM', type: 'TXT', name: `resend._domainkey.${name}`, value: 'p=MIGfFAKE', priority: null, status: recordStatus },
      { record: 'SPF', type: 'MX', name: `send.${name}`, value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10, status: recordStatus },
      { record: 'SPF', type: 'TXT', name: `send.${name}`, value: 'v=spf1 include:amazonses.com ~all', priority: null, status: recordStatus },
    ];
  }

  async create(name: string): Promise<ProviderDomain> {
    if (this.failCreate) {
      throw new SendingDomainProviderError(this.failCreate, 'validation_error');
    }
    if (this.duringCreate) {
      await this.duringCreate(name);
    }
    this.next += 1;
    const id = `fake-${this.next}`;
    this.created.push(id);
    this.statuses.set(id, { name, status: 'not_started' });
    return { id, status: 'not_started', records: this.records(name, 'not_started') };
  }

  async get(id: string): Promise<ProviderDomain> {
    const found = this.statuses.get(id);
    if (!found) throw new SendingDomainProviderError('Domain not found.', 'not_found');
    return { id, status: found.status, records: this.records(found.name, found.status) };
  }

  async verify(id: string): Promise<void> {
    this.verified.push(id);
  }

  async remove(id: string): Promise<void> {
    this.removed.push(id);
    this.statuses.delete(id);
  }

  /** What the real provider does once it has seen the agency's records. */
  setStatus(id: string, status: string): void {
    const found = this.statuses.get(id);
    if (found) found.status = status;
  }
}

let provider = new FakeProvider();

async function setup(plan: 'FAIRWAY' | 'HARBOR' | 'ADMIRALTY' = 'ADMIRALTY') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `owner-${Date.now()}-${fixtureId}@wistholm.example`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Agency Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: agencyName,
    slug: `wistholm-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);
  const organizationId = workspace.body.id as string;
  await grantPlan(organizationId, plan);

  const sendingDomain = `mail.wistholm-${fixtureId}.example`;
  return { agent, organizationId, email, sendingDomain, address: `reports@${sendingDomain}` };
}

/** Senders are fire and forget, so the row is waited for rather than read once. */
async function queuedEmail(to: string, subjectPart: string) {
  return vi.waitFor(
    async () => {
      const row = await prisma.emailDelivery.findFirst({
        where: { to, subject: { contains: subjectPart } },
        orderBy: { createdAt: 'desc' },
      });
      if (!row) throw new Error(`No email to ${to} about "${subjectPart}" yet.`);
      return row;
    },
    { timeout: 5_000, interval: 50 },
  );
}

beforeAll(resetDatabase);
beforeEach(() => {
  provider = new FakeProvider();
  setSendingDomainProviderForTests(provider);
});
afterAll(() => setSendingDomainProviderForTests(null));

describe('the support contact', () => {
  it('saves a support email and page on Harbor and presents them to clients', async () => {
    const { agent, organizationId } = await setup('HARBOR');

    const saved = await agent.patch(`/api/workspaces/${organizationId}/branding`).send({
      supportEmail: 'Help@Wistholm.EXAMPLE',
      supportUrl: 'https://wistholm.example/help',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.supportEmail).toBe('Help@wistholm.example');
    expect(saved.body.supportUrl).toBe('https://wistholm.example/help');

    const stored = await agent.get(`/api/workspaces/${organizationId}/branding`);
    expect(stored.status).toBe(200);
    expect(stored.body.brandSupportEmail).toBe('Help@wistholm.example');
    expect(stored.body.brandSupportUrl).toBe('https://wistholm.example/help');

    const events = await prisma.auditLog.findMany({ where: { organizationId, action: 'BRANDING_UPDATED' } });
    expect(events.some((event) => (event.detail as Record<string, unknown>)?.brandSupportEmail === 'Help@wistholm.example')).toBe(true);

    // null and "" clear.
    const cleared = await agent.patch(`/api/workspaces/${organizationId}/branding`).send({ supportEmail: null, supportUrl: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.supportEmail).toBeNull();
    expect(cleared.body.supportUrl).toBeNull();
  });

  it('refuses an address that is not one plain address, and a page that is not https', async () => {
    const { agent, organizationId } = await setup('HARBOR');

    const email = await agent
      .patch(`/api/workspaces/${organizationId}/branding`)
      .send({ supportEmail: 'Wistholm IT <help@wistholm.example>' });
    expect(email.status).toBe(400);
    expect(email.body.error).toEqual({
      code: 'INVALID_REQUEST',
      message: 'The support email must be one address, for example help@youragency.example.',
    });

    const page = await agent.patch(`/api/workspaces/${organizationId}/branding`).send({ supportUrl: 'http://wistholm.example/help' });
    expect(page.status).toBe(400);
    expect(page.body.error.message).toBe('The support page must be a full https address.');

    const row = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(row.brandSupportEmail).toBeNull();
    expect(row.brandSupportUrl).toBeNull();
  });

  it('is not presented below white label, and cannot be set there', async () => {
    const { agent, organizationId } = await setup('FAIRWAY');

    const refused = await agent.patch(`/api/workspaces/${organizationId}/branding`).send({ supportEmail: 'help@wistholm.example' });
    expect(refused.status).toBe(402);

    await prisma.organization.update({ where: { id: organizationId }, data: { brandSupportEmail: 'help@wistholm.example' } });
    const resolved = await resolveBranding(organizationId);
    expect(resolved.supportEmail).toBeNull();
    expect(resolved.supportUrl).toBeNull();
  });
});

describe("the agency's own sending domain", () => {
  it('claims an address on Admiralty and answers the records to publish', async () => {
    const { agent, organizationId, address, sendingDomain } = await setup('ADMIRALTY');

    const claimed = await agent.put(`/api/workspaces/${organizationId}/branding/sending-domain`).send({ address: address.toUpperCase() });
    expect(claimed.status).toBe(200);
    expect(claimed.body).toEqual({
      sendingAddress: address,
      status: 'not_started',
      records: expect.arrayContaining([
        expect.objectContaining({ record: 'DKIM', type: 'TXT', name: `resend._domainkey.${sendingDomain}` }),
        expect.objectContaining({ record: 'SPF', type: 'MX', name: `send.${sendingDomain}`, priority: 10 }),
        expect.objectContaining({ record: 'SPF', type: 'TXT', name: `send.${sendingDomain}`, priority: null }),
      ]),
      verified: false,
      notice:
        'Publish these records at your DNS host, then check them. Client email keeps coming from the shared address with your name until they are verified.',
    });
    expect(provider.created).toHaveLength(1);

    const stored = await agent.get(`/api/workspaces/${organizationId}/branding`);
    expect(stored.body.sendingAddress).toBe(address);
    expect(stored.body.sendingDomainStatus).toBe('not_started');
    expect(stored.body.sendingDomainRecords).toHaveLength(3);
    expect(stored.body.sendingDomainVerifiedAt).toBeNull();
    expect(stored.body.sendingDomainCheckedAt).not.toBeNull();
    // The provider's id is ours, never the agency's.
    expect(stored.body).not.toHaveProperty('sendingDomainProviderId');
    expect(JSON.stringify(stored.body)).not.toContain(provider.created[0]);

    // Not used until the provider has verified it.
    expect((await resolveBranding(organizationId)).sendingAddress).toBeNull();
  });

  it('refuses Harbor with 402, and lets any plan remove a kept address', async () => {
    const { agent, organizationId, address, sendingDomain } = await setup('HARBOR');

    const refused = await agent.put(`/api/workspaces/${organizationId}/branding/sending-domain`).send({ address });
    expect(refused.status).toBe(402);
    expect(refused.body.error.feature).toBe('branding.customDomain');
    expect((await agent.post(`/api/workspaces/${organizationId}/branding/sending-domain/verify`)).status).toBe(402);
    expect(provider.created).toHaveLength(0);

    // Kept from Admiralty after a downgrade: not used, and removable.
    await prisma.organization.update({
      where: { id: organizationId },
      data: {
        sendingDomain,
        sendingLocalPart: 'reports',
        sendingDomainProviderId: 'fake-kept',
        sendingDomainStatus: 'verified',
        sendingDomainVerifiedAt: new Date(),
      },
    });
    expect((await resolveBranding(organizationId)).sendingAddress).toBeNull();

    const removed = await agent.put(`/api/workspaces/${organizationId}/branding/sending-domain`).send({ address: null });
    expect(removed.status).toBe(200);
    expect(removed.body.sendingAddress).toBeNull();
    expect(provider.removed).toEqual(['fake-kept']);
  });

  it('refuses a domain of ours, and a subdomain of one', async () => {
    const { agent, organizationId } = await setup('ADMIRALTY');
    const ourDomain = addressOf(env.EMAIL_FROM)!.split('@')[1]!;
    const ours = "That domain is ours, so it cannot be an agency's sending domain.";

    for (const address of [`reports@${ourDomain}`, `reports@mail.${ourDomain}`]) {
      const refused = await agent.put(`/api/workspaces/${organizationId}/branding/sending-domain`).send({ address });
      expect(refused.status, address).toBe(400);
      expect(refused.body.error).toEqual({ code: 'INVALID_REQUEST', message: ours });
    }
    expect(provider.created).toHaveLength(0);
  });

  it('refuses a domain another workspace sends from, without touching the provider', async () => {
    const first = await setup('ADMIRALTY');
    const second = await setup('ADMIRALTY');

    expect(
      (await first.agent.put(`/api/workspaces/${first.organizationId}/branding/sending-domain`).send({ address: first.address })).status,
    ).toBe(200);

    const refused = await second.agent
      .put(`/api/workspaces/${second.organizationId}/branding/sending-domain`)
      .send({ address: `hello@${first.sendingDomain}` });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('SENDING_DOMAIN_TAKEN');
    expect(provider.created).toHaveLength(1);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: second.organizationId } })).sendingDomain).toBeNull();
  });

  it('loses a race for the same domain cleanly: 409, and the provider domain it created is removed', async () => {
    const first = await setup('ADMIRALTY');
    const second = await setup('ADMIRALTY');

    // The first workspace saves the domain while the second is waiting on the
    // provider, which is the window the unique index exists for.
    provider.duringCreate = async (name) => {
      await prisma.organization.update({
        where: { id: first.organizationId },
        data: { sendingDomain: name, sendingLocalPart: 'reports', sendingDomainProviderId: 'fake-first' },
      });
    };

    const refused = await second.agent
      .put(`/api/workspaces/${second.organizationId}/branding/sending-domain`)
      .send({ address: first.address });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toEqual({
      code: 'SENDING_DOMAIN_TAKEN',
      message: 'That domain is already used for sending by another workspace.',
    });

    expect(provider.created).toHaveLength(1);
    expect(provider.removed).toEqual(provider.created);
    const loser = await prisma.organization.findUniqueOrThrow({ where: { id: second.organizationId } });
    expect(loser.sendingDomain).toBeNull();
    expect(loser.sendingDomainProviderId).toBeNull();
  });

  it('answers 502 with the provider reason when the provider refuses the domain', async () => {
    const { agent, organizationId, address, sendingDomain } = await setup('ADMIRALTY');
    provider.failCreate = 'The domain has been registered already.';

    const refused = await agent.put(`/api/workspaces/${organizationId}/branding/sending-domain`).send({ address });
    expect(refused.status).toBe(502);
    expect(refused.body.error.code).toBe('SENDING_DOMAIN_PROVIDER_ERROR');
    expect(refused.body.error.message).toContain(sendingDomain);
    expect(refused.body.error.message).toContain('The domain has been registered already');
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).sendingDomain).toBeNull();
  });

  it('refuses a check before an address is set', async () => {
    const { agent, organizationId } = await setup('ADMIRALTY');

    const refused = await agent.post(`/api/workspaces/${organizationId}/branding/sending-domain/verify`);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('INVALID_REQUEST');
  });

  it('flips to verified on the check, once, and back when the provider stops verifying it', async () => {
    const { agent, organizationId, address } = await setup('ADMIRALTY');
    await agent.put(`/api/workspaces/${organizationId}/branding/sending-domain`).send({ address });
    const providerId = provider.created[0]!;

    const pending = await agent.post(`/api/workspaces/${organizationId}/branding/sending-domain/verify`);
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({ sendingAddress: address, status: 'not_started', verified: false });
    expect(provider.verified).toEqual([providerId]);

    provider.setStatus(providerId, 'verified');
    const verified = await agent.post(`/api/workspaces/${organizationId}/branding/sending-domain/verify`);
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ sendingAddress: address, status: 'verified', verified: true });
    expect(verified.body.records.every((record: SendingDomainRecord) => record.status === 'verified')).toBe(true);
    expect((await resolveBranding(organizationId)).sendingAddress).toBe(address);

    // A second check changes nothing and records nothing more.
    await agent.post(`/api/workspaces/${organizationId}/branding/sending-domain/verify`);
    const events = await prisma.auditLog.findMany({ where: { organizationId, action: 'SENDING_DOMAIN_VERIFIED' } });
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({ sendingDomain: address.split('@')[1] });

    const stored = await agent.get(`/api/workspaces/${organizationId}/branding`);
    expect(stored.body.sendingDomainVerifiedAt).not.toBeNull();

    // The agency unpublished a record: mail goes back to the shared address.
    provider.setStatus(providerId, 'failed');
    const lapsed = await agent.post(`/api/workspaces/${organizationId}/branding/sending-domain/verify`);
    expect(lapsed.body).toMatchObject({ status: 'failed', verified: false });
    expect((await resolveBranding(organizationId)).sendingAddress).toBeNull();
  });

  it('keeps the verification when only the part before the @ changes', async () => {
    const { agent, organizationId, address, sendingDomain } = await setup('ADMIRALTY');
    await agent.put(`/api/workspaces/${organizationId}/branding/sending-domain`).send({ address });
    provider.setStatus(provider.created[0]!, 'verified');
    await agent.post(`/api/workspaces/${organizationId}/branding/sending-domain/verify`);

    const renamed = await agent
      .put(`/api/workspaces/${organizationId}/branding/sending-domain`)
      .send({ address: `hello@${sendingDomain}` });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ sendingAddress: `hello@${sendingDomain}`, verified: true });
    expect(renamed.body.notice).toBe(`Client email comes from hello@${sendingDomain}.`);
    expect(provider.created).toHaveLength(1);
    expect((await resolveBranding(organizationId)).sendingAddress).toBe(`hello@${sendingDomain}`);
  });

  it('sends a portal invitation from the verified address, with the support email as Reply-To', async () => {
    const { agent, organizationId, address } = await setup('ADMIRALTY');
    const supportEmail = `help@wistholm-${fixtureId}.example`;
    expect((await agent.patch(`/api/workspaces/${organizationId}/branding`).send({ supportEmail })).status).toBe(200);
    await agent.put(`/api/workspaces/${organizationId}/branding/sending-domain`).send({ address });
    provider.setStatus(provider.created[0]!, 'verified');
    expect((await agent.post(`/api/workspaces/${organizationId}/branding/sending-domain/verify`)).body.verified).toBe(true);

    const client = await agent
      .post(`/api/workspaces/${organizationId}/clients`)
      .send({ name: 'Pellowyn Dental', slug: `pellowyn-${Date.now()}-${fixtureId}` });
    expect(client.status).toBe(201);
    const contactEmail = `invited-${Date.now()}-${fixtureId}@pellowyn.example`;
    const granted = await agent
      .post(`/api/workspaces/${organizationId}/clients/${client.body.id}/portal-access`)
      .send({ email: contactEmail });
    expect(granted.status).toBeLessThan(300);

    const email = await queuedEmail(contactEmail, 'DMARC reports for');
    expect(email.fromHeader).toBe(`"${agencyName}" <${address}>`);
    expect(email.replyToHeader).toBe(supportEmail);
    expect(email.text).toContain(`Questions? Contact ${agencyName} at ${supportEmail}.`);
    expect(email.html).toContain(`mailto:${supportEmail}`);
  });

  it('keeps staff mail free of the agency headers', async () => {
    const { agent, organizationId, address, email: ownerEmail } = await setup('ADMIRALTY');
    await agent.patch(`/api/workspaces/${organizationId}/branding`).send({ supportEmail: 'help@wistholm.example' });
    await agent.put(`/api/workspaces/${organizationId}/branding/sending-domain`).send({ address });
    provider.setStatus(provider.created[0]!, 'verified');
    await agent.post(`/api/workspaces/${organizationId}/branding/sending-domain/verify`);

    // A staff member's reset on our own host.
    expect(
      (await request(app).post('/api/auth/request-password-reset').send({ email: ownerEmail, redirectTo: '/sign-in' })).status,
    ).toBe(200);
    const reset = await queuedEmail(ownerEmail, 'Reset your');
    expect(reset.fromHeader).toBeNull();
    expect(reset.replyToHeader).toBeNull();
    expect(reset.text).not.toContain('Questions?');
  });

  it('removes the domain from the provider when the address is removed or replaced', async () => {
    const { agent, organizationId, address } = await setup('ADMIRALTY');
    await agent.put(`/api/workspaces/${organizationId}/branding/sending-domain`).send({ address });
    const firstId = provider.created[0]!;

    const replaced = await agent
      .put(`/api/workspaces/${organizationId}/branding/sending-domain`)
      .send({ address: `reports@mail2.wistholm-${fixtureId}.example` });
    expect(replaced.status).toBe(200);
    expect(provider.removed).toEqual([firstId]);
    const secondId = provider.created[1]!;

    const removed = await agent.put(`/api/workspaces/${organizationId}/branding/sending-domain`).send({ address: null });
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({
      sendingAddress: null,
      status: null,
      records: [],
      verified: false,
      notice: 'Client email comes from the shared address with your name again.',
    });
    expect(provider.removed).toEqual([firstId, secondId]);

    const row = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(row.sendingDomain).toBeNull();
    expect(row.sendingDomainProviderId).toBeNull();
    expect(row.sendingDomainRecords).toBeNull();

    const stored = await agent.get(`/api/workspaces/${organizationId}/branding`);
    expect(stored.body.sendingAddress).toBeNull();
    expect(stored.body.sendingDomainRecords).toEqual([]);
  });

  it('removes the domain from the provider when the workspace is deleted', async () => {
    const { agent, organizationId, address, email } = await setup('ADMIRALTY');
    await agent.put(`/api/workspaces/${organizationId}/branding/sending-domain`).send({ address });
    const providerId = provider.created[0]!;
    const owner = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });

    const deleted = await deleteWorkspace(organizationId, owner.id);
    expect(deleted.ok).toBe(true);
    expect(provider.removed).toEqual([providerId]);
  });
});
