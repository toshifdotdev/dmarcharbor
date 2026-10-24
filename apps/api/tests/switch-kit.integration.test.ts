import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { env } from '../src/config/env.js';
import { clientAggregateAddress } from '../src/services/report-address.service.js';
import { systemDnsReader } from '../src/scanner/dns.js';
import { scanDomain } from '../src/scanner/scanner.js';
import { runDomainScan } from '../src/services/domain-scan.service.js';
import { grantPlan } from './helpers/plan.js';

vi.mock('../src/scanner/scanner.js', () => ({ scanDomain: vi.fn() }));

let fixtureId = 0;
let reportId = 0;
const password = 'correct-horse-battery-staple';
const originalMode = env.REPORT_ADDRESS_SUBADDRESSING;
const records = new Map<string, string>();
const dnsState: { authMode: 'ok' | 'missing' | 'error' } = { authMode: 'ok' };
let txtSpy: ReturnType<typeof vi.spyOn>;

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "domain_switch", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

beforeAll(async () => {
  env.REPORT_ADDRESS_SUBADDRESSING = 'plus';
  txtSpy = vi.spyOn(systemDnsReader, 'resolveTxt').mockImplementation(async (name) => {
    if (name.endsWith('._report._dmarc.reports.dmarcharbor.com')) {
      if (dnsState.authMode === 'error') {
        return { status: 'error', error: 'timeout' };
      }
      return dnsState.authMode === 'ok'
        ? { status: 'found', value: [['v=DMARC1']] }
        : { status: 'missing' };
    }
    if (name.startsWith('_dmarc.') && !name.includes('._report.')) {
      const record = records.get(name.slice('_dmarc.'.length));
      return record ? { status: 'found', value: [[record]] } : { status: 'missing' };
    }
    return { status: 'missing' };
  });
  vi.spyOn(systemDnsReader, 'resolveCname').mockResolvedValue({ status: 'missing' });
  await resetDatabase();
});

afterAll(() => {
  env.REPORT_ADDRESS_SUBADDRESSING = originalMode;
  vi.restoreAllMocks();
});

async function createWorkspace(options: { plan?: boolean } = {}) {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `switch-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'Switch Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'Switch Agency',
    slug: `switch-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);

  const organizationId = workspace.body.id as string;
  if (options.plan !== false) {
    await grantPlan(organizationId);
  }

  return { agent, organizationId, email };
}

async function createClient(
  agent: ReturnType<typeof request.agent>,
  organizationId: string,
  name = 'Switch Client',
) {
  fixtureId += 1;
  const response = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
    name,
    slug: `switch-client-${fixtureId}`,
  });
  expect(response.status).toBe(201);
  return response.body as { id: string; name: string };
}

async function createDomain(
  agent: ReturnType<typeof request.agent>,
  organizationId: string,
  clientId: string,
  name: string,
) {
  const response = await agent
    .post(`/api/workspaces/${organizationId}/clients/${clientId}/domains`)
    .send({ name });
  expect(response.status).toBe(201);
  return response.body as { id: string; name: string; slug: string; verificationToken: string };
}

function uniqueDomain(label: string): string {
  fixtureId += 1;
  return `${label}-${fixtureId}.test`;
}

async function clientAddresses(clientId: string) {
  const client = await prisma.client.findUniqueOrThrow({
    where: { id: clientId },
    select: { reportToken: true },
  });
  return {
    token: client.reportToken,
    address: clientAggregateAddress(client.reportToken),
    uri: `mailto:${clientAggregateAddress(client.reportToken)}`,
  };
}

const INCUMBENT = 'mailto:aggregate@ag.dmarcian.com';

function dualRecord(ourUri: string): string {
  return `v=DMARC1; p=none; rua=${ourUri},${INCUMBENT}`;
}

function incumbentRecord(): string {
  return `v=DMARC1; p=none; rua=${INCUMBENT}`;
}

async function importDomains(
  agent: ReturnType<typeof request.agent>,
  organizationId: string,
  clientId: string,
  domains: string[],
) {
  return agent
    .post(`/api/workspaces/${organizationId}/clients/${clientId}/switch-kit`)
    .send({ domains });
}

