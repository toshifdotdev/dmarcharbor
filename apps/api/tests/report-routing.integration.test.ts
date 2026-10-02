import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { ingestDmarcReportByPolicyDomain } from '../src/services/report.service.js';

/**
 * Which customer's account does an incoming report belong to?
 *
 * Every emailed report is routed on one thing only: the domain named inside the
 * report's own `<policy_published><domain>`. Not the sending address, not which
 * mailbox it arrived in, not anything Google told us. One shared mailbox receives
 * reports for hundreds of unrelated customers, and the only thing separating them
 * is that name matching exactly one verified domain in the database.
 *
 * These tests exist because the two refusal branches - an unknown domain and a
 * domain claimed by two workspaces - were implemented but never asserted. They
 * are the branches that stop a report being filed under somebody else's tenant,
 * which is the worst failure this product could have.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

function aggregateReport(domain: string, reportId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>Google LLC</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>${reportId}</report_id>
    <date_range><begin>1712188800</begin><end>1712275199</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>${domain}</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><fraction>100</fraction>
  </policy_published>
  <record>
    <row>
      <source_ip>192.0.2.10</source_ip><count>1250</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>${domain}</header_from><envelope_from>${domain}</envelope_from></identifiers>
    <auth_results><dkim><domain>${domain}</domain><selector>google</selector><result>pass</result></dkim></auth_results>
  </record>
</feedback>`;
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

/** A workspace owning one verified domain, standing in for one agency's client. */
async function workspaceWithDomain(domainName: string, opts: { verified?: boolean } = {}) {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `route-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Route Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Route Agency',
    slug: `route-${Date.now()}-${fixtureId}`,
  });
  const organizationId = workspace.body.id as string;

  const client = await prisma.client.create({
    data: { organizationId, name: `Route Client ${fixtureId}`, slug: `rc-${Date.now()}-${fixtureId}` },
  });

  // Created for the routing to have something to resolve against.
  const domain = await prisma.domain.create({
    data: {
      clientId: client.id,
      slug: `dom-${Math.random().toString(36).slice(2, 10)}`,
      name: domainName,
      status: opts.verified === false ? 'PENDING' : 'VERIFIED',
      verifiedAt: opts.verified === false ? null : new Date(),
    },
  });

  return { agent, organizationId, domainId: domain.id };
}

describe('routing an emailed report to its owner', () => {
  beforeEach(resetDatabase);

  it('files the report against the workspace that owns the domain', async () => {
    const owner = await workspaceWithDomain('owned-route.test');

    const outcome = await ingestDmarcReportByPolicyDomain(aggregateReport('owned-route.test', 'r-1'));

    expect(outcome.status).toBe('created');

    const stored = await prisma.dmarcReport.findFirstOrThrow({ where: { policyDomain: 'owned-route.test' } });

    // The report lands on the owning domain, and therefore inside the owning
    // workspace. Nothing else may write a report against that domain.
    expect(stored.domainId).toBe(owner.domainId);
    expect(await prisma.dmarcReport.count({ where: { domain: { client: { organizationId: owner.organizationId } } } })).toBe(1);
  });

  it('refuses a report for a domain nobody monitors, and writes nothing', async () => {
    await workspaceWithDomain('known-route.test');

    const outcome = await ingestDmarcReportByPolicyDomain(aggregateReport('stranger-route.test', 'r-2'));

    // Someone's mail server sent us a report for a domain we have no relationship
    // with. Accepting it would create a report against no tenant, and the only
    // way it could later be attributed is by guessing.
    expect(outcome.status).toBe('domain_not_found');
    expect(outcome.status === 'domain_not_found' && outcome.reportDomain).toBe('stranger-route.test');

    expect(await prisma.dmarcReport.count({ where: { policyDomain: 'stranger-route.test' } })).toBe(0);
    expect(await prisma.dmarcReport.count()).toBe(0);
  });

  it('refuses to guess when two workspaces monitor the same domain', async () => {
    // Deliberately the same domain under two different workspaces. The schema
    // only enforces uniqueness per client, so this state is reachable.
    const first = await workspaceWithDomain('shared-route.test');
    const second = await workspaceWithDomain('shared-route.test');

    expect(first.domainId).not.toBe(second.domainId);

    const outcome = await ingestDmarcReportByPolicyDomain(aggregateReport('shared-route.test', 'r-3'));

    // Picking either one would hand one agency's mail traffic to the other.
    // Refusing is the only safe answer, and this is a genuine operational
    // conflict a human has to resolve, not something to paper over.
    expect(outcome.status).toBe('ambiguous_domain');
    expect(outcome.status === 'ambiguous_domain' && outcome.reportDomain).toBe('shared-route.test');

    // The important half of the assertion: nothing was written to either side.
    expect(await prisma.dmarcReport.count({ where: { policyDomain: 'shared-route.test' } })).toBe(0);
    expect(await prisma.dmarcReport.count()).toBe(0);
  });

  it('does not route to a domain that was never verified', async () => {
    await workspaceWithDomain('pending-route.test', { verified: false });

    const outcome = await ingestDmarcReportByPolicyDomain(aggregateReport('pending-route.test', 'r-4'));

    // Ownership proof has not completed, so the domain is not yet ours to attach
    // evidence to. Verified is the gate, not merely existing.
    expect(outcome.status).toBe('domain_not_found');
    expect(await prisma.dmarcReport.count()).toBe(0);
  });

  it('routes by the domain in the XML, not by who owns the mailbox', async () => {
    // The scenario the shared mailbox exists for. One workspace polls the shared
    // mailbox and therefore physically receives this message, but the report is
    // about a domain belonging to a completely different agency.
    const mailboxOwner = await workspaceWithDomain('mailbox-owner.test');
    const actualOwner = await workspaceWithDomain('actual-owner.test');

    expect(mailboxOwner.organizationId).not.toBe(actualOwner.organizationId);

    const outcome = await ingestDmarcReportByPolicyDomain(aggregateReport('actual-owner.test', 'r-5'));

    expect(outcome.status).toBe('created');

    const stored = await prisma.dmarcReport.findFirstOrThrow({ where: { policyDomain: 'actual-owner.test' } });

    // It belongs to the agency that monitors the domain. The workspace whose
    // credentials happened to fetch it must not receive it, or the mailbox would
    // be a cross-tenant channel.
    expect(stored.domainId).toBe(actualOwner.domainId);
    expect(await prisma.dmarcReport.count({ where: { domain: { client: { organizationId: mailboxOwner.organizationId } } } })).toBe(0);
  });

  it('counts one report delivered twice rather than two reports', async () => {
    await workspaceWithDomain('dedupe-route.test');

    // Same report, reformatted, as happens when it arrives both as an emailed
    // attachment and as a DNS published copy.
    const first = await ingestDmarcReportByPolicyDomain(aggregateReport('dedupe-route.test', 'r-6'));
    const second = await ingestDmarcReportByPolicyDomain(
      aggregateReport('dedupe-route.test', 'r-6').replace(/\n/g, '\r\n'),
    );

    expect(first.status).toBe('created');
    expect(second.status).toBe('duplicate');
    expect(await prisma.dmarcReport.count({ where: { policyDomain: 'dedupe-route.test' } })).toBe(1);
  });
});
