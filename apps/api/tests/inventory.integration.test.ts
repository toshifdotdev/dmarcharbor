import { Prisma } from '@prisma/client';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import {
  buildErasureCertificate,
  exportRedactions,
  planErasure,
  summarisePlan,
} from '../src/services/inventory/deletion-planner.js';
import { buildInventory, countActiveDomains, countCountedDomains, domainGraceDays } from '../src/services/inventory/inventory.service.js';
import { grantPlan } from './helpers/plan.js';

/**
 * Named forensic storage keeps values encrypted, so the column holds ciphertext
 * blobs. The inventory only ever looks at whether the column is populated, so
 * the fixture mirrors the real shape rather than inventing plaintext.
 */
async function seedForensic(domainId: string, named: boolean): Promise<void> {
  const data: Prisma.DmarcForensicReportUncheckedCreateInput = {
    domainId,
    fingerprint: `fp-forensic-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    feedbackType: 'feedback-report',
    reportedDomain: 'inventory.test',
    sourceIp: '45.83.12.9',
    redactionVersion: 1,
    retentionExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };

  if (named) {
    data.recipientAddresses = ['enc:v1:ciphertext-placeholder'];
    data.subjectLine = 'enc:v1:subject-placeholder';
  } else {
    data.recipientPseudonyms = ['ps1'];
  }

  await prisma.dmarcForensicReport.create({ data });
}

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "entitlement_override", "erasure_request", "subscription", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setup() {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `inv-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Inv Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Inventory Agency',
    slug: `inv-${Date.now()}-${fixtureId}`, dpaHasRead: true, dpaConfirmsAuthority: true});
  expect(workspace.status).toBe(201);

  const organizationId = workspace.body.id as string;
  await grantPlan(organizationId, 'HARBOR');

  return { agent, organizationId, email };
}

