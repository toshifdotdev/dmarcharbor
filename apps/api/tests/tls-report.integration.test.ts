import { createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { prisma } from '../src/database/prisma.js';
import { grantPlan } from './helpers/plan.js';
import {
  ingestTlsReport,
  purgeExpiredTlsReports,
} from '../src/services/tls-report/tls-report.service.js';
import { clientTlsReportAddress } from '../src/services/report-address.service.js';
import { buildCsvExport, buildExportPayload } from '../src/services/export/export.service.js';

let fixtureId = 0;
const password = 'correct-horse-battery-staple';
const secret = 'test-report-ingest-secret-please-change';
const boundary = 'tls-report-boundary';

function resetDatabase(): Promise<void> {
  return prisma
    .$executeRawUnsafe(
      'TRUNCATE TABLE "tls_report_failure", "tls_report_policy", "tls_report", "webhook_delivery", "webhook_endpoint", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user", subscription CASCADE',
    )
    .then(() => undefined);
}

function sign(rawEmail: string): { timestamp: string; signature: string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return {
    timestamp,
    signature: `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawEmail}`).digest('hex')}`,
  };
}

async function postSigned(rawEmail: string) {
  const signed = sign(rawEmail);
  return request(app)
    .post('/api/internal/reports/inbound')
    .set('Content-Type', 'message/rfc822')
    .set('X-DMARC-Timestamp', signed.timestamp)
    .set('X-DMARC-Signature', signed.signature)
    .send(rawEmail);
}

function tlsJson(input: {
  domain: string;
  organizationName?: string;
  reportId?: string;
  begin?: string;
  end?: string;
  policies?: Array<{
    type?: string;
    mxHost?: string;
    successful?: number;
    failed?: number;
    failures?: Array<{ type: string; count: number; additional?: string }>;
  }>;
}): string {
  const begin = input.begin ?? new Date(Date.now() - 2 * 86400000).toISOString();
  const end = input.end ?? new Date(Date.now() - 86400000).toISOString();
  const policies = input.policies ?? [
    {
      type: 'sts',
      mxHost: 'mx1.example.test',
      successful: 100,
      failed: 5,
      failures: [{ type: 'certificate-expired', count: 5, additional: 'certificate expired' }],
    },
  ];
  return JSON.stringify({
    'organization-name': input.organizationName ?? 'Google LLC',
    'date-range': { 'start-datetime': begin, 'end-datetime': end },
    'contact-info': 'tls-reports@example.test',
    'report-id': input.reportId ?? `tls-${Date.now()}-${++fixtureId}`,
    policies: policies.map((policy) => ({
      policy: {
        'policy-type': policy.type ?? 'sts',
        'policy-string': ['version: STSv1', 'mode: enforce'],
        'policy-domain': input.domain,
        'mx-host': policy.mxHost ?? 'mx1.example.test',
      },
      summary: {
        'total-successful-session-count': policy.successful ?? 100,
        'total-failure-session-count': policy.failed ?? 5,
      },
      'failure-details': (policy.failures ?? []).map((failure) => ({
        'result-type': failure.type,
        'sending-mta-ip': '192.0.2.10',
        'receiving-mx-hostname': policy.mxHost ?? 'mx1.example.test',
        'failed-session-count': failure.count,
        'additional-information': failure.additional,
      })),
    })),
  });
}

function tlsEmail(json: string, input: { domain: string; gzip?: boolean }): string {
  const content = input.gzip === false ? Buffer.from(json) : gzipSync(Buffer.from(json));
  const type = input.gzip === false ? 'application/tlsrpt+json' : 'application/tlsrpt+gzip';
  return [
    'From: tls-reports@google.com',
    'To: dmarc-reports@reports.dmarcharbor.com',
    `Subject: Report Domain: ${input.domain} Submitter: google.com Report-ID: tls-${Date.now()}`,
    `TLS-Report-Domain: ${input.domain}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/report; report-type=tlsrpt; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'This is a TLS-RPT report.',
    `--${boundary}`,
    `Content-Type: ${type}; name="google.com!${input.domain}!2026-10-01T00:00:00Z!2026-10-02T00:00:00Z.json.gz"`,
    `Content-Disposition: attachment; filename="google.com!${input.domain}!2026-10-01T00:00:00Z!2026-10-02T00:00:00Z.json.gz"`,
    'Content-Transfer-Encoding: base64',
    '',
    content.toString('base64'),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function aggregateReport(domain: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>Google LLC</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>aggregate-${Date.now()}</report_id>
    <date_range><begin>1712188800</begin><end>1712275199</end></date_range>
  </report_metadata>
  <policy_published><domain>${domain}</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><fraction>100</fraction></policy_published>
  <record>
    <row><source_ip>192.0.2.10</source_ip><count>1</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>
    <identifiers><header_from>${domain}</header_from></identifiers>
  </record>
</feedback>`;
}

function aggregateEmail(domain: string): string {
  const content = gzipSync(Buffer.from(aggregateReport(domain)));
  return [
    'From: noreply-dmarc-support@google.com',
    'To: dmarc-reports@reports.dmarcharbor.com',
    `Subject: Report Domain: ${domain} Submitter: google.com Report-ID: agg-${Date.now()}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: application/gzip; name="report.xml.gz"',
    'Content-Disposition: attachment; filename="report.xml.gz"',
    'Content-Transfer-Encoding: base64',
    '',
    content.toString('base64'),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function forensicEmail(domain: string): string {
  return [
    'From: noreply-dmarc-support@google.com',
    'To: dmarc-reports@reports.dmarcharbor.com',
    `Subject: DMARC failure report for ${domain}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/report; report-type=feedback-report; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'This is a DMARC failure report.',
    `--${boundary}`,
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.google.com',
    'Source-IP: 192.0.2.10',
    'Final-Recipient: rfc822; alice@example.com',
    'Action: fail',
    `--${boundary}`,
    'Content-Type: application/feedback-report',
    '',
    'Feedback-Type: feedback-report',
    'Version: 1',
    `Reported-Domain: ${domain}`,
    'Authentication-Results: mx.google.com; spf=fail smtp.mailfrom=spammer.test; dkim=fail header.i=@spammer.test header.s=key1 header.d=spammer.test',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

async function setup(plan: 'FAIRWAY' | 'MOORING' = 'FAIRWAY') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `tls-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'TLS Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'TLS Agency',
    slug: `tls-agency-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);
  const organizationId = workspace.body.id as string;
  if (plan === 'FAIRWAY') await grantPlan(organizationId, 'FAIRWAY');

  const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
    name: 'TLS Client',
    slug: `tls-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);
  const clientId = client.body.id as string;

  const domainName = `tls-${Date.now()}-${fixtureId}.example`;
  const domain = await agent
    .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`)
    .send({ name: domainName });
  expect(domain.status).toBe(201);
  await prisma.domain.update({
    where: { id: domain.body.id },
    data: { status: 'VERIFIED', verifiedAt: new Date() },
  });

  return {
    agent,
    organizationId,
    clientId,
    domainId: domain.body.id as string,
    domainName,
  };
}

const base = (organizationId: string, domainId: string) =>
  `/api/workspaces/${organizationId}/domains/${domainId}/tls-reports`;

async function seedScan(domainId: string, tlsRpt: Record<string, unknown>): Promise<void> {
  await prisma.scan.deleteMany({ where: { domainId } });
  await prisma.scan.create({
    data: {
      domainId,
      status: 'COMPLETED',
      trigger: 'MANUAL',
      result: { tlsRpt } as never,
      startedAt: new Date(),
      completedAt: new Date(),
    },
  });
}

describe('TLS-RPT reports', () => {
  beforeEach(resetDatabase);

  it('creates from a signed multipart TLS report and deduplicates it', async () => {
    const fixture = await setup();
    const json = tlsJson({ domain: fixture.domainName, reportId: 'r-created' });
    const email = tlsEmail(json, { domain: fixture.domainName });

    const created = await postSigned(email);
    expect(created.status).toBe(200);
    expect(created.body.kind).toBe('tlsrpt');
    expect(created.body.results[0].status).toBe('created');
    expect(created.body.results[0].reportDomain).toBe(fixture.domainName);
    expect(await prisma.tlsReport.count({ where: { domainId: fixture.domainId } })).toBe(1);

    const duplicate = await postSigned(email);
    expect(duplicate.body.results[0].status).toBe('duplicate');
    expect(await prisma.tlsReport.count({ where: { domainId: fixture.domainId } })).toBe(1);
  });

  it('rejects an unknown domain and a mixed-domain report without storing anything', async () => {
    const fixture = await setup();
    const unknown = await postSigned(
      tlsEmail(tlsJson({ domain: 'unknown.test' }), { domain: 'unknown.test' }),
    );
    expect(unknown.body.results[0].status).toBe('rejected');
    expect(await prisma.tlsReport.count()).toBe(0);

    const mixed = JSON.parse(
      tlsJson({
        domain: fixture.domainName,
        policies: [
          { mxHost: 'mx1.example.test', successful: 1, failed: 1 },
        ],
      }),
    ) as Record<string, unknown>;
    const policies = mixed.policies as Array<Record<string, unknown>>;
    const second = structuredClone(policies[0]!);
    (second.policy as Record<string, unknown>)['policy-domain'] = 'other.example';
    policies.push(second);
    const mixedResponse = await postSigned(
      tlsEmail(JSON.stringify(mixed), { domain: fixture.domainName }),
    );
    expect(mixedResponse.body.results[0].status).toBe('failed');
    expect(mixedResponse.body.results[0].message).toContain('more than one domain');
    expect(await prisma.tlsReport.count()).toBe(0);
  });

  it('keeps aggregate, forensic and TLS-RPT intake on their own branches', async () => {
    const fixture = await setup();
    const aggregate = await postSigned(aggregateEmail(fixture.domainName));
    expect(aggregate.body.kind).toBe('aggregate');
    expect(aggregate.body.results[0].status).toBe('created');

    const forensic = await postSigned(forensicEmail(fixture.domainName));
    expect(forensic.body.kind).toBe('forensic');

    const tls = await postSigned(
      tlsEmail(tlsJson({ domain: fixture.domainName }), { domain: fixture.domainName }),
    );
    expect(tls.body.kind).toBe('tlsrpt');
    expect(tls.body.results[0].status).toBe('created');
    expect(await prisma.tlsReport.count()).toBe(1);
  });

  it('still ingests a DMARC report whose message merely mentions a TLS-RPT marker', async () => {
    const fixture = await setup();
    // A header the TLS detector looks for, on a message whose only attachment
    // is a DMARC aggregate report. Nothing decodes as TLS-RPT, so the message
    // must fall through to the aggregate branch rather than vanish.
    const raw = aggregateEmail(fixture.domainName).replace(
      'Content-Type: multipart/mixed;',
      `TLS-Report-Domain: ${fixture.domainName}\r\nContent-Type: multipart/mixed;`,
    );
    const response = await postSigned(raw);
    expect(response.body.kind).toBe('aggregate');
    expect(response.body.results[0].status).toBe('created');
    expect(await prisma.dmarcReport.count()).toBe(1);
    expect(await prisma.tlsReport.count()).toBe(0);
  });

  it('stores on Mooring but gates the reads, and serves Fairway', async () => {
    const mooring = await setup('MOORING');
    const response = await postSigned(
      tlsEmail(tlsJson({ domain: mooring.domainName }), { domain: mooring.domainName }),
    );
    expect(response.body.results[0].status).toBe('created');
    expect(await prisma.tlsReport.count()).toBe(1);

    const list = await mooring.agent.get(base(mooring.organizationId, mooring.domainId));
    expect(list.status).toBe(402);
    const summary = await mooring.agent.get(`${base(mooring.organizationId, mooring.domainId)}/summary`);
    expect(summary.status).toBe(402);
    const reportId = response.body.results[0].reportId as string;
    const detail = await mooring.agent.get(
      `/api/workspaces/${mooring.organizationId}/tls-reports/${reportId}`,
    );
    expect(detail.status).toBe(402);

    const fairway = await setup();
    await ingestTlsReport({
      organizationId: fairway.organizationId,
      domainId: fairway.domainId,
      json: tlsJson({ domain: fairway.domainName }),
    });
    expect((await fairway.agent.get(base(fairway.organizationId, fairway.domainId))).status).toBe(200);
    expect(
      (await fairway.agent.get(`${base(fairway.organizationId, fairway.domainId)}/summary`)).status,
    ).toBe(200);
  });

  it('summarises two reports in SQL and exposes the latest scan record state', async () => {
    const fixture = await setup();
    const ours = clientTlsReportAddress(
      (await prisma.domain.findUniqueOrThrow({
        where: { id: fixture.domainId },
        select: { client: { select: { reportToken: true } } },
      })).client.reportToken,
    );
    const beginA = new Date(Date.now() - 3 * 86400000).toISOString();
    const endA = new Date(Date.now() - 2 * 86400000).toISOString();
    const beginB = new Date(Date.now() - 86400000).toISOString();
    const endB = new Date().toISOString();

    await ingestTlsReport({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      json: tlsJson({
        domain: fixture.domainName,
        organizationName: 'Google LLC',
        reportId: 'summary-a',
        begin: beginA,
        end: endA,
        policies: [
          {
            type: 'sts',
            mxHost: 'mx1.example.test',
            successful: 80,
            failed: 3,
            failures: [{ type: 'certificate-expired', count: 3 }],
          },
          {
            type: 'sts',
            mxHost: 'mx2.example.test',
            successful: 20,
            failed: 2,
            failures: [{ type: 'starttls-not-supported', count: 2 }],
          },
        ],
      }),
    });
    await ingestTlsReport({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      json: tlsJson({
        domain: fixture.domainName,
        organizationName: 'Microsoft Corporation',
        reportId: 'summary-b',
        begin: beginB,
        end: endB,
        policies: [
          {
            type: 'sts',
            mxHost: 'mx1.example.test',
            successful: 50,
            failed: 10,
            failures: [{ type: 'certificate-expired', count: 10 }],
          },
        ],
      }),
    });

    const list = await fixture.agent.get(base(fixture.organizationId, fixture.domainId));
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items[0].reportId).toBe('summary-b');
    expect(list.body.items[0].policies).toHaveLength(1);
    expect(list.body.items[0].policies[0].failures).toBeUndefined();

    const detail = await fixture.agent.get(
      `/api/workspaces/${fixture.organizationId}/tls-reports/${list.body.items[0].id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.reportId).toBe('summary-b');
    expect(detail.body.policies[0].failures).toHaveLength(1);
    expect(detail.body.policies[0].failures[0].resultType).toBe('certificate-expired');

    const summary = await fixture.agent.get(
      `${base(fixture.organizationId, fixture.domainId)}/summary?days=30`,
    );
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      reportCount: 2,
      successfulSessions: 150,
      failedSessions: 15,
      failureSharePercent: 9.09,
    });
    expect(summary.body.byResultType).toEqual([
      { resultType: 'certificate-expired', failedSessions: 13, reporters: ['Google LLC', 'Microsoft Corporation'] },
      { resultType: 'starttls-not-supported', failedSessions: 2, reporters: ['Google LLC'] },
    ]);
    expect(summary.body.byMxHost).toEqual([
      { receivingMxHostname: 'mx1.example.test', failedSessions: 13, resultTypes: ['certificate-expired'] },
      { receivingMxHostname: 'mx2.example.test', failedSessions: 2, resultTypes: ['starttls-not-supported'] },
    ]);
    expect(summary.body.record.status).toBe('unknown');
    expect(summary.body.record.suggested).toBe(`v=TLSRPTv1; rua=mailto:${ours}`);

    await seedScan(fixture.domainId, {
      status: 'missing',
      valid: false,
      mailtoTargets: [],
      httpsTargets: [],
      problems: [],
    });
    const missing = await fixture.agent.get(
      `${base(fixture.organizationId, fixture.domainId)}/summary`,
    );
    expect(missing.body.record).toMatchObject({
      status: 'missing',
      current: null,
      suggested: `v=TLSRPTv1; rua=mailto:${ours}`,
    });

    await seedScan(fixture.domainId, {
      status: 'found',
      valid: true,
      record: `v=TLSRPTv1; rua=mailto:${ours}`,
      mailtoTargets: [`mailto:${ours}`],
      httpsTargets: [],
      problems: [],
    });
    const own = await fixture.agent.get(`${base(fixture.organizationId, fixture.domainId)}/summary`);
    expect(own.body.record.status).toBe('ours');

    await seedScan(fixture.domainId, {
      status: 'found',
      valid: true,
      record: 'v=TLSRPTv1; rua=mailto:other@example.net',
      mailtoTargets: ['mailto:other@example.net'],
      httpsTargets: [],
      problems: [],
    });
    const other = await fixture.agent.get(`${base(fixture.organizationId, fixture.domainId)}/summary`);
    expect(other.body.record.status).toBe('other');
    expect(other.body.record.suggested).toContain('mailto:other@example.net');
    expect(other.body.record.suggested).toContain(`mailto:${ours}`);

    await seedScan(fixture.domainId, {
      status: 'found',
      valid: false,
      record: 'v=TLSRPTv1; rua=mailto:other@example.net,bad',
      mailtoTargets: ['mailto:other@example.net'],
      httpsTargets: ['https://policy.example.net'],
      problems: ['bad is not a mailto: or https: address.'],
    });
    const invalid = await fixture.agent.get(
      `${base(fixture.organizationId, fixture.domainId)}/summary`,
    );
    expect(invalid.body.record.status).toBe('invalid');
    expect(invalid.body.record.suggested).toContain('mailto:other@example.net');
    expect(invalid.body.record.suggested).toContain('https://policy.example.net');
    expect(invalid.body.record.suggested).toContain(`mailto:${ours}`);
  });

  it('delivers tlsrpt.received only to subscribed webhook endpoints', async () => {
    const fixture = await setup();
    const subscribed = await fixture.agent.post(`/api/workspaces/${fixture.organizationId}/webhooks`).send({
      name: 'TLS receiver',
      url: 'https://hooks.example.com/dmarc',
      events: ['tlsrpt.received'],
    });
    expect(subscribed.status).toBe(201);
    const unsubscribed = await fixture.agent.post(`/api/workspaces/${fixture.organizationId}/webhooks`).send({
      name: 'Other receiver',
      url: 'https://hooks.example.com/other',
      events: ['report.received'],
    });
    expect(unsubscribed.status).toBe(201);

    await ingestTlsReport({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      json: tlsJson({ domain: fixture.domainName }),
    });

    const deliveries = await prisma.webhookDelivery.findMany({
      where: { organizationId: fixture.organizationId, event: 'tlsrpt.received' },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.endpointId).toBe(subscribed.body.id);
    expect(deliveries[0]!.payload).toMatchObject({
      type: 'tlsrpt.received',
      data: { organizationName: 'Google LLC', successfulSessions: 100, failedSessions: 5 },
    });
    expect(
      await prisma.webhookDelivery.count({
        where: { endpointId: unsubscribed.body.id, event: 'tlsrpt.received' },
      }),
    ).toBe(0);
  });

  it('purges an expired report, exports reports, and erases them with the domain', async () => {
    const fixture = await setup();
    const ingested = await ingestTlsReport({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      json: tlsJson({ domain: fixture.domainName }),
    });
    expect(ingested.status).toBe('created');
    const reportId = (await prisma.tlsReport.findFirstOrThrow({ where: { domainId: fixture.domainId } })).id;

    await prisma.tlsReport.update({
      where: { id: reportId },
      data: { retentionExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(await purgeExpiredTlsReports(true)).toBe(1);

    const second = await ingestTlsReport({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      json: tlsJson({ domain: fixture.domainName, reportId: 'exported' }),
    });
    expect(second.status).toBe('created');
    const payload = await buildExportPayload({
      organizationId: fixture.organizationId,
      scope: 'DOMAIN',
      targetId: fixture.domainId,
      format: 'JSON',
      scopeLabel: 'test',
    });
    const reports = payload.data.tlsReports as Array<{
      policies: Array<{ failures: unknown[] }>;
    }>;
    expect(reports).toHaveLength(1);
    expect(reports[0]!.policies[0]!.failures).toHaveLength(1);
    const csv = buildCsvExport(payload);
    expect(csv).toContain('tls_report_failures');
    expect(csv).toContain('certificate-expired');

    const requestErasure = await fixture.agent
      .post(`/api/workspaces/${fixture.organizationId}/erasures`)
      .send({ scope: 'DOMAIN', targetId: fixture.domainId });
    expect(requestErasure.status).toBe(202);
    const executed = await fixture.agent
      .post(`/api/workspaces/${fixture.organizationId}/erasures/${requestErasure.body.id}/execute`)
      .send({ confirmNamePurge: true });
    expect(executed.status).toBe(200);
    expect(await prisma.tlsReport.count()).toBe(0);
  });

  it('answers 404 for another workspace on all three routes', async () => {
    const first = await setup();
    const ingested = await ingestTlsReport({
      organizationId: first.organizationId,
      domainId: first.domainId,
      json: tlsJson({ domain: first.domainName }),
    });
    expect(ingested.status).toBe('created');
    const reportId = (await prisma.tlsReport.findFirstOrThrow({ where: { domainId: first.domainId } })).id;

    const second = await setup();
    expect(
      (
        await second.agent.get(base(second.organizationId, first.domainId))
      ).status,
    ).toBe(404);
    expect(
      (
        await second.agent.get(`${base(second.organizationId, first.domainId)}/summary`)
      ).status,
    ).toBe(404);
    expect(
      (
        await second.agent.get(`/api/workspaces/${second.organizationId}/tls-reports/${reportId}`)
      ).status,
    ).toBe(404);
  });
});