function dayStart(daysAgo: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo));
}

async function seedAggregateReport(input: {
  domainId: string;
  organization: string;
  daysAgo: number;
  messages: number;
}): Promise<void> {
  reportId += 1;
  const begin = dayStart(input.daysAgo);
  await prisma.dmarcReport.create({
    data: {
      domainId: input.domainId,
      reportType: 'AGGREGATE',
      fingerprint: `switch-fp-${reportId}-${Date.now()}`,
      reportingOrganization: input.organization,
      reportingEmail: `noreply@${input.organization.replace(/\s+/g, '').toLowerCase()}.test`,
      dateRangeBegin: begin,
      dateRangeEnd: new Date(begin.getTime() + 86_400_000 - 1_000),
      records: {
        create: [{ sourceIp: '192.0.2.10', messageCount: input.messages }],
      },
    },
  });
}

async function switchFixture(recordForDomain: string | ((ourUri: string) => string)) {
  const workspace = await createWorkspace();
  const client = await createClient(workspace.agent, workspace.organizationId);
  const name = uniqueDomain('switch');
  const addresses = await clientAddresses(client.id);
  records.set(
    name,
    typeof recordForDomain === 'function' ? recordForDomain(addresses.uri) : recordForDomain,
  );

  const imported = await importDomains(workspace.agent, workspace.organizationId, client.id, [name]);
  expect(imported.status).toBe(201);
  const row = imported.body.results[0] as { domainId: string; name: string };

  return { ...workspace, client, name, addresses, domainId: row.domainId };
}