async function seed(agent: ReturnType<typeof request.agent>, organizationId: string, clientName: string, domainName: string) {
  const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
    name: clientName,
    slug: `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  expect(client.status).toBe(201);

  const domain = await agent.post(`/api/workspaces/${organizationId}/clients/${client.body.id}/domains`).send({
    name: domainName,
  });
  expect(domain.status).toBe(201);

  return { clientId: client.body.id as string, domainId: domain.body.id as string };
}

describe('data inventory', () => {
  beforeAll(resetDatabase);

  it('holds only account level personal data on a brand new workspace', async () => {
    const { organizationId } = await setup();
    const inventory = await buildInventory({ kind: 'ORGANIZATION', organizationId });

    expect(inventory.counts.client).toBe(0);
    expect(inventory.counts.domain).toBe(0);
    expect(inventory.counts.report).toBe(0);
    expect(inventory.counts.forensicPersonalData).toBe(0);
    expect(inventory.counts.user).toBe(1);

    const keys = inventory.personalData.map((entry) => entry.key);
    expect(keys).toEqual(expect.arrayContaining(['user', 'member']));
    expect(keys).not.toContain('forensicPersonalData');
    expect(keys).not.toContain('reportDigest');
  });

  it('counts the workspace structure it holds', async () => {
    const { agent, organizationId } = await setup();
    const { clientId, domainId } = await seed(agent, organizationId, 'Acme', 'acme.test');

    await prisma.scan.create({
      data: { domainId, status: 'COMPLETED', score: 80 },
    });

    const inventory = await buildInventory({ kind: 'ORGANIZATION', organizationId });

    expect(inventory.counts.client).toBe(1);
    expect(inventory.counts.domain).toBe(1);
    expect(inventory.counts.scan).toBe(1);
    expect(inventory.counts.user).toBe(1);
    expect(inventory.counts.member).toBe(1);
    expect(clientId).toBeTruthy();
  });

  it('counts an aggregate report and its rows', async () => {
    const { agent, organizationId } = await setup();
    const { domainId } = await seed(agent, organizationId, 'Beta', 'beta.test');

    const report = await prisma.dmarcReport.create({
      data: {
        domainId,
        reportType: 'AGGREGATE',
        fingerprint: `fp-${Date.now()}-${Math.random()}`,
        recordCount: 1,
        records: {
          create: {
            sourceIp: '10.0.0.1',
            messageCount: 25,
            dkimResult: 'pass',
            spfResult: 'pass',
            authResults: { create: [{ type: 'SPF', domain: 'beta.test', result: 'pass' }] },
          },
        },
      },
      include: { records: { include: { authResults: true } } },
    });

    const inventory = await buildInventory({ kind: 'ORGANIZATION', organizationId });
    expect(inventory.counts.report).toBe(1);
    expect(inventory.counts.reportRecord).toBe(1);
    expect(inventory.counts.authResult).toBe(1);

    const domainInventory = await buildInventory({ kind: 'DOMAIN', organizationId, domainId });
    expect(domainInventory.counts.report).toBe(1);
    expect(domainInventory.counts.reportRecord).toBe(1);
    expect(domainInventory.counts.client).toBe(0);
    expect(report.records).toHaveLength(1);
  });

  it('separates pseudonymous forensic evidence from named personal data', async () => {
    const { agent, organizationId } = await setup();
    const { domainId } = await seed(agent, organizationId, 'Gamma', 'gamma.test');

    for (const named of [false, false, true]) {
      await seedForensic(domainId, named);
    }

    const inventory = await buildInventory({ kind: 'ORGANIZATION', organizationId });

    expect(inventory.counts.forensicEvidence).toBe(3);
    expect(inventory.counts.forensicPseudonym).toBe(3);
    expect(inventory.counts.forensicPersonalData).toBe(1);

    const personal = inventory.personalData.find((entry) => entry.key === 'forensicPersonalData');
    expect(personal?.count).toBe(1);
  });

  it('scopes a client inventory to that client only', async () => {
    const { agent, organizationId } = await setup();
    const first = await seed(agent, organizationId, 'Client One', 'one.test');
    await seed(agent, organizationId, 'Client Two', 'two.test');

    const whole = await buildInventory({ kind: 'ORGANIZATION', organizationId });
    expect(whole.counts.client).toBe(2);
    expect(whole.counts.domain).toBe(2);

    const scoped = await buildInventory({ kind: 'CLIENT', organizationId, clientId: first.clientId });
    expect(scoped.counts.client).toBe(1);
    expect(scoped.counts.domain).toBe(1);
  });

  it('never leaks another workspace into a scoped inventory', async () => {
    const first = await setup();
    const second = await setup();
    const { domainId } = await seed(second.agent, second.organizationId, 'Other', 'other.test');

    const crossRead = await buildInventory({ kind: 'DOMAIN', organizationId: first.organizationId, domainId });
    expect(crossRead.counts.domain).toBe(0);
    expect(crossRead.counts.report).toBe(0);
  });

  it('counts an active domain and frees a parked one', async () => {
    const { agent, organizationId } = await setup();
    await seed(agent, organizationId, 'Live', 'live.test');
    await seed(agent, organizationId, 'Parked', 'parked.test');

    expect(await countActiveDomains(organizationId, 400)).toBe(0);
    expect(await countCountedDomains(organizationId, 400)).toBe(2);

    const live = await prisma.domain.findFirstOrThrow({ where: { name: 'live.test' } });
    await prisma.dmarcReport.create({
      data: {
        domainId: live.id,
        reportType: 'AGGREGATE',
        fingerprint: `fp-active-${Date.now()}`,
        recordCount: 0,
      },
    });

    expect(await countActiveDomains(organizationId, 400)).toBe(1);
    expect(await countCountedDomains(organizationId, 400)).toBe(2);
  });

  it('frees a domain once it passes the grace period', async () => {
    const { agent, organizationId } = await setup();
    await seed(agent, organizationId, 'Old', 'old.test');
    await seed(agent, organizationId, 'New', 'new.test');

    const old = await prisma.domain.findFirstOrThrow({ where: { name: 'old.test' } });
    await prisma.domain.update({
      where: { id: old.id },
      data: { createdAt: new Date(Date.now() - (domainGraceDays + 5) * 24 * 60 * 60 * 1000) },
    });

    expect(await countCountedDomains(organizationId, 400)).toBe(1);
  });

  it('builds a plan from real data and changes nothing on disk', async () => {
    const { agent, organizationId } = await setup();
    const { domainId } = await seed(agent, organizationId, 'Delta', 'delta.test');

    await seedForensic(domainId, true);
    await prisma.auditLog.create({
      data: { organizationId, action: 'FORENSIC_PURGE_DOMAIN', targetType: 'domain', targetId: domainId },
    });

    const inventory = await buildInventory({ kind: 'ORGANIZATION', organizationId });
    const before = await prisma.dmarcForensicReport.count();

    const actions = planErasure(inventory);
    const totals = summarisePlan(actions);

    expect(actions.find((entry) => entry.key === 'forensicPersonalData')?.action).toBe('delete');
    expect(actions.find((entry) => entry.key === 'auditLog')?.action).toBe('anonymize');
    expect(totals.personalDataRecords).toBeGreaterThan(0);

    expect(await prisma.dmarcForensicReport.count()).toBe(before);
    expect(await prisma.user.count()).toBeGreaterThan(0);
  });

  it('produces a certificate with no personal data from a real workspace', async () => {
    const { agent, organizationId, email } = await setup();
    await seed(agent, organizationId, 'Epsilon', 'epsilon.test');

    const inventory = await buildInventory({ kind: 'ORGANIZATION', organizationId });
    const certificate = buildErasureCertificate(inventory, planErasure(inventory), {
      plan: 'HARBOR',
      retentionDays: 1095,
    });

    const serialized = JSON.stringify(certificate);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain('@example.com');
    expect(certificate.totals.recordsDeleted).toBeGreaterThan(0);
  });

  it('discloses security records in the export rather than hiding them', async () => {
    const { agent, organizationId } = await setup();
    await seed(agent, organizationId, 'Zeta', 'zeta.test');

    await prisma.auditLog.create({
      data: { organizationId, action: 'ALERT_ACKNOWLEDGED', targetType: 'domain', targetId: 'zeta' },
    });
    await prisma.entitlementOverride.create({
      data: { organizationId, entitlement: 'api.access', enabled: true, reason: 'pilot' },
    });

    const inventory = await buildInventory({ kind: 'ORGANIZATION', organizationId });
    const notices = exportRedactions(inventory);

    expect(notices.map((entry) => entry.key)).toContain('auditLog');
    expect(notices.map((entry) => entry.key)).toContain('subscription');
    expect(notices.map((entry) => entry.key)).not.toContain('entitlementOverride');
    /**
     * Two, not one. Creating the workspace recorded a DPA acceptance and wrote an
     * audit row for it, so the organisation genuinely holds two audit records by the
     * time this runs. The point of the assertion is that the inventory counts and
     * discloses the ones that exist, not how many there are.
     */
    expect(inventory.counts.auditLog).toBe(2);
    expect(inventory.counts.entitlementOverride).toBe(1);
  });
});
