import request from 'supertest';
import type { PlanTier } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index.js';
import { prisma } from '../src/database/prisma.js';
import { env } from '../src/config/env.js';
import { saveStoredPlan } from '../src/billing/plans.js';
import { mockProvider } from '../src/billing/registry.js';
import { MockBillingProvider } from '../src/billing/mock-provider.js';
import { applyBillingEvent } from '../src/billing/subscription-state.js';
import type { BillingInterval } from '../src/billing/provider.js';
import {
  catalogOrder,
  isUnlimited,
  planCatalog,
  planOrder,
  type BillingCurrency,
  type PlanDefinition,
} from '../src/services/entitlements/plan-catalog.js';
import { fleetAlternativeFor, requiredPlanFor } from '../src/services/entitlements/entitlement.service.js';
import { createApiKey } from '../src/services/api-key.service.js';
import { encryptSensitive } from '../src/services/privacy.service.js';
import { setProspectScannerForTests } from '../src/services/prospect/prospect-report.service.js';
import {
  resetHostedDnsProviderForTests,
  setHostedDnsProviderForTests,
  type HostedDnsProvider,
  type HostedTxt,
} from '../src/services/hosted-dns/provider.js';
import type { ScanResult } from '../src/models/scan.model.js';
import { grantPlan } from './helpers/plan.js';
import { gatedFeatures, type GatedFeature } from './helpers/plan-limits.js';

/**
 * Every plan limit, checked on every plan, from the catalogue.
 *
 * Nothing here names a plan's numbers or features directly. Each expectation is
 * read from `planCatalog`, so changing the catalogue changes what this suite
 * expects, and a limit or a gate that the catalogue promises but the code does
 * not keep fails here rather than in a customer's account.
 *
 * Four parts:
 *  - feature gates: one probe per gated entitlement, run on each plan. Where the
 *    plan withholds the feature the answer is 402 FEATURE_NOT_IN_PLAN naming the
 *    feature and the plan that grants it; where it grants it, anything but a 402
 *    or a server error. Removing or reading something kept must work everywhere.
 *  - quotas: clients, active domains, team members, workspaces and prospect
 *    reports a month, each filled to its limit and pushed one over, through the
 *    session routes and /api/v1 where both exist.
 *  - downgrades: the self-serve plan change refuses a move the account does not
 *    fit, and a staff downgrade keeps what exists but refuses more.
 *  - safety: a refusal never answers with another workspace's data.
 *
 * Rows are inserted directly where only the count matters, with the columns
 * real creation writes, so the counts the code reads include them. Network is
 * never touched: the prospect scanner, the hosted DNS provider and `fetch` are
 * replaced, and every other probe is a request that is answered before any
 * outside call. Sample names are invented; domains are `.example`.
 */

// The payment provider is reached only after the downgrade guard passes, and a
// real Razorpay call with no credentials answers 503. Swapped at the registry
// seam, as in billing-plan-guard.integration.test.ts, so the guard runs against
// the real database, entitlements and controller.
vi.mock('../src/billing/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/billing/registry.js')>();
  return {
    ...actual,
    resolveProviderForCheckout: () => actual.mockProvider(),
  };
});

type Agent = ReturnType<typeof request.agent>;
type HttpResponse = request.Response;

const password = 'correct-horse-battery-staple';
const stamp = Date.now().toString(36);
let sequence = 0;
/** A token unique within this run, safe in slugs, emails and domain labels. */
const unique = (): string => {
  sequence += 1;
  return `${stamp}-${sequence}`;
};

/**
 * Assembled from parts, as the Slack and Teams suites do. A literal webhook
 * address is indistinguishable from a live credential to a secret scanner.
 */
const SLACK_URL = `https://${'hooks.slack.com'}/services/T00000000/B00000000/${'abcdefghijkl'}${'mnopqrstuvwx'}`;
const TEAMS_URL = `https://${'prod-00.westus.logic.azure.com'}:443/workflows/0000/triggers/manual/paths/invoke?api-version=2016-06-01&sig=${'TESTSIG'}${'NOTREAL'}`;

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "rate_limit_bucket", "billing_plan", "billing_event", "idempotency_record", "email_delivery", "audit_log", "prospect_report", "slack_destination", "teams_destination", "report_inbox", "report_digest", "report_share", "alert_rule", "client_portal_access", "webhook_delivery", "webhook_endpoint", "api_key", "psa_connection", "dns_provider_connection", "sso_connection", "entitlement_override", "subscription", "domain", "client", "organization", invitation, member, session, account, verification, "two_factor", "user" CASCADE',
  );
}

/**
 * Every request here comes from 127.0.0.1, and the signed-in backstop limiter
 * (600 a minute per address) is not raised for the integration run. Cleared
 * between plans so a limiter can never be the reason a probe fails.
 */
async function resetRateLimits(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "rate_limit_bucket"');
}