describe('switch kit import', () => {
  it('creates pending domains and returns plans with verification records', async () => {
    const { agent, organizationId } = await createWorkspace();
    const client = await createClient(agent, organizationId);
    const addresses = await clientAddresses(client.id);
    const first = uniqueDomain('dual');
    const second = uniqueDomain('dual');
    records.set(first, incumbentRecord());
    records.set(second, 'v=DMARC1; p=none; rua=mailto:reports@rua.easydmarc.us');

    const response = await importDomains(agent, organizationId, client.id, [first, second]);

    expect(response.status).toBe(201);
    expect(response.body.results).toHaveLength(2);
    expect(response.body.ownershipNote).toContain('Publishing the DMARC record below also proves ownership');

    for (const [index, result] of response.body.results.entries()) {
      expect(result.index).toBe(index);
      expect(result.created).toBe(true);
      expect(result.verification.host).toBe(`_dmarc-harbor-verification.${result.name}`);
      expect(result.verification.value).toMatch(/^dmarc-harbor-verification=/);
      expect(result.plan.lookup).toBe('found');
      expect(result.plan.record.value).toContain(addresses.uri);
      expect(result.switchStatus).toBe('PLANNED');
    }

    expect(response.body.results[0].plan.incumbents[0].vendor).toBe('dmarcian');
    expect(response.body.results[1].plan.incumbents[0].vendor).toBe('easydmarc');

    const domains = await prisma.domain.findMany({
      where: { name: { in: [first, second] } },
      select: { status: true },
    });
    expect(domains.map((domain) => domain.status)).toEqual(['PENDING', 'PENDING']);
    expect(await prisma.domainSwitch.count()).toBe(2);
  });

  it('creates switch rows only where an incumbent exists and audits once', async () => {
    const { agent, organizationId } = await createWorkspace();
    const client = await createClient(agent, organizationId);
    const addresses = await clientAddresses(client.id);
    const incumbent = uniqueDomain('with-incumbent');
    const oursOnly = uniqueDomain('ours-only');
    const noRecord = uniqueDomain('no-record');
    records.set(incumbent, incumbentRecord());
    records.set(oursOnly, `v=DMARC1; p=none; rua=${addresses.uri}`);

    const response = await importDomains(agent, organizationId, client.id, [
      incumbent,
      oursOnly,
      noRecord,
    ]);

    expect(response.status).toBe(201);
    expect(response.body.results.map((row: { switchStatus: string | null }) => row.switchStatus)).toEqual([
      'PLANNED',
      null,
      null,
    ]);
    expect(response.body.results[1].plan.alreadyReportingToUs).toBe(true);
    expect(response.body.results[2].plan.lookup).toBe('no_record');

    expect(await prisma.domainSwitch.count({ where: { organizationId } })).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { organizationId, action: 'SWITCH_KIT_IMPORTED' },
      }),
    ).toBe(1);
  });

  it('reports a domain held by another workspace as failed', async () => {
    const first = await createWorkspace();
    const second = await createWorkspace();
    const otherClient = await createClient(second.agent, second.organizationId, 'Other Client');
    const taken = uniqueDomain('taken');
    await createDomain(second.agent, second.organizationId, otherClient.id, taken);

    const client = await createClient(first.agent, first.organizationId);
    const response = await importDomains(first.agent, first.organizationId, client.id, [taken]);

    expect(response.status).toBe(201);
    expect(response.body.results).toHaveLength(0);
    expect(response.body.failed).toHaveLength(1);
    expect(response.body.failed[0].reason).toContain('another workspace');
  });

  it('respects the plan quota through planBlocked', async () => {
    const { agent, organizationId } = await createWorkspace({ plan: false });
    const client = await createClient(agent, organizationId);
    const names = [uniqueDomain('quota'), uniqueDomain('quota'), uniqueDomain('quota')];
    for (const name of names) {
      records.set(name, incumbentRecord());
    }

    const response = await importDomains(agent, organizationId, client.id, names);

    expect(response.status).toBe(201);
    expect(response.body.results).toHaveLength(2);
    expect(response.body.planBlocked).toHaveLength(1);
    expect(response.body.planBlocked[0].reason).toContain('2 active domains');
  });

  it('includes a domain already in the client as existing', async () => {
    const { agent, organizationId } = await createWorkspace();
    const client = await createClient(agent, organizationId);
    const existingName = uniqueDomain('existing');
    const existing = await createDomain(agent, organizationId, client.id, existingName);
    const newName = uniqueDomain('new');
    records.set(existingName, incumbentRecord());
    records.set(newName, incumbentRecord());

    const response = await importDomains(agent, organizationId, client.id, [existingName, newName]);

    expect(response.status).toBe(201);
    const existingRow = response.body.results.find(
      (row: { domainId: string }) => row.domainId === existing.id,
    );
    const newRow = response.body.results.find((row: { name: string }) => row.name === newName);

    expect(existingRow.created).toBe(false);
    expect(existingRow.verification).toBeNull();
    expect(existingRow.switchStatus).toBe('PLANNED');
    expect(newRow.created).toBe(true);
  });

  it('refuses more than 100 domains and stops a viewer', async () => {
    const { agent, organizationId } = await createWorkspace();
    const client = await createClient(agent, organizationId);

    const tooMany = await importDomains(
      agent,
      organizationId,
      client.id,
      Array.from({ length: 101 }, (_, index) => `bulk-${index}.example.test`),
    );
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('VALIDATION_ERROR');

    const member = await prisma.member.findFirstOrThrow({ where: { organizationId } });
    await prisma.member.update({ where: { id: member.id }, data: { role: 'viewer' } });

    const denied = await importDomains(agent, organizationId, client.id, [uniqueDomain('viewer')]);
    expect(denied.status).toBe(403);
  });

  it('returns 404 for a client in another workspace', async () => {
    const first = await createWorkspace();
    const second = await createWorkspace();
    const otherClient = await createClient(second.agent, second.organizationId, 'Elsewhere');

    const response = await importDomains(first.agent, first.organizationId, otherClient.id, [
      uniqueDomain('elsewhere'),
    ]);

    expect(response.status).toBe(404);
  });
});

