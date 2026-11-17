import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { planCatalog } from '../src/services/entitlements/plan-catalog.js';
import { setOrganizationPlan } from '../src/services/entitlements/entitlement.service.js';
import { reconcileDomainMonitoring } from '../src/services/entitlements/domain-allowance.service.js';
import { ingestDmarcReport } from '../src/services/report.service.js';

/**
 * Domains beyond the plan's limit are paused (domain-allowance.service.ts).
 *
 * An account that bought a larger plan, added domains and then went back to
 * Mooring used to keep every domain monitored. Now the newest counted domains
 * are paused, store no reports, and resume when there is room again.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const DAY = 24 * 60 * 60 * 1000;

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "billing_plan", "subscription", "entitlement_override", "dmarc_report", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function workspace(): Promise<{ agent: ReturnType<typeof request.agent>; organizationId: string; clientId: string }> {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `allowance-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Allowance Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const created = await agent.post('/api/workspaces').send({
    name: 'Allowance Agency',
    slug: `allowance-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(created.status).toBe(201);
  const client = await agent
    .post(`/api/workspaces/${created.body.id}/clients`)
    .send({ name: 'Allowance Client', slug: `ac-${Date.now()}-${fixtureId}` });
  expect(client.status).toBe(201);
  return { agent, organizationId: created.body.id as string, clientId: client.body.id as string };
}

/** Verified domains added one day apart, oldest first, all within the grace period (so counted). */
async function addDomains(clientId: string, count: number, now: Date, prefix = 'allow') {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(
      await prisma.domain.create({
        data: {
          clientId,
          name: `${prefix}-${index}.example`,
          slug: `${prefix}-${index}-${fixtureId}`,
          status: 'VERIFIED',
          createdAt: new Date(now.getTime() - (count - index) * DAY),
        },
      }),
    );
  }
  return rows;
}

