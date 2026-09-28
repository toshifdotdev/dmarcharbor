import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { ingestDmarcReport, ingestDmarcReportByPolicyDomain } from '../src/services/report.service.js';
import { grantPlan } from './helpers/plan.js';
import { configureInbox, inboxStatus, InboxError } from '../src/services/report/imap-inbox.service.js';

/**
 * Emailed report collection and the deduplication it depends on.
 *
 * The identity column is the reason this file exists. A high volume domain is
 * typically split across a DNS published URL and an emailed attachment, and the
 * two copies of one report rarely have identical bytes: whitespace, attribute
 * order and gzip settings all differ. Keyed on content alone, one day would be
 * counted twice, which inflates the number a customer sees and turns their
 * dashboard into something they cannot explain to their own team. That is worse
 * than a gap, because a gap is visible and an inflated total is trusted.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "report_inbox", "client_portal_access", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

/** A report as a receiver would state it, with formatting under our control. */
function report(options: { domain: string; reportId: string; indent?: string; rows?: number }): string {
  const indent = options.indent ?? '  ';
  const rows = options.rows ?? 1;
  const records = Array.from({ length: rows }, (_unused, index) => `
${indent}<record>
${indent}  <row>
${indent}    <source_ip>192.0.2.${10 + index}</source_ip>
${indent}    <count>${100 + index}</count>
${indent}    <policy_evaluated>
${indent}      <disposition>none</disposition>
${indent}      <dkim>pass</dkim>
${indent}      <spf>fail</spf>
${indent}    </policy_evaluated>
${indent}  </row>
${indent}  <identifiers>
${indent}    <header_from>${options.domain}</header_from>
${indent}  </identifiers>
${indent}</record>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
${indent}<report_metadata>
${indent}  <org_name>Google LLC</org_name>
${indent}  <email>noreply-dmarc-support@google.com</email>
${indent}  <report_id>${options.reportId}</report_id>
${indent}  <date_range>
${indent}    <begin>1712188800</begin>
${indent}    <end>1712275199</end>
${indent}  </date_range>
${indent}</report_metadata>
${indent}<policy_published>
${indent}  <domain>${options.domain}</domain>
${indent}  <adkim>r</adkim>
${indent}  <aspf>r</aspf>
${indent}  <p>none</p>
${indent}  <fraction>100</fraction>
${indent}</policy_published>${records}
</feedback>`;
}

async function setup(plan: 'MOORING' | 'FAIRWAY' | 'HARBOR' | 'ADMIRALTY' = 'HARBOR') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `inbox-${Date.now()}-${fixtureId}@northgate.test`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Inbox Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Northgate Digital',
    slug: `i-${Date.now()}-${fixtureId}`,
  });
  const organizationId = workspace.body.id as string;
  if (plan !== 'MOORING') {
    await grantPlan(organizationId, plan);
  }

  const client = await prisma.client.create({
    data: { organizationId, name: `Client ${fixtureId}`, slug: `c-${Date.now()}-${fixtureId}` },
  });

  const domain = await prisma.domain.create({
    data: {
      clientId: client.id,
      name: `victim-${fixtureId}.test`,
      status: 'VERIFIED',
      verificationToken: `token-${fixtureId}`,
      verifiedAt: new Date(),
    },
  });

  return { agent, organizationId, domain, domainName: domain.name };
}

describe('report identity deduplication', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('treats a reformatted copy of the same report as the same report', async () => {
    const { organizationId, domain, domainName } = await setup();
    const reportId = `format-${Date.now()}`;

    // Same report, stated with different whitespace. The bytes differ, so a
    // content hash alone would treat this as a second delivery.
    const first = await ingestDmarcReport({ organizationId, domainId: domain.id, xml: report({ domain: domainName, reportId, indent: '  ' }) });
    const second = await ingestDmarcReport({ organizationId, domainId: domain.id, xml: report({ domain: domainName, reportId, indent: '' }) });

    expect(first.status).toBe('created');
    expect(second.status).toBe('duplicate');

    const stored = await prisma.dmarcReport.findMany({ where: { domainId: domain.id } });
    expect(stored).toHaveLength(1);
  });

  it('records an identity on first ingest so the match survives a later copy', async () => {
    const { organizationId, domain, domainName } = await setup();

    await ingestDmarcReport({ organizationId, domainId: domain.id, xml: report({ domain: domainName, reportId: `ident-${Date.now()}` }) });

    const stored = await prisma.dmarcReport.findFirst({ where: { domainId: domain.id } });
    expect(stored?.reportIdentity).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps genuinely different reports for the same day apart', async () => {
    const { organizationId, domain, domainName } = await setup();

    // Same policy domain, same day, but a different report id, so this is a
    // second real report rather than a duplicate delivery. Collapsing these
    // would hide traffic.
    const first = await ingestDmarcReport({ organizationId, domainId: domain.id, xml: report({ domain: domainName, reportId: 'morning' }) });
    const second = await ingestDmarcReport({ organizationId, domainId: domain.id, xml: report({ domain: domainName, reportId: 'evening' }) });

    expect(first.status).toBe('created');
    expect(second.status).toBe('created');

    const stored = await prisma.dmarcReport.findMany({ where: { domainId: domain.id } });
    expect(stored).toHaveLength(2);
  });

  it('falls back to content matching when a report states no report id', async () => {
    const { organizationId, domain, domainName } = await setup();

    // A receiver that omits the id gives nothing stable to match on, so
    // identity is null and the content hash has to carry the deduplication.
    const xml = report({ domain: domainName, reportId: 'present' }).replace(
      `<report_id>present</report_id>`,
      '',
    );

    const first = await ingestDmarcReport({ organizationId, domainId: domain.id, xml });
    const second = await ingestDmarcReport({ organizationId, domainId: domain.id, xml });

    expect(first.status).toBe('created');
    expect(second.status).toBe('duplicate');

    const stored = await prisma.dmarcReport.findFirst({ where: { domainId: domain.id } });
    expect(stored?.reportIdentity).toBeNull();
  });

  it('does not let one report id from two senders collide', async () => {
    const { organizationId, domain, domainName } = await setup();

    // The same report id, a different org_name. If identity ignored the sender
    // one sender's traffic would be silently discarded as a duplicate.
    const google = report({ domain: domainName, reportId: 'shared-id' });
    const other = google.replace('<org_name>Google LLC</org_name>', '<org_name>Microsoft Exchange Online</org_name>');

    const first = await ingestDmarcReport({ organizationId, domainId: domain.id, xml: google });
    const second = await ingestDmarcReport({ organizationId, domainId: domain.id, xml: other });

    expect(first.status).toBe('created');
    expect(second.status).toBe('created');
  });

  it('deduplicates the same report arriving by mailbox and by DNS', async () => {
    const { organizationId, domain, domainName } = await setup();
    const reportId = `split-${Date.now()}`;

    // The case the feature exists for: a high volume sender delivers by both
    // routes, and the emailed copy is a different byte sequence.
    const viaMail = report({ domain: domainName, reportId, indent: '  ' });
    const viaDns = report({ domain: domainName, reportId, indent: '' });

    const mailed = await ingestDmarcReport({ organizationId, domainId: domain.id, xml: viaMail });
    const fetched = await ingestDmarcReportByPolicyDomain(viaDns);

    expect(mailed.status).toBe('created');
    expect(fetched.status).toBe('duplicate');

    const stored = await prisma.dmarcReport.findMany({ where: { domainId: domain.id } });
    expect(stored).toHaveLength(1);
  });
});