describe('checking a switch', () => {
  it('moves PLANNED to DUAL_REPORTING and then to CUT_OVER, auditing each transition', async () => {
    const fixture = await switchFixture(() => incumbentRecord());
    await prisma.domain.update({ where: { id: fixture.domainId }, data: { status: 'VERIFIED' } });

    records.set(fixture.name, dualRecord(fixture.addresses.uri));
    const started = await fixture.agent.post(
      `/api/workspaces/${fixture.organizationId}/domains/${fixture.domainId}/switch/check`,
    );

    expect(started.status).toBe(200);
    expect(started.body.switch.status).toBe('DUAL_REPORTING');
    expect(started.body.switch.startedAt).toBeTruthy();
    expect(started.body.throttled).toBe(false);
    expect(
      await prisma.auditLog.count({
        where: { organizationId: fixture.organizationId, action: 'DOMAIN_SWITCH_STARTED' },
      }),
    ).toBe(1);

    await prisma.domainSwitch.update({
      where: { domainId: fixture.domainId },
      data: { lastCheckedAt: new Date(Date.now() - 60_000) },
    });
    records.set(fixture.name, `v=DMARC1; p=none; rua=${fixture.addresses.uri}`);
    const cutOver = await fixture.agent.post(
      `/api/workspaces/${fixture.organizationId}/domains/${fixture.domainId}/switch/check`,
    );

    expect(cutOver.status).toBe(200);
    expect(cutOver.body.switch.status).toBe('CUT_OVER');
    expect(cutOver.body.switch.cutOverAt).toBeTruthy();
    expect(
      await prisma.auditLog.count({
        where: { organizationId: fixture.organizationId, action: 'DOMAIN_SWITCH_CUT_OVER' },
      }),
    ).toBe(1);
  });

  it('throttles a check made within 30 seconds', async () => {
    const fixture = await switchFixture(dualRecord);
    await prisma.domain.update({ where: { id: fixture.domainId }, data: { status: 'VERIFIED' } });

    const first = await fixture.agent.post(
      `/api/workspaces/${fixture.organizationId}/domains/${fixture.domainId}/switch/check`,
    );
    expect(first.status).toBe(200);

    const callsAfterFirst = txtSpy.mock.calls.length;
    const second = await fixture.agent.post(
      `/api/workspaces/${fixture.organizationId}/domains/${fixture.domainId}/switch/check`,
    );

    expect(second.status).toBe(200);
    expect(second.body.throttled).toBe(true);
    expect(second.body.switch.status).toBe('DUAL_REPORTING');
    expect(txtSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it('verifies a pending domain through the client token in its DMARC record', async () => {
    const fixture = await switchFixture(dualRecord);

    const response = await fixture.agent.post(
      `/api/workspaces/${fixture.organizationId}/domains/${fixture.domainId}/switch/check`,
    );

    expect(response.status).toBe(200);
    expect(response.body.verification.verified).toBe(true);
    expect(response.body.verification.method).toBe('report_address');
    expect(response.body.switch.status).toBe('DUAL_REPORTING');

    const domain = await prisma.domain.findUniqueOrThrow({ where: { id: fixture.domainId } });
    expect(domain.status).toBe('VERIFIED');
  });
});

describe('reading the overlap', () => {
  it('reports two receivers, coverage and a ready cutover', async () => {
    const fixture = await switchFixture(incumbentRecord());
    await prisma.domainSwitch.update({
      where: { domainId: fixture.domainId },
      data: { status: 'DUAL_REPORTING', startedAt: dayStart(16) },
    });
    for (let daysAgo = 16; daysAgo >= 1; daysAgo -= 1) {
      await seedAggregateReport({
        domainId: fixture.domainId,
        organization: 'Google LLC',
        daysAgo,
        messages: 1_000,
      });
      await seedAggregateReport({
        domainId: fixture.domainId,
        organization: 'Microsoft',
        daysAgo,
        messages: 500,
      });
    }

    const response = await fixture.agent.get(
      `/api/workspaces/${fixture.organizationId}/domains/${fixture.domainId}/switch`,
    );

    expect(response.status).toBe(200);
    expect(response.body.switch.status).toBe('DUAL_REPORTING');
    expect(response.body.overlap.receivers).toHaveLength(2);
    expect(response.body.overlap.totals.messages).toBe(24_000);
    expect(response.body.overlap.totals.dualDays).toBeGreaterThanOrEqual(16);
    expect(response.body.overlap.note).toContain('only on days they saw mail');
    expect(response.body.readiness.ready).toBe(true);
    expect(response.body.readiness.blockers).toEqual([]);
    expect(response.body.records.cutover.value).toContain(fixture.addresses.uri);
  });

  it('blocks when one major receiver has been silent for five days', async () => {
    const fixture = await switchFixture(incumbentRecord());
    await prisma.domainSwitch.update({
      where: { domainId: fixture.domainId },
      data: { status: 'DUAL_REPORTING', startedAt: dayStart(16) },
    });
    for (let daysAgo = 16; daysAgo >= 1; daysAgo -= 1) {
      await seedAggregateReport({
        domainId: fixture.domainId,
        organization: 'Google LLC',
        daysAgo,
        messages: 1_000,
      });
    }
    for (let daysAgo = 16; daysAgo >= 6; daysAgo -= 1) {
      await seedAggregateReport({
        domainId: fixture.domainId,
        organization: 'Microsoft',
        daysAgo,
        messages: 1_000,
      });
    }

    const response = await fixture.agent.get(
      `/api/workspaces/${fixture.organizationId}/domains/${fixture.domainId}/switch`,
    );

    expect(response.status).toBe(200);
    expect(response.body.readiness.ready).toBe(false);
    expect(response.body.readiness.blockers.join(' ')).toContain('Microsoft');
    expect(response.body.readiness.blockers.join(' ')).toContain('5 days');
  });

  it('answers eligibility without a switch row and never leaks across workspaces', async () => {
    const first = await createWorkspace();
    const client = await createClient(first.agent, first.organizationId);
    const name = uniqueDomain('eligible');
    const domain = await createDomain(first.agent, first.organizationId, client.id, name);
    const addresses = await clientAddresses(client.id);

    await prisma.domain.update({
      where: { id: domain.id },
      data: { dmarcRecord: incumbentRecord() },
    });
    const eligible = await first.agent.get(
      `/api/workspaces/${first.organizationId}/domains/${domain.id}/switch`,
    );
    expect(eligible.status).toBe(200);
    expect(eligible.body.switch).toBeNull();
    expect(eligible.body.eligible).toBe(true);

    await prisma.domain.update({
      where: { id: domain.id },
      data: { dmarcRecord: `v=DMARC1; p=none; rua=${addresses.uri}` },
    });
    const notEligible = await first.agent.get(
      `/api/workspaces/${first.organizationId}/domains/${domain.id}/switch`,
    );
    expect(notEligible.body.eligible).toBe(false);

    const second = await createWorkspace();
    const crossWorkspace = await second.agent.get(
      `/api/workspaces/${second.organizationId}/domains/${domain.id}/switch`,
    );
    expect(crossWorkspace.status).toBe(404);
  });
});

describe('stopping a switch', () => {
  it('removes the row and leaves the domain and its reports', async () => {
    const fixture = await switchFixture(incumbentRecord());
    await seedAggregateReport({
      domainId: fixture.domainId,
      organization: 'Google LLC',
      daysAgo: 1,
      messages: 20,
    });

    const response = await fixture.agent.delete(
      `/api/workspaces/${fixture.organizationId}/domains/${fixture.domainId}/switch`,
    );

    expect(response.status).toBe(204);
    expect(await prisma.domainSwitch.findUnique({ where: { domainId: fixture.domainId } })).toBeNull();
    expect(await prisma.domain.findUnique({ where: { id: fixture.domainId } })).not.toBeNull();
    expect(await prisma.dmarcReport.count({ where: { domainId: fixture.domainId } })).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { organizationId: fixture.organizationId, action: 'DOMAIN_SWITCH_CANCELLED' },
      }),
    ).toBe(1);
  });
});