async function signedIn(label: string): Promise<{ agent: Agent; userId: string; email: string }> {
  const email = `${label}-${unique()}@wistholm.example`;
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/sign-up/email').send({ name: label, email, password })).status).toBe(200);
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  expect((await agent.post('/api/auth/sign-in/email').send({ email, password })).status).toBe(200);
  const userId = (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;
  return { agent, userId, email };
}

function createWorkspace(agent: Agent, name: string) {
  return agent.post('/api/workspaces').send({
    name,
    slug: `ws-${unique()}`,
    tosAccepted: true,
    dpaHasRead: true,
    dpaConfirmsAuthority: true,
  });
}

async function ownerWithWorkspace(label: string, name: string) {
  const owner = await signedIn(label);
  const created = await createWorkspace(owner.agent, name);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { ...owner, organizationId: created.body.id as string };
}

/** A recorded scan, so a prospect report never reads real DNS. */
function recordedScan(domain: string): ScanResult {
  return {
    domain,
    scannedAt: new Date().toISOString(),
    status: 'needs_attention',
    score: 41,
    scoreBreakdown: { base: 100, final: 41, factors: [] },
    dmarc: {
      status: 'found',
      record: 'v=DMARC1; p=none',
      policy: 'none',
      tags: { p: 'none' },
      hasAggregateReports: false,
      hasForensicReports: false,
      aggregateMailtoTargets: [],
      aggregateWebTargets: [],
    },
    spf: { status: 'found', record: 'v=spf1 include:_spf.google.com ~all', valid: true, lookupCount: 3 },
    dkim: { status: 'missing', selectors: [], checkedSelectors: ['google', 'selector1', 'default'], records: {} },
    mx: { status: 'found', records: [{ exchange: 'aspmx.l.google.com', priority: 1 }] },
    issues: [],
    recommendations: [],
  };
}

/**
 * A hosted zone that keeps its records in memory.
 *
 * Hosted BIMI answers 503 on a deployment with no hosted zone before it reaches
 * anything else, so without one its probe would only ever see the deployment
 * refusal. Nothing here reaches Cloudflare.
 */
function memoryZone(): HostedDnsProvider {
  const records = new Map<string, HostedTxt>();
  return {
    zone: 'hosted.wistholm.example',
    async get(name) {
      return [...records.values()].filter((record) => record.name === name);
    },
    async create(name, content, comment) {
      const record = { id: `txt-${unique()}`, name, content, comment };
      records.set(record.id, record);
      return record;
    },
    async update(record, content) {
      const updated = { ...record, content };
      records.set(record.id, updated);
      return updated;
    },
    async remove(recordId) {
      records.delete(recordId);
    },
    async *listAll() {
      yield* [...records.values()];
    },
  };
}

/** Runs one request with `fetch` answering 202, so the Teams test posts nowhere. */
async function withStubbedFetch(call: () => PromiseLike<HttpResponse>): Promise<HttpResponse> {
  vi.stubGlobal('fetch', async () => new globalThis.Response('', { status: 202 }));
  try {
    return await call();
  } finally {
    vi.unstubAllGlobals();
  }
}

/**
 * The plan to move to for more of a limit, read from the catalogue: the next
 * rung of the ladder, and only when it actually allows more. Fleet is not a
 * rung, so it has no next plan.
 */
function upgradeFor(tier: PlanTier, limitOf: (plan: PlanDefinition) => number): PlanTier | null {
  const index = planOrder.indexOf(tier);
  const next = index >= 0 ? planOrder[index + 1] : undefined;
  return next && limitOf(planCatalog[next]) > limitOf(planCatalog[tier]) ? next : null;
}

/** 1st, 2nd, 3rd, 20th: for test names read in the CI log. */
function ordinal(value: number): string {
  const tens = value % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[value % 10] ?? 'th';
  return `${value}${suffix}`;
}

function describeResponse(response: HttpResponse): string {
  const sent = (response as unknown as { request?: { method?: string; url?: string } }).request;
  return `${sent?.method ?? ''} ${sent?.url ?? ''} answered ${response.status}: ${JSON.stringify(response.body).slice(0, 400)}`;
}

/**
 * A plan-limit refusal: 402, the code, the counts, and the way past it.
 *
 * `flat` is Better Auth's shape, which writes the fields beside the message
 * rather than under `error`.
 */
function expectLimitRefusal(
  response: HttpResponse,
  expected: { code: string; quota?: string; used: number; limit: number; upgradeTo: PlanTier | null; flat?: boolean },
): void {
  const where = describeResponse(response);
  expect(response.status, where).toBe(402);
  const error = (expected.flat ? response.body : response.body?.error) ?? {};
  expect(error.code, where).toBe(expected.code);
  if (expected.quota !== undefined) {
    expect(error.quota, where).toBe(expected.quota);
  }
  expect(error.used, where).toBe(expected.used);
  expect(error.limit, where).toBe(expected.limit);
  expect(error.upgradeTo ?? null, where).toBe(expected.upgradeTo);
  const message = String(error.message).toLowerCase();
  if (expected.upgradeTo) {
    expect(message, where).toContain(`upgrade to ${planCatalog[expected.upgradeTo].label.toLowerCase()}`);
  } else if (error.plan && error.quota && fleetAlternativeFor(error.plan as PlanTier, error.quota)) {
    // Admiralty's clients and domains: Fleet goes further, so the way past
    // the limit is Fleet, not "contact us".
    expect(message, where).toContain('move to fleet');
  } else {
    expect(message, where).toContain('contact us');
  }
}

// ─── The workspaces the feature probes run in ───────────────────────────────

interface Fixture {
  tier: PlanTier;
  agent: Agent;
  userId: string;
  email: string;
  organizationId: string;
  workspaceName: string;
  clientId: string;
  clientName: string;
  domainId: string;
  domainName: string;
  /** A digest the workspace already has, for the edit, send and removal checks. */
  digestId: string;
  /** Minted while the workspace was on Harbor, before its plan was set. */
  apiKey: string;
}

const fixtures = {} as Record<PlanTier, Fixture>;

/**
 * One workspace per plan, reused by every probe on that plan.
 *
 * It is put on Harbor first and an API key is minted through the route, then
 * moved to its own plan: a key issued on a plan with the API must stop working
 * the moment the plan no longer includes it, which is the case a check made
 * only at issue would miss.
 */
async function tierFixture(tier: PlanTier): Promise<Fixture> {
  const label = planCatalog[tier].label;
  const workspaceName = `Wistholm IT ${label} sample`;
  const owner = await ownerWithWorkspace(`gate-${tier.toLowerCase()}`, workspaceName);
  const clientName = `Pellowyn Dental ${label} sample`;
  const client = await prisma.client.create({
    data: { organizationId: owner.organizationId, name: clientName, slug: `pellowyn-${unique()}` },
  });
  const domainName = `pellowyn-${tier.toLowerCase()}-${unique()}.example`;
  const domain = await prisma.domain.create({
    data: {
      clientId: client.id,
      name: domainName,
      slug: `dom-${unique()}`,
      status: 'VERIFIED',
      verifiedAt: new Date(),
      dmarcPolicy: 'none',
      dmarcRecord: 'v=DMARC1; p=none',
    },
  });
  const digest = await prisma.reportDigest.create({
    data: {
      organizationId: owner.organizationId,
      domainId: domain.id,
      createdById: owner.userId,
      frequency: 'WEEKLY',
      recipientEmails: ['office@pellowyn.example'],
      enabled: true,
    },
  });

  await grantPlan(owner.organizationId, 'HARBOR');
  const minted = await owner.agent
    .post(`/api/workspaces/${owner.organizationId}/api-keys`)
    .send({ name: 'Plan limits probe', scopes: ['read', 'write'] });
  expect(minted.status, describeResponse(minted)).toBe(201);
  await grantPlan(owner.organizationId, tier);

  return {
    tier,
    agent: owner.agent,
    userId: owner.userId,
    email: owner.email,
    organizationId: owner.organizationId,
    workspaceName,
    clientId: client.id,
    clientName,
    domainId: domain.id,
    domainName,
    digestId: digest.id,
    apiKey: minted.body.key as string,
  };
}

/** Everything that identifies a workspace, for the "names nothing of it" checks. */
function identifiersOf(fixture: Fixture): string[] {
  return [
    fixture.organizationId,
    fixture.workspaceName,
    fixture.clientId,
    fixture.clientName,
    fixture.domainId,
    fixture.domainName,
    fixture.email,
  ];
}

function expectNothingOf(owner: Fixture, response: HttpResponse): void {
  const text = `${JSON.stringify(response.body ?? null)} ${response.text ?? ''}`;
  for (const identifier of identifiersOf(owner)) {
    expect(text.includes(identifier), `${describeResponse(response)} names ${identifier} of ${owner.tier}`).toBe(false);
  }
}

// ─── The probe table ────────────────────────────────────────────────────────

/**
 * How to reach one paid feature.
 *
 * `request` is the gated create, enable or send, with the smallest body that
 * passes validation. Where the happy path would call something outside (a DNS
 * provider, an identity provider, a PSA, a bucket), the probe sends a body or an
 * id that the route answers with a 400 or 404 after the gate and before any
 * call: that still shows the gate let it through. `also` is more routes behind
 * the same key, checked the same way. `removal` is reading, pausing or removing
 * what a workspace kept from an earlier plan, which must work on every plan.
 */
interface Probe {
  setup?: (ctx: Fixture) => Promise<void>;
  request: (ctx: Fixture) => PromiseLike<HttpResponse>;
  also?: (ctx: Fixture) => Promise<HttpResponse[]>;
  removal?: (ctx: Fixture) => Promise<HttpResponse[]>;
}

const base = (ctx: Fixture) => `/api/workspaces/${ctx.organizationId}`;

const probes = {
  'reports.forensic': {
    request: (ctx) => ctx.agent.get(`${base(ctx)}/domains/${ctx.domainId}/forensics`),
  },
  'reports.forensicNamed': {
    request: (ctx) =>
      ctx.agent.patch(`${base(ctx)}/domains/${ctx.domainId}/forensics/identities`).send({ retainForensicPii: false }),
  },
  'alerts.email': {
    setup: async (ctx) => {
      // A Slack and a Teams channel kept from an earlier plan, so pausing and
      // removing are checked on the plans that can no longer add one.
      // A workspace may hold several channels now, so "one kept" is created only
      // when none is there yet.
      if (!(await prisma.slackDestination.findFirst({ where: { organizationId: ctx.organizationId } }))) {
        await prisma.slackDestination.create({
          data: { organizationId: ctx.organizationId, encryptedWebhookUrl: encryptSensitive(SLACK_URL), channelLabel: 'dmarc-alerts' },
        });
      }
      if (!(await prisma.teamsDestination.findFirst({ where: { organizationId: ctx.organizationId } }))) {
        await prisma.teamsDestination.create({
          data: { organizationId: ctx.organizationId, encryptedWebhookUrl: encryptSensitive(TEAMS_URL), channelLabel: 'Alerts' },
        });
      }
    },
    request: (ctx) =>
      ctx.agent.post(`${base(ctx)}/alert-rules`).send({
        name: 'Failure rate over ten percent',
        metric: 'FAILURE_RATE',
        operator: 'GREATER_THAN',
        threshold: 10,
        domainId: ctx.domainId,
        recipientUserIds: [ctx.userId],
      }),
    // One key covers every alert channel: saving one, switching it back on and
    // the Teams test message are the paid part.
    also: async (ctx) => [
      await ctx.agent.put(`${base(ctx)}/slack-destination`).send({ webhookUrl: SLACK_URL, channelLabel: 'dmarc-alerts' }),
      await ctx.agent.patch(`${base(ctx)}/slack-destination`).send({ enabled: true }),
      await ctx.agent.put(`${base(ctx)}/teams-destination`).send({ webhookUrl: TEAMS_URL, channelLabel: 'Alerts' }),
      await ctx.agent.patch(`${base(ctx)}/teams-destination`).send({ enabled: true }),
      await withStubbedFetch(() => ctx.agent.post(`${base(ctx)}/teams-destination/test`)),
    ],
    removal: async (ctx) => [
      await ctx.agent.get(`${base(ctx)}/slack-destination`),
      await ctx.agent.patch(`${base(ctx)}/slack-destination`).send({ enabled: false }),
      await ctx.agent.delete(`${base(ctx)}/slack-destination`),
      await ctx.agent.get(`${base(ctx)}/teams-destination`),
      await ctx.agent.patch(`${base(ctx)}/teams-destination`).send({ enabled: false }),
      await ctx.agent.delete(`${base(ctx)}/teams-destination`),
    ],
  },
  'alerts.spoofing': {
    request: (ctx) =>
      ctx.agent.post(`${base(ctx)}/alert-rules`).send({
        name: 'New unauthenticated source',
        metric: 'NEW_UNAUTHENTICATED_SOURCE',
        operator: 'GREATER_THAN',
        threshold: 1,
        domainId: ctx.domainId,
        recipientUserIds: [ctx.userId],
      }),
  },
  'sharing.links': {
    request: (ctx) => ctx.agent.post(`${base(ctx)}/report-shares`).send({ domainId: ctx.domainId }),
    removal: async (ctx) => [await ctx.agent.get(`${base(ctx)}/report-shares`)],
  },
  digests: {
    request: (ctx) =>
      ctx.agent.post(`${base(ctx)}/report-digests`).send({
        domainId: ctx.domainId,
        frequency: 'WEEKLY',
        sendHourUtc: 9,
        recipientEmails: ['office@pellowyn.example'],
      }),
    also: async (ctx) => [
      await ctx.agent.patch(`${base(ctx)}/report-digests/${ctx.digestId}`).send({ frequency: 'MONTHLY', dayOfMonth: 15 }),
      await ctx.agent.patch(`${base(ctx)}/report-digests/${ctx.digestId}`).send({ enabled: true }),
      await ctx.agent.post(`${base(ctx)}/report-digests/${ctx.digestId}/send`),
    ],
    removal: async (ctx) => [
      await ctx.agent.get(`${base(ctx)}/report-digests`),
      await ctx.agent.patch(`${base(ctx)}/report-digests/${ctx.digestId}`).send({ enabled: false }),
      await ctx.agent.delete(`${base(ctx)}/report-digests/${ctx.digestId}`),
    ],
  },
  'portal.client': {
    request: (ctx) =>
      ctx.agent.post(`${base(ctx)}/clients/${ctx.clientId}/portal-access`).send({ email: `office-${unique()}@pellowyn.example` }),
    // Asking a client to approve a stricter policy runs through the portal too.
    also: async (ctx) => [await ctx.agent.post(`${base(ctx)}/domains/${ctx.domainId}/policy-proposals`).send({})],
    removal: async (ctx) => [await ctx.agent.get(`${base(ctx)}/portal-access`)],
  },
  'branding.whitelabel': {
    request: (ctx) => ctx.agent.patch(`${base(ctx)}/branding`).send({ primaryColor: '#0f766e' }),
    removal: async (ctx) => [await ctx.agent.get(`${base(ctx)}/branding`)],
  },
  'api.access': {
    request: (ctx) => ctx.agent.post(`${base(ctx)}/api-keys`).send({ name: `Probe key ${unique()}`, scopes: ['read'] }),
    // The key minted on Harbor, used after the plan moved.
    also: async (ctx) => [await request(app).get('/api/v1/clients').set('Authorization', `Bearer ${ctx.apiKey}`)],
    removal: async (ctx) => [await ctx.agent.get(`${base(ctx)}/api-keys`)],
  },
  'auth.sso': {
    // An empty body is refused by validation once the plan allows it, so no
    // identity provider is contacted.
    request: (ctx) => ctx.agent.post(`${base(ctx)}/sso-connections`).send({}),
    also: async (ctx) => [await ctx.agent.patch(`${base(ctx)}/sso-connections/not-a-connection`).send({ enabled: false })],
  },
  'trust.center': {
    request: (ctx) => ctx.agent.post(`${base(ctx)}/clients/${ctx.clientId}/trust-center`),
    removal: async (ctx) => [
      await ctx.agent.get(`${base(ctx)}/clients/${ctx.clientId}/trust-center`),
      await ctx.agent.delete(`${base(ctx)}/clients/${ctx.clientId}/trust-center`),
    ],
  },
  'reports.compliancePack': {
    request: (ctx) => ctx.agent.get(`${base(ctx)}/clients/${ctx.clientId}/monthly-reports`),
    // An unknown client is answered before any PDF is drawn, so the pack's
    // gate is checked without the cost of rendering one.
    also: async (ctx) => [await ctx.agent.post(`${base(ctx)}/clients/not-a-client/compliance-packs`)],
    removal: async (ctx) => [await ctx.agent.get(`${base(ctx)}/clients/${ctx.clientId}/compliance-packs`)],
  },
  'reports.inbox': {
    setup: async (ctx) => {
      // A mailbox kept from an earlier plan: it must stay visible and removable.
      await prisma.reportInbox.upsert({
        where: { organizationId: ctx.organizationId },
        create: {
          organizationId: ctx.organizationId,
          host: 'imap.pellowyn.example',
          port: 993,
          secure: true,
          username: 'dmarc@pellowyn.example',
          encryptedPassword: 'irrelevant',
          enabled: false,
        },
        update: {},
      });
    },
    request: (ctx) => ctx.agent.put(`${base(ctx)}/report-inbox`).send({}),
    removal: async (ctx) => [
      await ctx.agent.get(`${base(ctx)}/report-inbox`),
      await ctx.agent.delete(`${base(ctx)}/report-inbox`),
    ],
  },
  'reports.tlsrpt': {
    request: (ctx) => ctx.agent.get(`${base(ctx)}/domains/${ctx.domainId}/tls-reports`),
  },
  'branding.logoUpload': {
    // Another workspace's object key is refused before storage is touched, so
    // the probe needs no bucket.
    request: (ctx) => ctx.agent.post(`${base(ctx)}/branding/logo/confirm`).send({ objectKey: 'logos/another-workspace/logo.png' }),
  },
  'branding.customDomain': {
    request: (ctx) =>
      ctx.agent.put(`${base(ctx)}/branding/custom-domain`).send({ customDomain: `reports-${unique()}.wistholm.example` }),
    removal: async (ctx) => [await ctx.agent.put(`${base(ctx)}/branding/custom-domain`).send({ customDomain: null })],
  },
  'integrations.webhooks': {
    request: (ctx) =>
      ctx.agent.post(`${base(ctx)}/webhooks`).send({ name: 'Wistholm ticket intake', url: 'https://hooks.wistholm.example/dmarc' }),
    also: async (ctx) => [await ctx.agent.post(`${base(ctx)}/webhooks/test`)],
    removal: async (ctx) => [await ctx.agent.get(`${base(ctx)}/webhooks`)],
  },
  'senders.owners': {
    request: (ctx) => ctx.agent.put(`${base(ctx)}/domains/${ctx.domainId}/senders/owner`).send({}),
  },
  'dns.automation': {
    // Refused by validation once allowed, before any Cloudflare call.
    request: (ctx) => ctx.agent.post(`${base(ctx)}/dns-connections`).send({}),
    also: async (ctx) => [await ctx.agent.post(`${base(ctx)}/domains/${ctx.domainId}/dns-publish/preview`).send({})],
    removal: async (ctx) => [
      await ctx.agent.get(`${base(ctx)}/dns-connections`),
      await ctx.agent.delete(`${base(ctx)}/dns-connections/not-a-connection`),
    ],
  },
  'dns.hosted': {
    request: (ctx) => ctx.agent.put(`${base(ctx)}/domains/${ctx.domainId}/hosted-dmarc`).send({}),
  },
  'dns.managedSpf': {
    request: (ctx) => ctx.agent.post(`${base(ctx)}/domains/${ctx.domainId}/managed-spf/preview`).send({}),
  },
  'dns.hostedBimi': {
    // No logo body and no hosted record: answered after the gate, before any upload.
    request: (ctx) => ctx.agent.put(`${base(ctx)}/domains/${ctx.domainId}/hosted-bimi/logo`),
  },
  'dns.hostedMtaSts': {
    request: (ctx) => ctx.agent.put(`${base(ctx)}/domains/${ctx.domainId}/hosted-mta-sts`).send({}),
  },
  'integrations.psa': {
    // Refused by validation once allowed, before the PSA is called.
    request: (ctx) => ctx.agent.put(`${base(ctx)}/psa`).send({}),
    also: async (ctx) => [await ctx.agent.put(`${base(ctx)}/psa/mappings/${ctx.clientId}`).send({})],
    removal: async (ctx) => [await ctx.agent.get(`${base(ctx)}/psa`), await ctx.agent.delete(`${base(ctx)}/psa`)],
  },
  'prospects.reports': {
    request: (ctx) =>
      ctx.agent.post(`${base(ctx)}/prospect-reports`).send({ domain: `corriwick-cafe-${unique()}.example`, prospectName: 'Corriwick Café' }),
    removal: async (ctx) => [await ctx.agent.get(`${base(ctx)}/prospect-reports`)],
  },
  'reports.usageExport': {
    request: (ctx) => ctx.agent.get(`${base(ctx)}/usage?format=json`),
  },
  'dns.spfUsage': {
    // An id that is not a domain here is answered before any DNS is read.
    request: (ctx) => ctx.agent.get(`${base(ctx)}/domains/not-a-domain/spf-usage`),
  },
  'assistant.docs': {
    request: (ctx) => ctx.agent.get(`${base(ctx)}/assistant`),
  },
} satisfies Record<GatedFeature, Probe>;

/**
 * The gate's answer for one plan.
 *
 * Withheld: 402 FEATURE_NOT_IN_PLAN, naming the feature and the first plan on the
 * ladder that grants it, with a sentence that says to upgrade, and nothing that
 * belongs to another workspace. Granted: whatever the route says next, so long as
 * it is not a 402 and not a server error.
 */
function expectGate(response: HttpResponse, key: GatedFeature, ctx: Fixture): void {
  const where = describeResponse(response);
  if (planCatalog[ctx.tier].features[key]) {
    expect(response.status, where).not.toBe(402);
    expect(response.status, where).toBeLessThan(500);
    return;
  }

  expect(response.status, where).toBe(402);
  const error = response.body?.error ?? {};
  expect(error.code, where).toBe('FEATURE_NOT_IN_PLAN');
  expect(error.feature, where).toBe(key);
  expect(error.requiredIn, where).toBe(requiredPlanFor(key));
  expect(String(error.message), where).toContain('Upgrade to');
  for (const other of catalogOrder.filter((tier) => tier !== ctx.tier)) {
    expectNothingOf(fixtures[other], response);
  }
}

function expectOpen(response: HttpResponse): void {
  const where = describeResponse(response);
  expect(response.status, where).not.toBe(402);
  expect(response.status, where).toBeLessThan(500);
}

// ─── Suite ──────────────────────────────────────────────────────────────────

const hostedBimiOrigin = env.HOSTED_BIMI_ORIGIN;

beforeAll(async () => {
  await resetDatabase();
  setProspectScannerForTests(async (domain) => recordedScan(domain));
  setHostedDnsProviderForTests(memoryZone());
  env.HOSTED_BIMI_ORIGIN = 'https://bimi.wistholm.example';

  for (const tier of catalogOrder) {
    fixtures[tier] = await tierFixture(tier);
  }
});

afterAll(async () => {
  setProspectScannerForTests(null);
  resetHostedDnsProviderForTests();
  env.HOSTED_BIMI_ORIGIN = hostedBimiOrigin;
  vi.unstubAllGlobals();
  // Nothing from this file stays behind for the next one.
  await resetDatabase();
});

describe('plan limits: feature gates', () => {
  for (const tier of catalogOrder) {
    const plan = planCatalog[tier];

    describe(`on ${plan.label}`, () => {
      beforeAll(resetRateLimits);

      for (const key of gatedFeatures) {
        const required = requiredPlanFor(key);
        const outcome = plan.features[key]
          ? 'is allowed'
          : `is refused with 402 naming ${required ? planCatalog[required].label : 'no plan'}`;
        const kept = 'removal' in probes[key] ? ', and what was kept stays readable and removable' : '';

        it(`${key} ${outcome}${kept}`, async () => {
          const ctx = fixtures[tier];
          const probe: Probe = probes[key];
          await probe.setup?.(ctx);

          const responses = [await probe.request(ctx), ...((await probe.also?.(ctx)) ?? [])];
          for (const response of responses) {
            expectGate(response, key, ctx);
          }
          for (const response of (await probe.removal?.(ctx)) ?? []) {
            expectOpen(response);
          }
        });
      }
    });
  }
});

// ─── Quotas ─────────────────────────────────────────────────────────────────

async function fillClients(organizationId: string, count: number): Promise<void> {
  const prefix = `filled-${unique()}`;
  for (let start = 0; start < count; start += 1000) {
    const size = Math.min(1000, count - start);
    await prisma.client.createMany({
      data: Array.from({ length: size }, (_, offset) => ({
        organizationId,
        name: `Filled client ${start + offset}`,
        slug: `${prefix}-${start + offset}`,
      })),
    });
  }
}

/**
 * Domains that count toward the active-domain limit.
 *
 * A domain counts while it is inside the grace window after it was added, or
 * while it has reported within the plan's window (countCountedDomainsIn). A row
 * created now is inside the grace window, which is how a newly added domain
 * counts in production too.
 */
async function fillDomains(clientId: string, count: number): Promise<void> {
  const prefix = `filled-${unique()}`;
  for (let start = 0; start < count; start += 1000) {
    const size = Math.min(1000, count - start);
    await prisma.domain.createMany({
      data: Array.from({ length: size }, (_, offset) => ({
        clientId,
        name: `${prefix}-${start + offset}.example`,
        slug: `${prefix}-${start + offset}`,
      })),
    });
  }
}

async function fillInvitations(organizationId: string, inviterId: string, count: number): Promise<void> {
  if (count <= 0) return;
  const prefix = unique();
  await prisma.invitation.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      id: `invite-${prefix}-${index}`,
      organizationId,
      email: `seat-${prefix}-${index}@ollerbeck.example`,
      role: 'analyst',
      status: 'pending',
      inviterId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
    })),
  });
}