describe('mailbox settings', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('stores the password encrypted and never returns it', async () => {
    const { organizationId } = await setup();

    await configureInbox(organizationId, {
      host: 'imap.migadu.com',
      username: 'agg@reports.dmarcharbor.com',
      password: 'a-real-mailbox-password',
    });

    const row = await prisma.reportInbox.findUnique({ where: { organizationId } });
    expect(row?.encryptedPassword).not.toContain('a-real-mailbox-password');
    expect(row?.encryptedPassword).not.toBe('a-real-mailbox-password');

    const status = await inboxStatus(organizationId);
    expect(JSON.stringify(status)).not.toContain('a-real-mailbox-password');
    // The host and username are not secrets, and support needs them to explain
    // why collection is not working.
    expect(status.host).toBe('imap.migadu.com');
    expect(status.username).toBe('agg@reports.dmarcharbor.com');
  });

  it('defaults to implicit TLS on 993', async () => {
    const { organizationId } = await setup();

    await configureInbox(organizationId, { host: 'imap.migadu.com', username: 'a@b.test', password: 'pw' });

    const row = await prisma.reportInbox.findUnique({ where: { organizationId } });
    expect(row?.port).toBe(993);
    expect(row?.secure).toBe(true);
  });

  it('refuses a loopback mail host', async () => {
    const { organizationId } = await setup();

    // Collection is configured by an authenticated agency user, not by a
    // customer, but a loopback target would let a misconfigured setting reach
    // a service on our own network and report the result as customer data.
    await expect(
      configureInbox(organizationId, { host: '127.0.0.1', username: 'a@b.test', password: 'pw' }),
    ).rejects.toBeInstanceOf(InboxError);

    expect(await prisma.reportInbox.findUnique({ where: { organizationId } })).toBeNull();
  });

  it('refuses a port that is not a mail port', async () => {
    const { organizationId } = await setup();

    await expect(
      configureInbox(organizationId, { host: 'imap.migadu.com', port: 22, username: 'a@b.test', password: 'pw' }),
    ).rejects.toBeInstanceOf(InboxError);
  });

  it('is gated to Harbor and above', async () => {
    const { agent, organizationId } = await setup('MOORING');

    const response = await agent
      .put(`/api/workspaces/${organizationId}/report-inbox`)
      .send({ host: 'imap.migadu.com', username: 'a@b.test', password: 'pw' });

    expect(response.status).toBe(402);
    expect(await prisma.reportInbox.findUnique({ where: { organizationId } })).toBeNull();
  });

  it('allows a Harbor workspace to configure collection', async () => {
    const { agent, organizationId } = await setup('HARBOR');

    const response = await agent
      .put(`/api/workspaces/${organizationId}/report-inbox`)
      .send({ host: 'imap.migadu.com', username: 'agg@reports.dmarcharbor.com', password: 'pw' });

    expect(response.status).toBe(200);
    expect(response.body.configured).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('pw"');
  });

  it('records who configured the mailbox without storing the password', async () => {
    const { agent, organizationId } = await setup('HARBOR');

    await agent
      .put(`/api/workspaces/${organizationId}/report-inbox`)
      .send({ host: 'imap.migadu.com', username: 'agg@reports.dmarcharbor.com', password: 'super-secret-value' });

    const audit = await prisma.auditLog.findFirst({
      where: { organizationId, action: 'REPORT_INBOX_CONFIGURED' },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.detail)).not.toContain('super-secret-value');
  });

  it('does not expose another workspace mailbox to a non member', async () => {
    const { organizationId } = await setup('HARBOR');
    await configureInbox(organizationId, { host: 'imap.migadu.com', username: 'a@b.test', password: 'pw' });

    const outsider = await setup('HARBOR');
    const response = await outsider.agent.get(`/api/workspaces/${organizationId}/report-inbox`);

    // Either refused outright, or refused as a non member of that workspace.
    // Either way the mailbox settings must not come back.
    expect([403, 404]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain('a@b.test');
  });
});
