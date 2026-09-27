import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { grantPlan } from './helpers/plan.js';
import { resolveBranding, validateColour, validateCustomDomain, validateLogoUrl } from '../src/services/branding.service.js';
import { reverifyUnverifiedDomains } from '../src/services/domain-reverify.service.js';
import { systemDnsReader } from '../src/scanner/dns.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setup(plan: 'MOORING' | 'FAIRWAY' | 'HARBOR' | 'ADMIRALTY' = 'ADMIRALTY') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `brand-${Date.now()}-${fixtureId}@northgate.test`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Brand Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({ name: 'Northgate Digital', slug: `b-${Date.now()}-${fixtureId}` });
  const organizationId = workspace.body.id as string;
  if (plan !== 'MOORING') {
    await grantPlan(organizationId, plan);
  }

  return { agent, organizationId, email };
}

describe('background domain re-verification', () => {
  beforeAll(resetDatabase);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('picks up a record that was published with nobody watching', async () => {
    const { agent, organizationId } = await setup();
    const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({ name: 'Acme', slug: `a-${Date.now()}-${fixtureId}` });
    const domain = await agent
      .post(`/api/workspaces/${organizationId}/clients/${client.body.id}/domains`)
      .send({ name: 'late.test' });

    const row = await prisma.domain.findUniqueOrThrow({ where: { id: domain.body.id } });
    expect(row.status).toBe('PENDING');

    // Aged past the backoff so the job will consider it, and DNS now resolves.
    await prisma.domain.update({
      where: { id: row.id },
      data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const original = systemDnsReader.resolveTxt;
    const looked: string[] = [];
    systemDnsReader.resolveTxt = (async (host: string) => {
      looked.push(host);
      return { status: 'found', value: [[`dmarc-harbor-verification=${row.verificationToken}`]] };
    }) as typeof systemDnsReader.resolveTxt;

    try {
      const outcome = await reverifyUnverifiedDomains();
      expect(outcome.checked).toBe(1);
      expect(outcome.verified).toBe(1);
      expect(looked).toContain(`_dmarc-harbor-verification.late.test`);

      const after = await prisma.domain.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.status).toBe('VERIFIED');
      expect(after.verifiedAt).not.toBeNull();
    } finally {
      systemDnsReader.resolveTxt = original;
    }
  });

  it('leaves a domain alone while its record has not had time to propagate', async () => {
    const { agent, organizationId } = await setup();
    const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({ name: 'Fresh', slug: `f-${Date.now()}-${fixtureId}` });
    await agent.post(`/api/workspaces/${organizationId}/clients/${client.body.id}/domains`).send({ name: 'fresh.test' });

    const outcome = await reverifyUnverifiedDomains();
    expect(outcome.checked).toBe(0);
  });

  it('flags a verified domain whose proof was later removed', async () => {
    const { agent, organizationId } = await setup();
    const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({ name: 'Lapsed', slug: `l-${Date.now()}-${fixtureId}` });
    const domain = await agent
      .post(`/api/workspaces/${organizationId}/clients/${client.body.id}/domains`)
      .send({ name: 'lapsed.test' });

    await prisma.domain.update({
      where: { id: domain.body.id },
      data: {
        status: 'VERIFIED',
        verifiedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      },
    });

    const original = systemDnsReader.resolveTxt;
    systemDnsReader.resolveTxt = (async () => ({ status: 'missing' })) as typeof systemDnsReader.resolveTxt;

    try {
      const outcome = await reverifyUnverifiedDomains();
      expect(outcome.failed).toBe(1);

      const after = await prisma.domain.findUniqueOrThrow({ where: { id: domain.body.id } });
      expect(after.status).toBe('FAILED');
      expect(after.verifiedAt).toBeNull();
    } finally {
      systemDnsReader.resolveTxt = original;
    }
  });

  it('never re-emits domain.verified for an already verified domain', async () => {
    const { agent, organizationId } = await setup();
    const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({ name: 'Stable', slug: `s-${Date.now()}-${fixtureId}` });
    const domain = await agent
      .post(`/api/workspaces/${organizationId}/clients/${client.body.id}/domains`)
      .send({ name: 'stable.test' });

    await prisma.domain.update({
      where: { id: domain.body.id },
      data: { status: 'VERIFIED', verifiedAt: new Date(Date.now() - 48 * 60 * 60 * 1000), createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    });

    const original = systemDnsReader.resolveTxt;
    systemDnsReader.resolveTxt = (async () => ({ status: 'missing' })) as typeof systemDnsReader.resolveTxt;

    try {
      await reverifyUnverifiedDomains();
      const deliveries = await prisma.webhookDelivery.count({ where: { event: 'domain.verified' } });
      expect(deliveries).toBe(0);
    } finally {
      systemDnsReader.resolveTxt = original;
    }
  });
});

describe('white label branding', () => {
  beforeAll(resetDatabase);
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rejects unusable logos and colours before saving', () => {
    expect(validateLogoUrl('http://cdn.example.com/logo.png')).toEqual({ error: 'The logo must be served over https.' });
    expect(validateLogoUrl('not a url')).toEqual({ error: 'The logo must be a full https URL.' });
    expect(validateLogoUrl('https://cdn.example.com/logo.png')).toEqual({ url: 'https://cdn.example.com/logo.png' });

    const bad = validateColour('blue', 'The primary colour');
    const short = validateColour('#12345', 'The primary colour');
    const good = validateColour('#A1B2C3', 'The primary colour');

    expect('error' in bad && bad.error).toContain('hex');
    expect('error' in short && short.error).toContain('hex');
    expect('colour' in good && good.colour).toBe('#a1b2c3');

    const ok = validateCustomDomain('https://reports.northgate.test');
    expect('domain' in ok && ok.domain).toBe('reports.northgate.test');
    expect('error' in validateCustomDomain('reports.northgate.test')).toBe(true);
  });

  it('saves a logo and colours on an Admiralty workspace', async () => {
    const { agent, organizationId } = await setup('ADMIRALTY');

    const updated = await agent.patch(`/api/workspaces/${organizationId}/branding`).send({
      logoUrl: 'https://cdn.northgate.test/logo.svg',
      primaryColor: '#1A2B3C',
      accentColor: '#C9D1D9',
    });

    expect(updated.status).toBe(200);
    expect(updated.body.logoUrl).toBe('https://cdn.northgate.test/logo.svg');
    expect(updated.body.primaryColor).toBe('#1a2b3c');
    expect(updated.body.branded).toBe(true);
  });

  it('refuses branding below Admiralty, so a cheap plan cannot look like a branded agency', async () => {
    const { agent, organizationId } = await setup('HARBOR');

    const refused = await agent.patch(`/api/workspaces/${organizationId}/branding`).send({ logoUrl: 'https://cdn.test/l.png' });
    expect(refused.status).toBe(402);
    expect(refused.body.error.feature).toBe('branding.whitelabel');
    expect(refused.body.error.requiredIn).toBe('ADMIRALTY');

    await prisma.organization.update({
      where: { id: organizationId },
      data: { brandLogoUrl: 'https://cdn.test/secret-logo.png' },
    });

    // Even with values stored, a plan without the licence presents none of them.
    const resolved = await resolveBranding(organizationId);
    expect(resolved.logoUrl).toBeNull();
    expect(resolved.branded).toBe(false);
    expect(resolved.workspaceName).toBe('Northgate Digital');
  });

  it('does not use a custom domain until its DNS record is verified', async () => {
    const { agent, organizationId } = await setup('ADMIRALTY');
    const host = `proof-${fixtureId}.northgate.test`;

    const set = await agent.put(`/api/workspaces/${organizationId}/branding/custom-domain`).send({
      customDomain: `https://${host}`,
    });

    expect(set.status).toBe(200);
    expect(set.body.customDomain).toBe(host);
    expect(set.body.verificationHost).toBe(`_dmarc-harbor-branding.${host}`);
    expect(set.body.verificationValue).toMatch(/^dmarc-harbor-branding=/);

    const unverified = await resolveBranding(organizationId);
    expect(unverified.customDomain).toBeNull();
    expect(unverified.customDomainVerified).toBe(false);

    const original = systemDnsReader.resolveTxt;
    const token = (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).customDomainToken!;
    systemDnsReader.resolveTxt = (async () => ({
      status: 'found',
      value: [[`dmarc-harbor-branding=${token}`]],
    })) as typeof systemDnsReader.resolveTxt;

    try {
      const verified = await agent.post(`/api/workspaces/${organizationId}/branding/custom-domain/verify`);
      expect(verified.status).toBe(200);
      expect(verified.body.verified).toBe(true);

      const resolved = await resolveBranding(organizationId);
      expect(resolved.customDomain).toBe(host);
      expect(resolved.customDomainVerified).toBe(true);

      const events = await prisma.auditLog.findMany({ where: { organizationId, action: 'CUSTOM_DOMAIN_VERIFIED' } });
      expect(events).toHaveLength(1);
    } finally {
      systemDnsReader.resolveTxt = original;
    }
  });

  it('removes a custom domain cleanly', async () => {
    const { agent, organizationId } = await setup('ADMIRALTY');
    const host = `retired-${fixtureId}.northgate.test`;

    await agent.put(`/api/workspaces/${organizationId}/branding/custom-domain`).send({ customDomain: `https://${host}` });
    const removed = await agent.put(`/api/workspaces/${organizationId}/branding/custom-domain`).send({ customDomain: null });

    expect(removed.status).toBe(200);
    expect(removed.body.customDomain).toBeNull();

    const row = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(row.customDomain).toBeNull();
    expect(row.customDomainToken).toBeNull();
  });

  it('gives a client contact their agency branding and nobody else', async () => {
    const { agent, organizationId } = await setup('ADMIRALTY');

    await agent.patch(`/api/workspaces/${organizationId}/branding`).send({
      logoUrl: 'https://cdn.northgate.test/logo.svg',
      primaryColor: '#112233',
    });

    const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({ name: 'Acme', slug: `acme-${Date.now()}-${fixtureId}` });
    const contactEmail = `branding-${Date.now()}@acme.test`;
    await agent.post(`/api/workspaces/${organizationId}/clients/${client.body.id}/portal-access`).send({ email: contactEmail });

    const contact = request.agent(app);
    expect((await contact.post('/api/auth/sign-up/email').send({ name: 'Acme IT', email: contactEmail, password })).status).toBe(200);
    await prisma.user.update({ where: { email: contactEmail }, data: { emailVerified: true } });
    expect((await contact.post('/api/auth/sign-in/email').send({ email: contactEmail, password })).status).toBe(200);

    const branding = await contact.get('/api/portal/branding');
    expect(branding.status).toBe(200);
    expect(branding.body.logoUrl).toBe('https://cdn.northgate.test/logo.svg');
    expect(branding.body.primaryColor).toBe('#112233');
    expect(branding.body.workspaceName).toBe('Northgate Digital');

    const overview = await contact.get('/api/portal');
    expect(overview.body.branding.logoUrl).toBe('https://cdn.northgate.test/logo.svg');

    // The contact still cannot reach the agency side of branding.
    expect((await contact.get(`/api/workspaces/${organizationId}/branding`)).status).toBe(403);
  });

  it('keeps the agency name visible even with no branding configured', async () => {
    const { organizationId } = await setup('ADMIRALTY');
    const resolved = await resolveBranding(organizationId);

    expect(resolved.workspaceName).toBe('Northgate Digital');
    expect(resolved.logoUrl).toBeNull();
    expect(resolved.customDomain).toBeNull();
  });

  it('serves the agency to a visitor arriving on its own hostname', async () => {
    const { agent, organizationId } = await setup('ADMIRALTY');
    const host = `reports-${fixtureId}.northgate.test`;

    await agent.patch(`/api/workspaces/${organizationId}/branding`).send({
      logoUrl: 'https://cdn.northgate.test/logo.svg',
      primaryColor: '#0f172a',
    });
    const claimed = await agent.put(`/api/workspaces/${organizationId}/branding/custom-domain`).send({
      customDomain: `https://${host}`,
    });
    expect(claimed.status).toBe(200);

    const token = (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).customDomainToken!;
    const original = systemDnsReader.resolveTxt;
    systemDnsReader.resolveTxt = (async () => ({
      status: 'found',
      value: [[`dmarc-harbor-branding=${token}`]],
    })) as typeof systemDnsReader.resolveTxt;

    try {
      await agent.post(`/api/workspaces/${organizationId}/branding/custom-domain/verify`);
    } finally {
      systemDnsReader.resolveTxt = original;
    }

    // An anonymous visitor on the custom hostname, with no session at all.
    const anonymous = request(app);
    const served = await anonymous.get('/api/branding/host').set('Host', host);

    expect(served.status).toBe(200);
    expect(served.body.workspaceName).toBe('Northgate Digital');
    expect(served.body.logoUrl).toBe('https://cdn.northgate.test/logo.svg');
    expect(served.body.primaryColor).toBe('#0f172a');
    expect(served.body.customDomain).toBe(host);

    // A development port, and letter case, must not defeat the lookup.
    const withPort = await anonymous.get('/api/branding/host').set('Host', `${host.toUpperCase()}:3000`);
    expect(withPort.status).toBe(200);
    expect(withPort.body.workspaceName).toBe('Northgate Digital');
  });

  it('refuses to serve an agency whose hostname proof was never verified', async () => {
    const { agent, organizationId } = await setup('ADMIRALTY');
    const host = `unproven-${fixtureId}.northgate.test`;
    await agent.put(`/api/workspaces/${organizationId}/branding/custom-domain`).send({ customDomain: `https://${host}` });

    const anonymous = request(app);
    const served = await anonymous.get('/api/branding/host').set('Host', host);
    expect(served.status).toBe(404);

    const unknown = await anonymous.get('/api/branding/host').set('Host', 'someone-elses-domain.test');
    expect(unknown.status).toBe(404);
  });

  it('lets only one agency claim a hostname', async () => {
    const first = await setup('ADMIRALTY');
    const second = await setup('ADMIRALTY');

    const claimed = await first.agent.put(`/api/workspaces/${first.organizationId}/branding/custom-domain`).send({
      customDomain: 'https://contested.northgate.test',
    });
    expect(claimed.status).toBe(200);

    const refused = await second.agent.put(`/api/workspaces/${second.organizationId}/branding/custom-domain`).send({
      customDomain: 'https://contested.northgate.test',
    });

    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CUSTOM_DOMAIN_TAKEN');

    // The loser must not have taken the hostname or left a token behind.
    const row = await prisma.organization.findUniqueOrThrow({ where: { id: second.organizationId } });
    expect(row.customDomain).toBeNull();
    expect(row.customDomainToken).toBeNull();
  });

  it('stops serving an agency once the hostname is removed', async () => {    const { agent, organizationId } = await setup('ADMIRALTY');
    const host = `gone-${fixtureId}.northgate.test`;
    await agent.put(`/api/workspaces/${organizationId}/branding/custom-domain`).send({ customDomain: `https://${host}` });

    const token = (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).customDomainToken!;
    const original = systemDnsReader.resolveTxt;
    systemDnsReader.resolveTxt = (async () => ({
      status: 'found',
      value: [[`dmarc-harbor-branding=${token}`]],
    })) as typeof systemDnsReader.resolveTxt;

    try {
      await agent.post(`/api/workspaces/${organizationId}/branding/custom-domain/verify`);
      const anonymous = request(app);
      expect((await anonymous.get('/api/branding/host').set('Host', host)).status).toBe(200);

      await agent.put(`/api/workspaces/${organizationId}/branding/custom-domain`).send({ customDomain: null });
      expect((await anonymous.get('/api/branding/host').set('Host', host)).status).toBe(404);
    } finally {
      systemDnsReader.resolveTxt = original;
    }
  });

  it('records branding changes in the audit trail', async () => {
    const { agent, organizationId } = await setup('ADMIRALTY');

    await agent.patch(`/api/workspaces/${organizationId}/branding`).send({ primaryColor: '#abcdef' });

    const events = await prisma.auditLog.findMany({ where: { organizationId, action: 'BRANDING_UPDATED' } });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.detail).toMatchObject({ brandPrimaryColor: '#abcdef' });
  });
});