/** Workspaces an account owns, as Better Auth writes them: the workspace and an owner row. */
async function ownedWorkspaces(userId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `org-${unique()}`;
    await prisma.organization.create({ data: { id, name: `Thrandle Build ${index}`, slug: `thrandle-${unique()}`, createdAt: new Date() } });
    await prisma.member.create({ data: { id: `member-${unique()}`, organizationId: id, userId, role: 'owner', createdAt: new Date() } });
    ids.push(id);
  }
  return ids;
}

/** Colleagues already on the team, as accepted invitations leave them. */
async function teamMembers(organizationId: string, count: number): Promise<string[]> {
  const prefix = unique();
  const userIds = Array.from({ length: count }, (_, index) => `user-${prefix}-${index}`);
  await prisma.user.createMany({
    data: userIds.map((id, index) => ({ id, name: `Colleague ${index}`, email: `colleague-${prefix}-${index}@ollerbeck.example`, emailVerified: true })),
  });
  await prisma.member.createMany({
    data: userIds.map((userId) => ({ id: `member-${unique()}`, organizationId, userId, role: 'analyst', createdAt: new Date() })),
  });
  return userIds;
}

/**
 * Prospect reports already made this month, with the creation record the
 * monthly count reads. Real creation writes both in one transaction.
 */
