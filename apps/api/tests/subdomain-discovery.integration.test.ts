import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanTier } from '@prisma/client';
import { app } from '../src/index.js';
import { prisma } from '../src/database/prisma.js';
import { grantPlan } from './helpers/plan.js';

/**
 * Subdomains seen sending in a domain's reports and not monitored.
 *
 * Found from header_from in the parent's aggregate reports, only for names
 * below the parent, folded across spellings, minus what the workspace already
 * monitors, and inside the 90-day window. Dismissing hides a name without
 * losing it, and both directions are audited once.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const day = 24 * 60 * 60 * 1000;

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "subdomain_dismissal", "entitlement_override", "subscription", "audit_log", "notification", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function workspace(label: string, plan: PlanTier | null = null) {
  fixtureId += 1;
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;
  expect((await request(app).post('/api/auth/sign-up/email').send({ name: 'Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const created = await agent.post('/api/workspaces').send({
    name: `${label} Agency`,
    slug: `${label}-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(created.status).toBe(201);
  const organizationId = created.body.id as string;
  if (plan) await grantPlan(organizationId, plan);
  return { agent, organizationId };
}

async function parentDomain(organizationId: string) {
  fixtureId += 1;
  const client = await prisma.client.create({
    data: { organizationId, name: `Client ${fixtureId}`, slug: `c-${fixtureId}-${Date.now()}` },
  });
  const name = `parent-${fixtureId}-${Date.now()}.test`;
  const domain = await prisma.domain.create({
    data: { clientId: client.id, name, slug: `parent-${fixtureId}-${Date.now()}`, status: 'VERIFIED', verifiedAt: new Date() },
  });
  return { client, domain };
}

async function report(
  domainId: string,
  begin: Date,
  records: Array<{ headerFrom: string | null; count: number; pass: boolean; ip?: string }>,
) {
  fixtureId += 1;
  return prisma.dmarcReport.create({
    data: {
      domainId,
      reportType: 'AGGREGATE',
      fingerprint: `sub-${fixtureId}-${Date.now()}`,
      reportingOrganization: 'Google LLC',
      dateRangeBegin: begin,
      dateRangeEnd: new Date(begin.getTime() + day - 1),
      records: {
        create: records.map((record, index) => ({
          sourceIp: record.ip ?? `203.0.113.${index + 1}`,
          messageCount: record.count,
          dkimResult: record.pass ? 'pass' : 'fail',
          spfResult: 'fail',
          headerFrom: record.headerFrom,
        })),
      },
    },
  });
}

describe('subdomain discovery', () => {
  beforeEach(resetDatabase);

  it('lists unmonitored names below the domain, from recent reports, on any plan', async () => {
    const owner = await workspace('sub-list');
    const { client, domain } = await parentDomain(owner.organizationId);
    const recent = new Date(Date.now() - 5 * day);

    await report(domain.id, recent, [
      { headerFrom: `news.${domain.name}`, count: 80, pass: true, ip: '198.51.100.1' },
      // Another spelling of the same name: case and a trailing dot.
      { headerFrom: ` NEWS.${domain.name.toUpperCase()}. `, count: 20, pass: false, ip: '198.51.100.2' },
      { headerFrom: `app.${domain.name}`, count: 5, pass: false },
      // The domain itself, another organisation, and a lookalike that only
      // shares the suffix text: none of these is a subdomain.
      { headerFrom: domain.name, count: 1000, pass: true },
      { headerFrom: 'mailer.other.test', count: 300, pass: true },
      { headerFrom: `x${domain.name}`, count: 300, pass: false },
      { headerFrom: null, count: 7, pass: false },
      // Already monitored in this workspace.
      { headerFrom: `billing.${domain.name}`, count: 400, pass: true },
    ]);
    // Outside the 90-day window.
    await report(domain.id, new Date(Date.now() - 120 * day), [{ headerFrom: `old.${domain.name}`, count: 50, pass: true }]);
    await prisma.domain.create({
      data: { clientId: client.id, name: `billing.${domain.name}`, slug: `billing-${fixtureId}-${Date.now()}` },
    });

    const response = await owner.agent.get(`/api/workspaces/${owner.organizationId}/domains/${domain.slug}/subdomains`);
    expect(response.status).toBe(200);
    expect(response.body.windowDays).toBe(90);
    expect(response.body.domain).toEqual({ id: domain.id, name: domain.name });
    expect(response.body.subdomains.map((row: { name: string }) => row.name)).toEqual([`news.${domain.name}`, `app.${domain.name}`]);
    expect(response.body.subdomains[0]).toMatchObject({
      messages: 100,
      dmarcPassMessages: 80,
      dmarcPassPercent: 80,
      sourceCount: 2,
      dismissed: null,
    });
    expect(response.body.subdomains[0].firstSeenAt).toBe(recent.toISOString());
    expect(response.body.subdomains[1]).toMatchObject({ messages: 5, dmarcPassPercent: 0, sourceCount: 1 });
  });

  it('dismisses and restores a name, auditing each change once', async () => {
    const owner = await workspace('sub-dismiss', 'FAIRWAY');
    const { domain } = await parentDomain(owner.organizationId);
    await report(domain.id, new Date(Date.now() - day), [{ headerFrom: `promo.${domain.name}`, count: 12, pass: true }]);
    const path = `/api/workspaces/${owner.organizationId}/domains/${domain.id}/subdomains`;

    const dismissed = await owner.agent.put(`${path}/dismissal`).send({ name: `Promo.${domain.name}.`, dismissed: true });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body).toEqual({ name: `promo.${domain.name}`, dismissed: true });
    expect((await owner.agent.put(`${path}/dismissal`).send({ name: `promo.${domain.name}`, dismissed: true })).status).toBe(200);

    const listed = await owner.agent.get(path);
    expect(listed.body.subdomains).toHaveLength(1);
    expect(listed.body.subdomains[0].dismissed).toMatchObject({ by: { name: 'Owner' } });

    const audits = () =>
      prisma.auditLog.findMany({
        where: { organizationId: owner.organizationId, targetType: 'subdomain' },
        select: { action: true, targetId: true, domainId: true },
        orderBy: { createdAt: 'asc' },
      });
    expect(await audits()).toEqual([{ action: 'SUBDOMAIN_DISMISSED', targetId: `promo.${domain.name}`, domainId: domain.id }]);

    expect((await owner.agent.put(`${path}/dismissal`).send({ name: `promo.${domain.name}`, dismissed: false })).status).toBe(200);
    expect((await owner.agent.put(`${path}/dismissal`).send({ name: `promo.${domain.name}`, dismissed: false })).status).toBe(200);
    expect((await owner.agent.get(path)).body.subdomains[0].dismissed).toBeNull();
    expect((await audits()).map((row) => row.action)).toEqual(['SUBDOMAIN_DISMISSED', 'SUBDOMAIN_RESTORED']);
  });

  it('refuses names that are not below the domain or never seen, and other workspaces', async () => {
    const owner = await workspace('sub-refuse');
    const other = await workspace('sub-other');
    const { domain } = await parentDomain(owner.organizationId);
    await report(domain.id, new Date(Date.now() - day), [{ headerFrom: `seen.${domain.name}`, count: 3, pass: true }]);
    const path = `/api/workspaces/${owner.organizationId}/domains/${domain.id}/subdomains`;

    const outside = await owner.agent.put(`${path}/dismissal`).send({ name: 'seen.other.test', dismissed: true });
    expect(outside.status).toBe(400);
    expect(outside.body.error.code).toBe('INVALID_REQUEST');
    const itself = await owner.agent.put(`${path}/dismissal`).send({ name: domain.name, dismissed: true });
    expect(itself.status).toBe(400);
    const unseen = await owner.agent.put(`${path}/dismissal`).send({ name: `never.${domain.name}`, dismissed: true });
    expect(unseen.status).toBe(404);
    expect(unseen.body.error.code).toBe('SUBDOMAIN_NOT_FOUND');
    expect((await owner.agent.put(`${path}/dismissal`).send({ name: `seen.${domain.name}` })).status).toBe(400);

    // Not a member: refused before anything is read.
    expect((await other.agent.get(path)).status).toBe(403);
    // A member asking about a domain that is not theirs: not found.
    expect((await other.agent.get(`/api/workspaces/${other.organizationId}/domains/${domain.id}/subdomains`)).status).toBe(404);
    expect(await prisma.subdomainDismissal.count()).toBe(0);
  });
});