function aggregateXml(domain: string, reportId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>Google LLC</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>${reportId}</report_id>
    <date_range><begin>1712188800</begin><end>1712275199</end></date_range>
  </report_metadata>
  <policy_published><domain>${domain}</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><pct>100</pct></policy_published>
  <record>
    <row>
      <source_ip>192.0.2.10</source_ip>
      <count>3</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>${domain}</header_from></identifiers>
  </record>
</feedback>`;
}

const pausedNames = async (organizationId: string) =>
  (
    await prisma.domain.findMany({
      where: { client: { organizationId }, monitoringPausedAt: { not: null } },
      select: { name: true },
      orderBy: { name: 'asc' },
    })
  ).map((d) => d.name);

describe('domain allowance', () => {
  beforeEach(resetDatabase);

  it('pauses the newest domains on a downgrade, refuses their reports, and resumes on upgrade', async () => {
    const now = new Date();
    const { organizationId, clientId } = await workspace();
    await setOrganizationPlan(organizationId, 'HARBOR');
    const domains = await addDomains(clientId, 4, now);

    expect((await reconcileDomainMonitoring(organizationId, now)).paused).toEqual([]);

    await setOrganizationPlan(organizationId, 'MOORING');
    const limit = planCatalog.MOORING.maxActiveDomains;
    expect(limit).toBe(2);
    const change = await reconcileDomainMonitoring(organizationId, now);
    expect(change.paused.map((d) => d.name).sort()).toEqual(['allow-2.example', 'allow-3.example']);
    expect(await pausedNames(organizationId)).toEqual(['allow-2.example', 'allow-3.example']);

    // A report for a paused domain is not stored.
    const outcome = await ingestDmarcReport({ organizationId, domainId: domains[3]!.id, xml: '<feedback/>' });
    expect(outcome.status).toBe('paused');
    expect(await prisma.dmarcReport.count({ where: { domainId: domains[3]!.id } })).toBe(0);

    // A second run changes nothing: the paused domains no longer count.
    expect(await reconcileDomainMonitoring(organizationId, now)).toEqual({ paused: [], resumed: [] });

    await setOrganizationPlan(organizationId, 'HARBOR');
    const back = await reconcileDomainMonitoring(organizationId, now);
    expect(back.resumed.map((d) => d.name).sort()).toEqual(['allow-2.example', 'allow-3.example']);
    expect(await pausedNames(organizationId)).toEqual([]);
  });

  it('does not pause parked domains that are outside the grace period and send nothing', async () => {
    const now = new Date();
    const { organizationId, clientId } = await workspace();
    await addDomains(clientId, 2, now, 'live');
    for (let index = 0; index < 3; index += 1) {
      await prisma.domain.create({
        data: {
          clientId,
          name: `parked-${index}.example`,
          slug: `parked-${index}-${fixtureId}`,
          status: 'VERIFIED',
          createdAt: new Date(now.getTime() - 120 * DAY),
        },
      });
    }
    expect((await reconcileDomainMonitoring(organizationId, now)).paused).toEqual([]);
  });

  it('lets an owner pause to free a place, refuses a resume at the limit, and never auto-resumes an owner pause', async () => {
    const now = new Date();
    const { agent, organizationId, clientId } = await workspace();
    const domains = await addDomains(clientId, 3, now);
    await reconcileDomainMonitoring(organizationId, now);
    expect(await pausedNames(organizationId)).toEqual(['allow-2.example']);

    // At the limit: resuming the paused domain is refused.
    const refused = await agent
      .patch(`/api/workspaces/${organizationId}/domains/${domains[2]!.id}/monitoring`)
      .send({ paused: false });
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('PLAN_LIMIT_REACHED');

    // Pausing the oldest frees a place; the plan-paused one can then be resumed.
    const paused = await agent
      .patch(`/api/workspaces/${organizationId}/domains/${domains[0]!.id}/monitoring`)
      .send({ paused: true });
    expect(paused.status).toBe(200);
    expect(paused.body.monitoring).toMatchObject({ paused: true, reason: 'owner', limit: 2 });

    const resumed = await agent
      .patch(`/api/workspaces/${organizationId}/domains/${domains[2]!.id}/monitoring`)
      .send({ paused: false });
    expect(resumed.status).toBe(200);
    expect(resumed.body.monitoring.paused).toBe(false);

    // Room on a larger plan does not resume a domain the owner paused.
    await setOrganizationPlan(organizationId, 'HARBOR');
    expect((await reconcileDomainMonitoring(organizationId, now)).resumed).toEqual([]);
    expect(await pausedNames(organizationId)).toEqual(['allow-0.example']);

    const read = await agent.get(`/api/workspaces/${organizationId}/domains/${domains[0]!.id}/monitoring`);
    expect(read.status).toBe(200);
    expect(read.body.monitoring).toMatchObject({ paused: true, reason: 'owner' });

    const list = await agent.get(`/api/workspaces/${organizationId}/clients`);
    const row = list.body[0].domains.find((d: { id: string }) => d.id === domains[0]!.id);
    expect(row.monitoringPaused).toBe(true);

    const audit = await prisma.auditLog.count({ where: { organizationId, action: 'DOMAIN_MONITORING_PAUSED' } });
    expect(audit).toBeGreaterThanOrEqual(2);
  });

  it('refuses the first report for a parked domain while the plan is full, and pauses it', async () => {
    const now = new Date();
    const { organizationId, clientId } = await workspace();
    await addDomains(clientId, 2, now, 'live');
    const parked = await prisma.domain.create({
      data: { clientId, name: 'parked.example', slug: `parked-${fixtureId}`, status: 'VERIFIED', createdAt: new Date(now.getTime() - 120 * DAY) },
    });

    const outcome = await ingestDmarcReport({ organizationId, domainId: parked.id, xml: aggregateXml('parked.example', `parked-${fixtureId}`) });
    expect(outcome.status).toBe('paused');
    expect(await prisma.dmarcReport.count({ where: { domainId: parked.id } })).toBe(0);
    expect(await pausedNames(organizationId)).toEqual(['parked.example']);

    // A domain that already has its place keeps receiving.
    const live = await prisma.domain.findFirstOrThrow({ where: { name: 'live-0.example' } });
    const stored = await ingestDmarcReport({ organizationId, domainId: live.id, xml: aggregateXml('live-0.example', `live-${fixtureId}`) });
    expect(stored.status).toBe('created');
  });

  it('counts a resumed domain at once, so resuming one after another cannot pass the limit', async () => {
    const now = new Date();
    const { agent, organizationId, clientId } = await workspace();
    const fresh = await addDomains(clientId, 2, now, 'fresh');
    const old = [];
    for (let index = 0; index < 2; index += 1) {
      old.push(
        await prisma.domain.create({
          data: {
            clientId,
            name: `old-${index}.example`,
            slug: `old-${index}-${fixtureId}`,
            status: 'VERIFIED',
            createdAt: new Date(now.getTime() - 120 * DAY),
            monitoringPausedAt: new Date(now.getTime() - 60 * DAY),
            monitoringPausedReason: 'plan_limit',
          },
        }),
      );
    }

    // Free one place, take it with one old domain; the second old one has no place.
    expect((await agent.patch(`/api/workspaces/${organizationId}/domains/${fresh[0]!.id}/monitoring`).send({ paused: true })).status).toBe(200);
    const first = await agent.patch(`/api/workspaces/${organizationId}/domains/${old[0]!.id}/monitoring`).send({ paused: false });
    expect(first.status).toBe(200);
    expect(first.body.monitoring).toMatchObject({ paused: false, used: 2, limit: 2 });
    const second = await agent.patch(`/api/workspaces/${organizationId}/domains/${old[1]!.id}/monitoring`).send({ paused: false });
    expect(second.status).toBe(402);

    // The daily check does not resume anything either: the plan is full.
    expect((await reconcileDomainMonitoring(organizationId, now)).resumed).toEqual([]);
  });
});