async function fillProspectReports(organizationId: string, count: number): Promise<void> {
  if (count <= 0) return;
  const prefix = unique();
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `prospect-${prefix}-${index}`,
    organizationId,
    domain: `haskerley-${prefix}-${index}.example`,
    token: `seeded-${prefix}-${index}-${'a'.repeat(32)}`,
    result: recordedScan(`haskerley-${prefix}-${index}.example`) as unknown as object,
    score: 41,
    scannedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  }));
  await prisma.prospectReport.createMany({ data: rows });
  await prisma.auditLog.createMany({
    data: rows.map((row) => ({
      organizationId,
      action: 'PROSPECT_REPORT_CREATED' as const,
      targetType: 'prospect_report',
      targetId: row.id,
      detail: { domain: row.domain },
    })),
  });
}

function v1(key: string) {
  return {
    post: (path: string, body: object) => request(app).post(path).set('Authorization', `Bearer ${key}`).send(body),
  };
}

describe('plan limits: quotas', () => {
  for (const tier of catalogOrder) {
    const plan = planCatalog[tier];
    const label = plan.label;
    const hasApi = plan.features['api.access'];
    const paths = hasApi ? 'the session route and /api/v1' : 'the session route';

    describe(`on ${label}`, () => {
      beforeAll(resetRateLimits);

      it(`clients: the ${ordinal(plan.maxClients)} is accepted, one over is refused on ${paths}, and a removal makes room`, async () => {
        const owner = await ownerWithWorkspace(`quota-client-${tier.toLowerCase()}`, `Ollerbeck Vets ${label} sample`);
        await grantPlan(owner.organizationId, tier);
        const key = hasApi
          ? (await createApiKey({ organizationId: owner.organizationId, name: 'Quota probe', scopes: ['read', 'write'], createdById: owner.userId })).key
          : null;
        const limit = plan.maxClients;
        const refusal = { code: 'PLAN_LIMIT_REACHED', quota: 'client', used: limit, limit, upgradeTo: upgradeFor(tier, (p) => p.maxClients) };
        const addClient = () =>
          owner.agent.post(`/api/workspaces/${owner.organizationId}/clients`).send({ name: 'Thrandle Build', slug: `thrandle-${unique()}` });

        await fillClients(owner.organizationId, limit - 1);

        const reached = await addClient();
        expect(reached.status, describeResponse(reached)).toBe(201);
        expectLimitRefusal(await addClient(), refusal);
        if (key) {
          expectLimitRefusal(await v1(key).post('/api/v1/clients', { name: 'Thrandle Build by API' }), refusal);
        }
        expect(await prisma.client.count({ where: { organizationId: owner.organizationId } })).toBe(limit);

        await prisma.client.delete({ where: { id: reached.body.id as string } });

        if (key) {
          const again = await v1(key).post('/api/v1/clients', { name: 'Thrandle Build by API' });
          expect(again.status, describeResponse(again)).toBe(201);
          expectLimitRefusal(await v1(key).post('/api/v1/clients', { name: 'One more by API' }), refusal);
        } else {
          const again = await addClient();
          expect(again.status, describeResponse(again)).toBe(201);
        }
        expectLimitRefusal(await addClient(), refusal);
        expect(await prisma.client.count({ where: { organizationId: owner.organizationId } })).toBe(limit);
      });

      it(`active domains: the ${ordinal(plan.maxActiveDomains)} is accepted, one over is refused on ${paths}, and a removal makes room`, async () => {
        const owner = await ownerWithWorkspace(`quota-domain-${tier.toLowerCase()}`, `Haskerley Law ${label} sample`);
        await grantPlan(owner.organizationId, tier);
        const key = hasApi
          ? (await createApiKey({ organizationId: owner.organizationId, name: 'Quota probe', scopes: ['read', 'write'], createdById: owner.userId })).key
          : null;
        const client = await prisma.client.create({
          data: { organizationId: owner.organizationId, name: 'Haskerley Law', slug: `haskerley-${unique()}` },
        });
        const limit = plan.maxActiveDomains;
        const refusal = {
          code: 'PLAN_LIMIT_REACHED',
          quota: 'activeDomain',
          used: limit,
          limit,
          upgradeTo: upgradeFor(tier, (p) => p.maxActiveDomains),
        };
        const addDomain = () =>
          owner.agent
            .post(`/api/workspaces/${owner.organizationId}/clients/${client.id}/domains`)
            .send({ name: `haskerley-${unique()}.example` });
        const addDomainByApi = (apiKey: string) =>
          v1(apiKey).post('/api/v1/domains', { clientId: client.id, name: `haskerley-api-${unique()}.example` });

        await fillDomains(client.id, limit - 1);

        const reached = await addDomain();
        expect(reached.status, describeResponse(reached)).toBe(201);
        expectLimitRefusal(await addDomain(), refusal);
        if (key) {
          expectLimitRefusal(await addDomainByApi(key), refusal);
        }

        await prisma.domain.delete({ where: { id: reached.body.id as string } });

        if (key) {
          const again = await addDomainByApi(key);
          expect(again.status, describeResponse(again)).toBe(201);
          expectLimitRefusal(await addDomainByApi(key), refusal);
        } else {
          const again = await addDomain();
          expect(again.status, describeResponse(again)).toBe(201);
        }
        expectLimitRefusal(await addDomain(), refusal);
        expect(await prisma.domain.count({ where: { clientId: client.id } })).toBe(limit);
      });

      if (isUnlimited(plan.maxMembers)) {
        it('team members: no limit, so an invitation is accepted past every capped plan', async () => {
          const owner = await ownerWithWorkspace(`quota-team-${tier.toLowerCase()}`, `Ollerbeck Vets ${label} team`);
          await grantPlan(owner.organizationId, tier);
          const largestCap = Math.max(...catalogOrder.map((other) => planCatalog[other].maxMembers).filter((cap) => !isUnlimited(cap)));
          await fillInvitations(owner.organizationId, owner.userId, largestCap + 5);

          const invited = await owner.agent
            .post('/api/auth/organization/invite-member')
            .send({ email: `one-more-${unique()}@ollerbeck.example`, role: 'analyst', organizationId: owner.organizationId });
          expect(invited.status, describeResponse(invited)).toBe(200);
        });
      } else {
        it(`team members: members and open invitations fill ${plan.maxMembers}, one over is refused with 402, and a cancelled invitation makes room`, async () => {
          const owner = await ownerWithWorkspace(`quota-team-${tier.toLowerCase()}`, `Ollerbeck Vets ${label} team`);
          await grantPlan(owner.organizationId, tier);
          const limit = plan.maxMembers;
          const invite = () =>
            owner.agent
              .post('/api/auth/organization/invite-member')
              .send({ email: `seat-${unique()}@ollerbeck.example`, role: 'analyst', organizationId: owner.organizationId });

          // The owner is one member; the open invitations take every seat but one.
          await fillInvitations(owner.organizationId, owner.userId, limit - 2);

          const reached = await invite();
          expect(reached.status, describeResponse(reached)).toBe(200);
          const refusal = { code: 'PLAN_LIMIT_REACHED', quota: 'member', used: limit, limit, upgradeTo: upgradeFor(tier, (p) => p.maxMembers), flat: true };
          expectLimitRefusal(await invite(), refusal);
          expect(await prisma.invitation.count({ where: { organizationId: owner.organizationId, status: 'pending' } })).toBe(limit - 1);

          await prisma.invitation.update({ where: { id: reached.body.id as string }, data: { status: 'canceled' } });

          const again = await invite();
          expect(again.status, describeResponse(again)).toBe(200);
          expectLimitRefusal(await invite(), refusal);
        });
      }

      it(`workspaces: the ${ordinal(plan.maxWorkspaces)} is accepted, one over is refused with the upgrade path, and a removal makes room`, async () => {
        const owner = await signedIn(`quota-workspace-${tier.toLowerCase()}`);
        const limit = plan.maxWorkspaces;
        const filled = await ownedWorkspaces(owner.userId, limit - 1);
        if (filled[0]) {
          await grantPlan(filled[0], tier);
        } else {
          // Nothing owned yet to set the plan through; the plan lives on the account.
          await prisma.user.update({ where: { id: owner.userId }, data: { plan: tier } });
        }
        const refusal = { code: 'WORKSPACE_LIMIT_REACHED', quota: 'workspace', used: limit, limit, upgradeTo: upgradeFor(tier, (p) => p.maxWorkspaces) };

        const reached = await createWorkspace(owner.agent, `Corriwick Café ${label} sample`);
        expect(reached.status, describeResponse(reached)).toBe(201);
        expectLimitRefusal(await createWorkspace(owner.agent, 'Corriwick Café one too many'), refusal);

        await prisma.organization.delete({ where: { id: (filled[0] ?? reached.body.id) as string } });

        const again = await createWorkspace(owner.agent, `Corriwick Café ${label} again`);
        expect(again.status, describeResponse(again)).toBe(201);
        expectLimitRefusal(await createWorkspace(owner.agent, 'Corriwick Café still too many'), refusal);
      });

      if (plan.maxProspectReportsPerMonth > 0) {
        it(`prospect reports: the ${ordinal(plan.maxProspectReportsPerMonth)} this month is accepted, one over is refused, and removing one does not give it back`, async () => {
          const owner = await ownerWithWorkspace(`quota-prospect-${tier.toLowerCase()}`, `Pellowyn Dental ${label} prospects`);
          await grantPlan(owner.organizationId, tier);
          const limit = plan.maxProspectReportsPerMonth;
          const reports = `/api/workspaces/${owner.organizationId}/prospect-reports`;
          const scan = () => owner.agent.post(reports).send({ domain: `thrandle-${unique()}.example` });
          // The monthly allowance has no QuotaKey; the rest of the refusal is the same.
          const refusal = {
            code: 'PROSPECT_LIMIT_REACHED',
            used: limit,
            limit,
            upgradeTo: upgradeFor(tier, (p) => p.maxProspectReportsPerMonth),
          };
          const expectProspectRefusal = (response: HttpResponse) => expectLimitRefusal(response, refusal);

          await fillProspectReports(owner.organizationId, limit - 1);

          const reached = await scan();
          expect(reached.status, describeResponse(reached)).toBe(201);
          expectProspectRefusal(await scan());

          // Revoke and remove the newest. The scan already happened, so the
          // month's count must not fall.
          const id = reached.body.report.id as string;
          expect((await owner.agent.post(`${reports}/${id}/revoke`)).status).toBe(204);
          expect((await owner.agent.delete(`${reports}/${id}`)).status).toBe(204);
          expectProspectRefusal(await scan());

          // Next month the allowance is fresh: the same reports, dated last month.
          const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15));
          await prisma.prospectReport.updateMany({ where: { organizationId: owner.organizationId }, data: { createdAt: lastMonth } });
          await prisma.auditLog.updateMany({
            where: { organizationId: owner.organizationId, action: 'PROSPECT_REPORT_CREATED' },
            data: { createdAt: lastMonth },
          });
          const fresh = await scan();
          expect(fresh.status, describeResponse(fresh)).toBe(201);
        });
      }
    });
  }
});