describe('report addresses and onboarding', () => {
  it('serves the client address and adds it to the client list without the token', async () => {
    const { agent, organizationId } = await createWorkspace();
    const client = await createClient(agent, organizationId);
    const addresses = await clientAddresses(client.id);

    const response = await agent.get(
      `/api/workspaces/${organizationId}/clients/${client.id}/report-address`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      aggregateAddress: addresses.address,
      forensicAddress: 'dmarc-forensics@reports.dmarcharbor.com',
      sharedAggregateAddress: 'dmarc-reports@reports.dmarcharbor.com',
      personal: true,
    });

    const clients = await agent.get(`/api/workspaces/${organizationId}/clients`);
    expect(clients.status).toBe(200);
    expect(clients.body[0].reportAddress).toBe(addresses.address);
    expect(Object.keys(clients.body[0])).not.toContain('reportToken');

    const other = await createWorkspace();
    const missing = await other.agent.get(
      `/api/workspaces/${other.organizationId}/clients/${client.id}/report-address`,
    );
    expect(missing.status).toBe(404);
  });

  it('does not call a competitor address ours on the onboarding screen', async () => {
    const { agent, organizationId } = await createWorkspace();
    const client = await createClient(agent, organizationId);
    const addresses = await clientAddresses(client.id);
    const name = uniqueDomain('onboarding');
    const domain = await createDomain(agent, organizationId, client.id, name);

    await prisma.domain.update({
      where: { id: domain.id },
      data: {
        status: 'VERIFIED',
        verifiedAt: new Date(),
        dmarcPolicy: 'none',
        dmarcRecord: 'v=DMARC1; p=none; rua=mailto:reports@ag.dmarcian.com',
      },
    });

    const foreign = await agent.get(
      `/api/workspaces/${organizationId}/domains/${domain.id}/onboarding`,
    );
    const foreignStep = foreign.body.steps.find((step: { id: string }) => step.id === 'aggregate_reporting');

    expect(foreignStep.status).toBe('pending');
    expect(foreignStep.detail).toContain('ag.dmarcian.com');
    expect(foreignStep.detail).toContain(addresses.address);
    expect(foreignStep.detail).toContain('not to DMARC Harbor');

    await prisma.domain.update({
      where: { id: domain.id },
      data: { dmarcRecord: `v=DMARC1; p=none; rua=${addresses.uri}` },
    });
    const oursStep = (
      await agent.get(`/api/workspaces/${organizationId}/domains/${domain.id}/onboarding`)
    ).body.steps.find((step: { id: string }) => step.id === 'aggregate_reporting');

    expect(oursStep.status).toBe('done');
    expect(oursStep.detail).toMatch(/will be delivered/i);
  });
});

