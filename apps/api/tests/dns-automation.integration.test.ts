import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { app } from '../src/index.js';
import { buildExportPayload } from '../src/services/export/export.service.js';
import { decryptSensitive } from '../src/services/privacy.service.js';
import { setCloudflareFetchForTests } from '../src/services/dns-automation/cloudflare.client.js';
import { setDnsPublishRefreshForTests } from '../src/services/dns-automation/publish.service.js';
import { grantPlan } from './helpers/plan.js';

let fixtureId = 0;
let recordSequence = 0;
const password = 'correct-horse-battery-staple';

interface StoredRecord {
  id: string;
  zoneId: string;
  type: 'TXT' | 'CNAME';
  name: string;
  content: string;
  ttl: number;
  comment: string | null;
}

const cloudflare = {
  zones: new Map<string, { id: string; name: string; account: string }>(),
  records: [] as StoredRecord[],
  validTokens: new Set<string>(),
};

function newToken(label = 'valid'): string {
  const token = ['cf', 'integration', label, String(++fixtureId), String(Date.now())].join('-');
  cloudflare.validTokens.add(token);
  return token;
}

function envelope(result: unknown) {
  return { success: true, errors: [], result };
}

function failure(status: number, code = 10000) {
  return new Response(JSON.stringify({ success: false, errors: [{ code, message: 'stub refused' }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function json(result: unknown): Response {
  return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function cloudflareFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const path = url.pathname.replace('/client/v4', '');
  const method = (init?.method ?? 'GET').toUpperCase();
  const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';

  if (!cloudflare.validTokens.has(token)) {
    return failure(401, 10000);
  }

  if (path === '/user/tokens/verify') {
    return json(envelope({ id: 'token-id', status: 'active' }));
  }

  if (path === '/zones' && method === 'GET') {
    const name = url.searchParams.get('name') ?? '';
    const zone = cloudflare.zones.get(name);
    return json(envelope(zone ? [{ id: zone.id, name: zone.name, status: 'active', account: { name: zone.account } }] : []));
  }

  const recordMatch = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path);
  if (recordMatch) {
    const [, zoneId, recordId] = recordMatch;
    if (method === 'GET') {
      const type = url.searchParams.get('type');
      const name = url.searchParams.get('name');
      const rows = cloudflare.records
        .filter((record) => record.zoneId === zoneId)
        .filter((record) => !type || record.type === type)
        .filter((record) => !name || record.name === name)
        .map((record) => ({ ...record, comment: record.comment ?? undefined }));
      return json(envelope(rows));
    }

    const body = init?.body ? (JSON.parse(String(init.body)) as Partial<StoredRecord>) : {};
    if (method === 'POST') {
      const created: StoredRecord = {
        id: `rec-${++recordSequence}`,
        zoneId: zoneId!,
        type: 'TXT',
        name: String(body.name),
        content: String(body.content),
        ttl: Number(body.ttl ?? 1),
        comment: typeof body.comment === 'string' ? body.comment : null,
      };
      cloudflare.records.push(created);
      return json(envelope(created));
    }
    const existing = cloudflare.records.find((record) => record.id === recordId && record.zoneId === zoneId);
    if (!existing) {
      return failure(404, 81044);
    }
    if (method === 'PUT') {
      existing.name = String(body.name ?? existing.name);
      existing.content = String(body.content ?? existing.content);
      existing.ttl = Number(body.ttl ?? existing.ttl);
      existing.comment = typeof body.comment === 'string' ? body.comment : existing.comment;
      return json(envelope(existing));
    }
    if (method === 'DELETE') {
      cloudflare.records = cloudflare.records.filter((record) => record.id !== existing.id);
      return json(envelope({ id: existing.id }));
    }
  }

  return failure(500);
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "dns_publication", "dns_provider_connection", "webhook_delivery", "webhook_endpoint", "idempotency_record", "api_key", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "dns_change", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setup(plan: 'MOORING' | 'FAIRWAY' | 'HARBOR' = 'HARBOR', label = 'dns-auto') {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `${label}-${Date.now()}-${fixtureId}@example.com`;
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'DNS Owner', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);

  const workspace = await agent.post('/api/workspaces').send({
    name: 'DNS Automation Agency',
    slug: `${label}-${Date.now()}-${fixtureId}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
  expect(workspace.status).toBe(201);
  const organizationId = workspace.body.id as string;
  if (plan !== 'MOORING') await grantPlan(organizationId, plan);

  const client = await agent.post(`/api/workspaces/${organizationId}/clients`).send({
    name: 'DNS Client',
    slug: `dns-client-${Date.now()}-${fixtureId}`,
  });
  expect(client.status).toBe(201);

  const domainName = `${label}-${fixtureId}.test`;
  const domain = await agent.post(`/api/workspaces/${organizationId}/clients/${client.body.id}/domains`).send({
    name: domainName,
  });
  expect(domain.status).toBe(201);

  await prisma.domain.update({
    where: { id: domain.body.id },
    data: {
      status: 'VERIFIED',
      verifiedAt: new Date(),
      dmarcPolicy: 'none',
      dmarcRecord: `v=DMARC1; p=none; rua=mailto:dmarc-reports@reports.dmarcharbor.test`,
    },
  });

  const zoneId = `zone-${fixtureId}`;
  cloudflare.zones.set(domainName, {
    id: zoneId,
    name: domainName,
    account: `Acme Cloudflare ${fixtureId}`,
  });

  const member = await prisma.member.findFirstOrThrow({ where: { organizationId } });
  return {
    agent,
    organizationId,
    clientId: client.body.id as string,
    domainId: domain.body.id as string,
    domainName,
    zoneId,
    userId: member.userId,
  };
}

async function addViewer(organizationId: string) {
  fixtureId += 1;
  const email = `dns-viewer-${Date.now()}-${fixtureId}@example.com`;
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-up/email').send({ name: 'DNS Viewer', email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  await prisma.member.create({
    data: { id: `viewer-${fixtureId}`, organizationId, userId: user.id, role: 'viewer', createdAt: new Date() },
  });
  return agent;
}

async function connect(
  agent: ReturnType<typeof request.agent>,
  organizationId: string,
  options: { token?: string; label?: string } = {},
) {
  const token = options.token ?? newToken();
  const response = await agent.post(`/api/workspaces/${organizationId}/dns-connections`).send({
    provider: 'CLOUDFLARE',
    token,
    label: options.label ?? 'Test Cloudflare',
  });
  expect(response.status).toBe(201);
  return { token, connection: response.body as { id: string; tokenHint: string } };
}

function previewBody(connectionId: string, record: Record<string, unknown>) {
  return { connectionId, record };
}

let refreshCalls: Array<{ domainId: string; kind: string }> = [];

beforeAll(() => {
  setCloudflareFetchForTests(cloudflareFetch as unknown as typeof fetch);
});

afterAll(() => {
  setCloudflareFetchForTests(null);
  setDnsPublishRefreshForTests(null);
});

beforeEach(async () => {
  await resetDatabase();
  cloudflare.zones.clear();
  cloudflare.records = [];
  cloudflare.validTokens.clear();
  recordSequence = 0;
  refreshCalls = [];
  setDnsPublishRefreshForTests(async (input) => {
    refreshCalls.push({ domainId: input.domainId, kind: input.kind });
  });
});

describe('Cloudflare DNS publishing', () => {
  it('gates connection creation on Fairway but keeps listing and removal available', async () => {
    const fairway = await setup('FAIRWAY');
    const created = await connect(fairway.agent, fairway.organizationId);

    await grantPlan(fairway.organizationId, 'MOORING');
    const listed = await fairway.agent.get(`/api/workspaces/${fairway.organizationId}/dns-connections`);
    expect(listed.status).toBe(200);
    expect(listed.body.connections[0]).toMatchObject({ id: created.connection.id, paused: true });

    const refused = await fairway.agent.post(`/api/workspaces/${fairway.organizationId}/dns-connections`).send({
      provider: 'CLOUDFLARE',
      token: newToken(),
    });
    expect(refused.status).toBe(402);
    expect(refused.body.error.feature).toBe('dns.automation');

    const removed = await fairway.agent.delete(
      `/api/workspaces/${fairway.organizationId}/dns-connections/${created.connection.id}`,
    );
    expect(removed.status).toBe(204);

    const harbor = await setup('HARBOR');
    await connect(harbor.agent, harbor.organizationId);
  });

  it('refuses a Global API Key and an inactive token', async () => {
    const ctx = await setup('HARBOR');

    const global = await ctx.agent.post(`/api/workspaces/${ctx.organizationId}/dns-connections`).send({
      provider: 'CLOUDFLARE',
      token: 'a'.repeat(37),
    });
    expect(global.status).toBe(400);
    expect(global.body.error.message).toContain('Global API Key');

    const inactive = await ctx.agent.post(`/api/workspaces/${ctx.organizationId}/dns-connections`).send({
      provider: 'CLOUDFLARE',
      token: ['cf', 'inactive', String(Date.now())].join('-'),
    });
    expect(inactive.status).toBe(400);
    expect(inactive.body.error.code).toBe('TOKEN_INVALID');
  });

  it('stores the token encrypted and never returns or exports it', async () => {
    const ctx = await setup('HARBOR');
    const { token, connection } = await connect(ctx.agent, ctx.organizationId, { label: 'Acme production' });

    expect(JSON.stringify(connection)).not.toContain(token);
    expect(connection.tokenHint).toBe(token.slice(-4));

    const stored = await prisma.dnsProviderConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(stored.encryptedToken).not.toContain(token);
    expect(decryptSensitive(stored.encryptedToken)).toBe(token);

    const listed = await ctx.agent.get(`/api/workspaces/${ctx.organizationId}/dns-connections`);
    expect(JSON.stringify(listed.body)).not.toContain(token);

    const audit = await prisma.auditLog.findMany({ where: { organizationId: ctx.organizationId } });
    expect(JSON.stringify(audit)).not.toContain(token);

    const exported = await buildExportPayload({
      organizationId: ctx.organizationId,
      scope: 'ORGANIZATION',
      format: 'JSON',
      scopeLabel: 'workspace',
    });
    expect(JSON.stringify(exported.data)).not.toContain(token);
    expect(JSON.stringify(exported.data)).not.toContain(stored.encryptedToken);
    expect(exported.data.dnsConnections).toHaveLength(1);
  });

  it('caps a workspace at five connections', async () => {
    const ctx = await setup('HARBOR');
    for (let index = 0; index < 5; index += 1) {
      await connect(ctx.agent, ctx.organizationId, { label: `Account ${index + 1}` });
    }

    const sixth = await ctx.agent.post(`/api/workspaces/${ctx.organizationId}/dns-connections`).send({
      provider: 'CLOUDFLARE',
      token: newToken(),
      label: 'Account 6',
    });
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.code).toBe('CONNECTION_LIMIT');
  });

  it('previews and creates exactly the server-generated verification record', async () => {
    const ctx = await setup('HARBOR');
    const { connection } = await connect(ctx.agent, ctx.organizationId);

    const preview = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish/preview`)
      .send(previewBody(connection.id, { kind: 'verification', value: 'v=DMARC1; p=reject' }));
    expect(preview.status).toBe(200);
    expect(preview.body.action).toBe('create');
    expect(preview.body.recordName).toBe(`_dmarc-harbor-verification.${ctx.domainName}`);
    expect(preview.body.proposedValue).toMatch(/^dmarc-harbor-verification=/);
    expect(preview.body.proposedValue).not.toContain('p=reject');
    expect(preview.body.currentFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const published = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish`)
      .send({
        connectionId: connection.id,
        record: { kind: 'verification' },
        expectedFingerprint: preview.body.currentFingerprint,
      });
    expect(published.status).toBe(200);
    expect(published.body.action).toBe('create');
    expect(published.body.message).toContain('DNS can take a few minutes');
    expect(published.body.publication.recordName).toBe(preview.body.recordName);
    expect(published.body.publication.previousValue).toBeNull();

    const stored = cloudflare.records.find((record) => record.name === preview.body.recordName);
    expect(stored?.content).toBe(preview.body.proposedValue);

    const again = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish/preview`)
      .send(previewBody(connection.id, { kind: 'verification' }));
    expect(again.body.action).toBe('unchanged');

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: ctx.organizationId, action: 'DNS_RECORD_PUBLISHED' },
    });
    expect(audit.detail).toMatchObject({ kind: 'verification', action: 'create' });
    expect(JSON.stringify(audit)).not.toContain(connection.tokenHint);
  });

  it('updates only the DMARC record and leaves unrelated TXT records alone', async () => {
    const ctx = await setup('HARBOR');
    const { connection } = await connect(ctx.agent, ctx.organizationId);
    const name = `_dmarc.${ctx.domainName}`;
    const unrelated: StoredRecord = {
      id: 'unrelated-1',
      zoneId: ctx.zoneId,
      type: 'TXT',
      name,
      content: 'google-site-verification=keep-me',
      ttl: 3600,
      comment: 'leave alone',
    };
    const existing: StoredRecord = {
      id: 'dmarc-old',
      zoneId: ctx.zoneId,
      type: 'TXT',
      name,
      content: 'v=DMARC1; p=reject; rua=mailto:old@example.test',
      ttl: 120,
      comment: 'DMARC',
    };
    cloudflare.records.push(unrelated, existing);

    const preview = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish/preview`)
      .send(previewBody(connection.id, { kind: 'dmarc_suggested' }));
    expect(preview.status).toBe(200);
    expect(preview.body.action).toBe('update');
    expect(preview.body.currentValues).toContain('google-site-verification=keep-me');

    const published = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish`)
      .send({
        connectionId: connection.id,
        record: { kind: 'dmarc_suggested' },
        expectedFingerprint: preview.body.currentFingerprint,
      });
    expect(published.status).toBe(200);
    expect(published.body.action).toBe('update');
    expect(published.body.publication.previousValue).toBe('v=DMARC1; p=reject; rua=mailto:old@example.test');

    expect(cloudflare.records.find((record) => record.id === 'dmarc-old')?.content).toBe(preview.body.proposedValue);
    // Over an existing record the starter only adds our address: the policy
    // and the previous provider's address stay exactly as published.
    expect(preview.body.proposedValue).toMatch(/^v=DMARC1; p=reject; rua=mailto:dmarc-reports/);
    expect(preview.body.proposedValue).toContain('mailto:old@example.test');
    expect(preview.body.proposedValue).not.toContain('p=none');
    expect(cloudflare.records.find((record) => record.id === 'unrelated-1')).toMatchObject({
      content: 'google-site-verification=keep-me',
      comment: 'leave alone',
    });

    const pct = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish/preview`)
      .send(previewBody(connection.id, { kind: 'dmarc_policy', policy: 'none', pct: '5' }));
    expect(pct.status).toBe(400);
  });

  it('refuses a publish when Cloudflare changed after the preview', async () => {
    const ctx = await setup('HARBOR');
    const { connection } = await connect(ctx.agent, ctx.organizationId);

    const preview = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish/preview`)
      .send(previewBody(connection.id, { kind: 'verification' }));
    expect(preview.body.action).toBe('create');

    cloudflare.records.push({
      id: 'changed-elsewhere',
      zoneId: ctx.zoneId,
      type: 'TXT',
      name: preview.body.recordName,
      content: 'dmarc-harbor-verification=someone-else',
      ttl: 1,
      comment: null,
    });

    const conflict = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish`)
      .send({
        connectionId: connection.id,
        record: { kind: 'verification' },
        expectedFingerprint: preview.body.currentFingerprint,
      });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('DNS_CHANGED');
    expect(conflict.body.preview.currentValues).toContain('dmarc-harbor-verification=someone-else');

    expect(await prisma.dnsPublication.count({ where: { organizationId: ctx.organizationId } })).toBe(0);
  });

  it('enforces roles and tenancy', async () => {
    const ctx = await setup('HARBOR');
    const { connection } = await connect(ctx.agent, ctx.organizationId);
    const viewer = await addViewer(ctx.organizationId);

    const denied = await viewer
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish/preview`)
      .send(previewBody(connection.id, { kind: 'verification' }));
    expect(denied.status).toBe(403);

    const other = await setup('HARBOR', 'dns-other');
    const otherConnection = await connect(other.agent, other.organizationId);

    const foreignConnection = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish/preview`)
      .send(previewBody(otherConnection.connection.id, { kind: 'verification' }));
    expect(foreignConnection.status).toBe(404);

    const foreignDomain = await other.agent
      .post(`/api/workspaces/${other.organizationId}/domains/${ctx.domainId}/dns-publish/preview`)
      .send(previewBody(otherConnection.connection.id, { kind: 'verification' }));
    expect(foreignDomain.status).toBe(404);
  });

  it('refreshes after publishing without failing when the refresh fails', async () => {
    const ctx = await setup('HARBOR');
    const { connection } = await connect(ctx.agent, ctx.organizationId);

    const preview = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish/preview`)
      .send(previewBody(connection.id, { kind: 'verification' }));
    const published = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish`)
      .send({
        connectionId: connection.id,
        record: { kind: 'verification' },
        expectedFingerprint: preview.body.currentFingerprint,
      });
    expect(published.status).toBe(200);
    expect(refreshCalls).toContainEqual({ domainId: ctx.domainId, kind: 'verification' });

    setDnsPublishRefreshForTests(async () => {
      throw new Error('resolver unavailable');
    });
    const dmarc = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish/preview`)
      .send(previewBody(connection.id, { kind: 'dmarc_suggested' }));
    const stillPublished = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish`)
      .send({
        connectionId: connection.id,
        record: { kind: 'dmarc_suggested' },
        expectedFingerprint: dmarc.body.currentFingerprint,
      });
    expect(stillPublished.status).toBe(200);
  });

  it('restores an update, deletes a record it created, and only once', async () => {
    const ctx = await setup('HARBOR');
    const { connection } = await connect(ctx.agent, ctx.organizationId);
    const name = `_dmarc.${ctx.domainName}`;
    cloudflare.records.push({
      id: 'dmarc-restore',
      zoneId: ctx.zoneId,
      type: 'TXT',
      name,
      content: 'v=DMARC1; p=quarantine',
      ttl: 300,
      comment: 'existing',
    });

    const preview = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish/preview`)
      .send(previewBody(connection.id, { kind: 'dmarc_suggested' }));
    const published = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish`)
      .send({
        connectionId: connection.id,
        record: { kind: 'dmarc_suggested' },
        expectedFingerprint: preview.body.currentFingerprint,
      });
    expect(published.status).toBe(200);

    const restored = await ctx.agent.post(
      `/api/workspaces/${ctx.organizationId}/dns-publications/${published.body.publication.id}/restore`,
    );
    expect(restored.status).toBe(200);
    expect(cloudflare.records.find((record) => record.id === 'dmarc-restore')?.content).toBe('v=DMARC1; p=quarantine');

    const again = await ctx.agent.post(
      `/api/workspaces/${ctx.organizationId}/dns-publications/${published.body.publication.id}/restore`,
    );
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PUBLICATION_ALREADY_RESTORED');

    const verification = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish/preview`)
      .send(previewBody(connection.id, { kind: 'verification' }));
    const created = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish`)
      .send({
        connectionId: connection.id,
        record: { kind: 'verification' },
        expectedFingerprint: verification.body.currentFingerprint,
      });
    expect(created.status).toBe(200);

    const removed = await ctx.agent.post(
      `/api/workspaces/${ctx.organizationId}/dns-publications/${created.body.publication.id}/restore`,
    );
    expect(removed.status).toBe(200);
    expect(cloudflare.records.some((record) => record.name === verification.body.recordName)).toBe(false);
  });

  it('refuses restore after seven days or when the record changed', async () => {
    const ctx = await setup('HARBOR');
    const { connection } = await connect(ctx.agent, ctx.organizationId);
    const name = `_dmarc.${ctx.domainName}`;
    cloudflare.records.push({
      id: 'dmarc-window',
      zoneId: ctx.zoneId,
      type: 'TXT',
      name,
      content: 'v=DMARC1; p=none',
      ttl: 1,
      comment: null,
    });

    const firstPreview = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish/preview`)
      .send(previewBody(connection.id, { kind: 'dmarc_suggested' }));
    const first = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish`)
      .send({
        connectionId: connection.id,
        record: { kind: 'dmarc_suggested' },
        expectedFingerprint: firstPreview.body.currentFingerprint,
      });
    await prisma.dnsPublication.update({
      where: { id: first.body.publication.id },
      data: { publishedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    });
    const expired = await ctx.agent.post(
      `/api/workspaces/${ctx.organizationId}/dns-publications/${first.body.publication.id}/restore`,
    );
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe('RESTORE_EXPIRED');

    const secondPreview = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish/preview`)
      .send(previewBody(connection.id, { kind: 'dmarc_policy', policy: 'quarantine' }));
    const second = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish`)
      .send({
        connectionId: connection.id,
        record: { kind: 'dmarc_policy', policy: 'quarantine' },
        expectedFingerprint: secondPreview.body.currentFingerprint,
      });
    expect(second.status).toBe(200);

    const changed = cloudflare.records.find((record) => record.id === 'dmarc-window');
    if (changed) changed.content = 'v=DMARC1; p=reject';
    const refused = await ctx.agent.post(
      `/api/workspaces/${ctx.organizationId}/dns-publications/${second.body.publication.id}/restore`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('RECORD_CHANGED');
  });

  it('keeps publication history when the connection is deleted', async () => {
    const ctx = await setup('HARBOR');
    const { connection } = await connect(ctx.agent, ctx.organizationId);

    const preview = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish/preview`)
      .send(previewBody(connection.id, { kind: 'verification' }));
    const published = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish`)
      .send({
        connectionId: connection.id,
        record: { kind: 'verification' },
        expectedFingerprint: preview.body.currentFingerprint,
      });
    expect(published.status).toBe(200);

    await ctx.agent.delete(`/api/workspaces/${ctx.organizationId}/dns-connections/${connection.id}`);
    const stored = await prisma.dnsPublication.findUniqueOrThrow({ where: { id: published.body.publication.id } });
    expect(stored.connectionId).toBeNull();

    const restore = await ctx.agent.post(
      `/api/workspaces/${ctx.organizationId}/dns-publications/${published.body.publication.id}/restore`,
    );
    expect(restore.status).toBe(409);
    expect(restore.body.error.code).toBe('CONNECTION_REMOVED');
  });

  it('rate limits publishes per workspace', async () => {
    const ctx = await setup('HARBOR');
    const { connection } = await connect(ctx.agent, ctx.organizationId);

    const firstPreview = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish/preview`)
      .send(previewBody(connection.id, { kind: 'verification' }));
    const first = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish`)
      .send({
        connectionId: connection.id,
        record: { kind: 'verification' },
        expectedFingerprint: firstPreview.body.currentFingerprint,
      });
    expect(first.status).toBe(200);

    const stable = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish/preview`)
      .send(previewBody(connection.id, { kind: 'verification' }));
    for (let index = 1; index < 30; index += 1) {
      const response = await ctx.agent
        .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish`)
        .send({
          connectionId: connection.id,
          record: { kind: 'verification' },
          expectedFingerprint: stable.body.currentFingerprint,
        });
      expect(response.status).toBe(200);
    }

    const limited = await ctx.agent
      .post(`/api/workspaces/${ctx.organizationId}/domains/${ctx.domainId}/dns-publish`)
      .send({
        connectionId: connection.id,
        record: { kind: 'verification' },
        expectedFingerprint: stable.body.currentFingerprint,
      });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });
});