// ─── Downgrades ─────────────────────────────────────────────────────────────

/**
 * A Harbor workspace with a real (mock provider) subscription, so the self-serve
 * plan change runs end to end. Built exactly as billing-plan-guard does: the
 * mock answers 404 for a subscription it did not issue, so a row written by hand
 * would let the success path pass against a provider that never agreed.
 */
async function paidHarborWorkspace(label: string) {
  const owner = await ownerWithWorkspace(label, `Haskerley Law ${label}`);
  const providerPlanId = `plan_limits_${unique()}`;

  await saveStoredPlan({
    provider: 'RAZORPAY',
    tier: 'HARBOR',
    interval: 'monthly',
    currency: 'INR',
    priceMinor: planCatalog.HARBOR.prices.INR.monthlyMinor,
    providerPlanId,
  });

  const provider = mockProvider() as MockBillingProvider;
  const session = await provider.createCheckout({
    organizationId: owner.organizationId,
    plan: 'HARBOR',
    interval: 'monthly' as BillingInterval,
    currency: 'INR' as BillingCurrency,
    quantity: 1,
    contact: { name: 'Haskerley Owner', email: owner.email },
    successUrl: 'https://app.wistholm.example/billing/complete',
    cancelUrl: 'https://app.wistholm.example/billing',
    reference: owner.organizationId,
  });
  const remote = provider.completeCheckout(session.id);

  await applyBillingEvent({
    providerEventId: `evt_plan_limits_${unique()}`,
    type: 'subscription.activated',
    provider: 'RAZORPAY',
    providerSubscriptionId: remote.providerSubscriptionId,
    providerCustomerId: null,
    organizationId: owner.organizationId,
    plan: 'HARBOR',
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    cancelAtPeriodEnd: false,
    quantity: 1,
    nextAttemptAt: null,
    occurredAt: new Date(),
    raw: { note: 'fixture' },
  });

  return owner;
}