describe('scans keep the switch state current', () => {
  it('moves the row to CUT_OVER when the scan sees only our address', async () => {
    const fixture = await switchFixture(incumbentRecord());
    await prisma.domain.update({ where: { id: fixture.domainId }, data: { status: 'VERIFIED' } });
    const member = await prisma.member.findFirstOrThrow({
      where: { organizationId: fixture.organizationId },
    });
    const record = `v=DMARC1; p=none; rua=${fixture.addresses.uri}`;
    vi.mocked(scanDomain).mockResolvedValue({
      domain: fixture.name,
      scannedAt: new Date().toISOString(),
      status: 'healthy',
      score: 100,
      scoreBreakdown: { base: 100, final: 100, factors: [] },
      dmarc: {
        status: 'found',
        record,
        policy: 'none',
        tags: { v: 'DMARC1', p: 'none' },
        hasAggregateReports: true,
        hasForensicReports: false,
        aggregateMailtoTargets: [fixture.addresses.address],
        aggregateWebTargets: [],
      },
      spf: { status: 'missing', valid: false, lookupCount: 0 },
      dkim: { status: 'missing', selectors: [], checkedSelectors: [], records: {} },
      mx: { status: 'missing', records: [] },
      issues: [],
      recommendations: [],
    });

    const outcome = await runDomainScan({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      requestedById: member.userId,
    });

    expect(outcome.status).toBe('completed');
    const row = await prisma.domainSwitch.findUniqueOrThrow({
      where: { domainId: fixture.domainId },
    });
    expect(row.status).toBe('CUT_OVER');
    expect(row.cutOverAt).not.toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { organizationId: fixture.organizationId, action: 'DOMAIN_SWITCH_CUT_OVER' },
      }),
    ).toBe(1);
  });
});