const target: PlanTier = 'FAIRWAY';

function changePlan(owner: { agent: Agent; organizationId: string }, plan: PlanTier) {
  return owner.agent.patch(`/api/workspaces/${owner.organizationId}/billing/plan`).send({ plan, interval: 'monthly' });
}

async function expectPlanUnchanged(owner: { organizationId: string; userId: string }): Promise<void> {
  const subscription = await prisma.subscription.findFirst({ where: { organizationId: owner.organizationId } });
  expect(subscription?.plan).toBe('HARBOR');
  expect(subscription?.pendingPlan ?? null).toBeNull();
  expect((await prisma.organization.findUniqueOrThrow({ where: { id: owner.organizationId } })).plan).toBe('HARBOR');
  expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } })).plan).toBe('HARBOR');
}

function expectOverage(response: HttpResponse, quota: string, used: number, limit: number): void {
  const where = describeResponse(response);
  expect(response.status, where).toBe(409);
  expect(response.body.error.code, where).toBe('PLAN_CHANGE_OVER_QUOTA');
  const rows = response.body.error.overage as { quota: string; label: string; used: number; limit: number; by: number }[];
  // The billing screen sets each row as "<Label>: <used> of <limit> allowed (<by> over)".
  expect(rows, where).toEqual([{ quota, label: expect.any(String), used, limit, by: used - limit }]);
}

function staffPlan(organizationId: string, plan: PlanTier) {
  return request(app)
    .patch(`/api/workspaces/${organizationId}/plan`)
    .set('Authorization', `Bearer ${env.STAFF_API_KEY}`)
    .send({ plan });
}

describe('plan limits: downgrades', () => {
  beforeAll(resetRateLimits);

  const fairway = planCatalog[target];

  it(`refuses a self-serve move to ${fairway.label} while over its client limit, and allows it at exactly the limit`, async () => {
    const owner = await paidHarborWorkspace('downgrade-clients');
    await fillClients(owner.organizationId, fairway.maxClients + 1);

    expectOverage(await changePlan(owner, target), 'client', fairway.maxClients + 1, fairway.maxClients);
    await expectPlanUnchanged(owner);

    const one = await prisma.client.findFirstOrThrow({ where: { organizationId: owner.organizationId } });
    await prisma.client.delete({ where: { id: one.id } });
    const allowed = await changePlan(owner, target);
    expect(allowed.status, describeResponse(allowed)).toBe(200);
  });

  it(`refuses a self-serve move to ${fairway.label} while over its active-domain limit, and allows it at exactly the limit`, async () => {
    const owner = await paidHarborWorkspace('downgrade-domains');
    const client = await prisma.client.create({ data: { organizationId: owner.organizationId, name: 'Haskerley Law', slug: `haskerley-${unique()}` } });
    await fillDomains(client.id, fairway.maxActiveDomains + 1);

    expectOverage(await changePlan(owner, target), 'activeDomain', fairway.maxActiveDomains + 1, fairway.maxActiveDomains);
    await expectPlanUnchanged(owner);

    const one = await prisma.domain.findFirstOrThrow({ where: { clientId: client.id } });
    await prisma.domain.delete({ where: { id: one.id } });
    const allowed = await changePlan(owner, target);
    expect(allowed.status, describeResponse(allowed)).toBe(200);
  });

  it(`refuses a self-serve move to ${fairway.label} while over its team-member limit, and allows it at exactly the limit`, async () => {
    const owner = await paidHarborWorkspace('downgrade-team');
    // The owner plus enough colleagues to be one over.
    const colleagues = await teamMembers(owner.organizationId, fairway.maxMembers);

    expectOverage(await changePlan(owner, target), 'member', fairway.maxMembers + 1, fairway.maxMembers);
    await expectPlanUnchanged(owner);

    await prisma.member.deleteMany({ where: { organizationId: owner.organizationId, userId: colleagues[0]! } });
    const allowed = await changePlan(owner, target);
    expect(allowed.status, describeResponse(allowed)).toBe(200);
  });

  it(`refuses a self-serve move to ${fairway.label} while the account owns more workspaces than it allows, and allows it at exactly the limit`, async () => {
    const owner = await paidHarborWorkspace('downgrade-workspaces');
    const extra = await ownedWorkspaces(owner.userId, fairway.maxWorkspaces);

    expectOverage(await changePlan(owner, target), 'workspace', fairway.maxWorkspaces + 1, fairway.maxWorkspaces);
    await expectPlanUnchanged(owner);

    await prisma.organization.delete({ where: { id: extra[0]! } });
    const allowed = await changePlan(owner, target);
    expect(allowed.status, describeResponse(allowed)).toBe(200);
  });

  it(`keeps clients over the limit after a staff move to ${fairway.label}, refuses the next, and accepts again once back under`, async () => {
    const owner = await ownerWithWorkspace('staff-clients', 'Thrandle Build staff clients');
    await grantPlan(owner.organizationId, 'HARBOR');
    const kept = fairway.maxClients + 2;
    await fillClients(owner.organizationId, kept);

    expect((await staffPlan(owner.organizationId, target)).status).toBe(200);
    expect(await prisma.client.count({ where: { organizationId: owner.organizationId } })).toBe(kept);

    const addClient = () =>
      owner.agent.post(`/api/workspaces/${owner.organizationId}/clients`).send({ name: 'Thrandle Build', slug: `thrandle-${unique()}` });
    expectLimitRefusal(await addClient(), {
      code: 'PLAN_LIMIT_REACHED',
      quota: 'client',
      used: kept,
      limit: fairway.maxClients,
      upgradeTo: upgradeFor(target, (p) => p.maxClients),
    });

    const surplus = await prisma.client.findMany({ where: { organizationId: owner.organizationId }, take: 3, select: { id: true } });
    await prisma.client.deleteMany({ where: { id: { in: surplus.map((row) => row.id) } } });
    const added = await addClient();
    expect(added.status, describeResponse(added)).toBe(201);
  });

  it(`keeps active domains over the limit after a staff move to ${fairway.label}, refuses the next, and accepts again once back under`, async () => {
    const owner = await ownerWithWorkspace('staff-domains', 'Thrandle Build staff domains');
    await grantPlan(owner.organizationId, 'HARBOR');
    const client = await prisma.client.create({ data: { organizationId: owner.organizationId, name: 'Thrandle Build', slug: `thrandle-${unique()}` } });
    const kept = fairway.maxActiveDomains + 2;
    await fillDomains(client.id, kept);

    expect((await staffPlan(owner.organizationId, target)).status).toBe(200);
    expect(await prisma.domain.count({ where: { clientId: client.id } })).toBe(kept);

    const addDomain = () =>
      owner.agent.post(`/api/workspaces/${owner.organizationId}/clients/${client.id}/domains`).send({ name: `thrandle-${unique()}.example` });
    expectLimitRefusal(await addDomain(), {
      code: 'PLAN_LIMIT_REACHED',
      quota: 'activeDomain',
      used: kept,
      limit: fairway.maxActiveDomains,
      upgradeTo: upgradeFor(target, (p) => p.maxActiveDomains),
    });

    const surplus = await prisma.domain.findMany({ where: { clientId: client.id }, take: 3, select: { id: true } });
    await prisma.domain.deleteMany({ where: { id: { in: surplus.map((row) => row.id) } } });
    const added = await addDomain();
    expect(added.status, describeResponse(added)).toBe(201);
  });

  it(`keeps team members over the limit after a staff move to ${fairway.label}, refuses an invitation, and accepts one once back under`, async () => {
    const owner = await ownerWithWorkspace('staff-team', 'Thrandle Build staff team');
    await grantPlan(owner.organizationId, 'HARBOR');
    const colleagues = await teamMembers(owner.organizationId, fairway.maxMembers + 1);
    const kept = colleagues.length + 1;

    expect((await staffPlan(owner.organizationId, target)).status).toBe(200);
    expect(await prisma.member.count({ where: { organizationId: owner.organizationId } })).toBe(kept);

    const invite = () =>
      owner.agent
        .post('/api/auth/organization/invite-member')
        .send({ email: `seat-${unique()}@thrandle.example`, role: 'analyst', organizationId: owner.organizationId });
    expectLimitRefusal(await invite(), {
      code: 'PLAN_LIMIT_REACHED',
      quota: 'member',
      used: kept,
      limit: fairway.maxMembers,
      upgradeTo: upgradeFor(target, (p) => p.maxMembers),
      flat: true,
    });

    await prisma.member.deleteMany({ where: { organizationId: owner.organizationId, userId: { in: colleagues.slice(0, 3) } } });
    const invited = await invite();
    expect(invited.status, describeResponse(invited)).toBe(200);
  });

  it(`keeps workspaces over the limit after a staff move to ${fairway.label}, refuses the next, and accepts again once back under`, async () => {
    const owner = await ownerWithWorkspace('staff-workspaces', 'Thrandle Build staff workspaces');
    await grantPlan(owner.organizationId, 'HARBOR');
    const extra = await ownedWorkspaces(owner.userId, fairway.maxWorkspaces);
    const kept = extra.length + 1;

    expect((await staffPlan(owner.organizationId, target)).status).toBe(200);
    expect(await prisma.member.count({ where: { userId: owner.userId, role: 'owner' } })).toBe(kept);

    expectLimitRefusal(await createWorkspace(owner.agent, 'Thrandle Build one too many'), {
      code: 'WORKSPACE_LIMIT_REACHED',
      quota: 'workspace',
      used: kept,
      limit: fairway.maxWorkspaces,
      upgradeTo: upgradeFor(target, (p) => p.maxWorkspaces),
    });

    await prisma.organization.deleteMany({ where: { id: { in: extra } } });
    const created = await createWorkspace(owner.agent, 'Thrandle Build back under');
    expect(created.status, describeResponse(created)).toBe(201);
  });
});

// ─── Safety ─────────────────────────────────────────────────────────────────

describe('plan limits: refusals never cross workspaces', () => {
  beforeAll(resetRateLimits);

  it("answers 403 or 404 for another workspace's gated routes, and names nothing of it", async () => {
    const caller = fixtures.HARBOR;
    const owner = fixtures.ADMIRALTY;
    const theirs = `/api/workspaces/${owner.organizationId}`;

    const responses = [
      await caller.agent.post(`${theirs}/alert-rules`).send({
        name: 'Failure rate over ten percent',
        metric: 'FAILURE_RATE',
        operator: 'GREATER_THAN',
        threshold: 10,
        domainId: owner.domainId,
        recipientUserIds: [caller.userId],
      }),
      await caller.agent.get(`${theirs}/domains/${owner.domainId}/forensics`),
      await caller.agent.post(`${theirs}/report-shares`).send({ domainId: owner.domainId }),
      await caller.agent.put(`${theirs}/slack-destination`).send({ webhookUrl: SLACK_URL }),
      await caller.agent.post(`${theirs}/clients/${owner.clientId}/trust-center`),
      await caller.agent.get(`${theirs}/usage?format=json`),
      await caller.agent.post(`${theirs}/prospect-reports`).send({ domain: `corriwick-cafe-${unique()}.example` }),
      await caller.agent.post(`${theirs}/clients`).send({ name: 'Thrandle Build', slug: `thrandle-${unique()}` }),
      await caller.agent.post(`${theirs}/clients/${owner.clientId}/domains`).send({ name: `thrandle-${unique()}.example` }),
    ];

    for (const response of responses) {
      expect([403, 404], describeResponse(response)).toContain(response.status);
      expectNothingOf(owner, response);
    }
  });

  it("answers 404 for another workspace's ids on the caller's own gated routes, and names nothing of it", async () => {
    const caller = fixtures.HARBOR;
    const owner = fixtures.ADMIRALTY;
    const mine = `/api/workspaces/${caller.organizationId}`;

    const responses = [
      await caller.agent.post(`${mine}/report-shares`).send({ domainId: owner.domainId }),
      await caller.agent.post(`${mine}/alert-rules`).send({
        name: 'Failure rate over ten percent',
        metric: 'FAILURE_RATE',
        operator: 'GREATER_THAN',
        threshold: 10,
        domainId: owner.domainId,
        recipientUserIds: [caller.userId],
      }),
      await caller.agent.get(`${mine}/domains/${owner.domainId}/forensics`),
      await caller.agent.post(`${mine}/clients/${owner.clientId}/trust-center`),
      await caller.agent.post(`${mine}/clients/${owner.clientId}/portal-access`).send({ email: `office-${unique()}@pellowyn.example` }),
      await caller.agent.post(`${mine}/clients/${owner.clientId}/domains`).send({ name: `thrandle-${unique()}.example` }),
    ];

    for (const response of responses) {
      expect(response.status, describeResponse(response)).toBe(404);
      expectNothingOf(owner, response);
    }
  });

  it("refuses a free workspace for another workspace's ids with its own plan refusal, naming nothing of the other", async () => {
    const caller = fixtures.MOORING;
    const owner = fixtures.ADMIRALTY;
    const mine = `/api/workspaces/${caller.organizationId}`;

    const responses = [
      await caller.agent.post(`${mine}/report-shares`).send({ domainId: owner.domainId }),
      await caller.agent.get(`${mine}/domains/${owner.domainId}/forensics`),
      await caller.agent.post(`${mine}/clients/${owner.clientId}/trust-center`),
    ];

    for (const response of responses) {
      expect(response.status, describeResponse(response)).toBe(402);
      expect(response.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
      expectNothingOf(owner, response);
    }
  });

  it("keeps an API key inside its own workspace when it names another workspace's ids", async () => {
    const caller = fixtures.HARBOR;
    const owner = fixtures.ADMIRALTY;
    const bearer = `Bearer ${caller.apiKey}`;

    const responses = [
      await request(app).get(`/api/v1/domains/${owner.domainId}`).set('Authorization', bearer),
      await request(app).post(`/api/v1/domains/${owner.domainId}/verify`).set('Authorization', bearer),
      await request(app)
        .post('/api/v1/domains')
        .set('Authorization', bearer)
        .send({ clientId: owner.clientId, name: `thrandle-${unique()}.example` }),
    ];

    for (const response of responses) {
      expect(response.status, describeResponse(response)).toBe(404);
      expectNothingOf(owner, response);
    }
  });
});
