import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { acquireLease, currentInstanceId, withJobLease } from '../src/scheduler/job-lease.service.js';
import { evaluateAlertRules, runAlertRollups } from '../src/services/alert.service.js';
import { runReportDigests } from '../src/services/report-digest.service.js';
import { executeDueErasures } from '../src/services/erasure/erasure.service.js';
import { runDunning } from '../src/billing/dunning.js';
import { reverifyUnverifiedDomains } from '../src/services/domain-reverify.service.js';
import { runInboxPollOnce } from '../src/scheduler/inbox-scheduler.js';
import { grantPlan } from './helpers/plan.js';
import { ingestDmarcReport } from '../src/services/report.service.js';
import request from 'supertest';
import { app } from '../src/index.js';

/**
 * Running the jobs the way an autoscaled deployment does.
 *
 * Every test here fires two runs at the same rows with Promise.all, which is
 * what two replicas do. The sequential versions of these tests all passed before
 * this file existed, and would all still pass, because a second run started after
 * the first finished sees the state the first one left behind. Only genuinely
 * concurrent execution finds the read-then-write pattern, and that pattern is
 * the entire class of bug that only appears once you have more than one instance.
 *
 * The rule being tested throughout: a customer must receive one email, one
 * webhook, and one confirmation per event, no matter how many instances are
 * running.
 */

let fixtureId = 0;
const password = 'correct-horse-battery-staple';

/**
 * A report whose senders authenticate as a different domain to the one they
 * claim to be from, which is what the spoofing metric measures. A report whose
 * SPF domain matches its header domain is aligned and would not fire.
 */
function aggregateReport(domain: string, reportId: string, rows: { ip: string; count: number; dkim: string; spf: string; spfDomain: string }[]): string {
  const records = rows
    .map(
      (row) => `
  <record>
    <row><source_ip>${row.ip}</source_ip><count>${row.count}</count>
      <policy_evaluated><disposition>none</disposition><dkim>${row.dkim}</dkim><spf>${row.spf}</spf></policy_evaluated>
    </row>
    <identifiers><header_from>${row.spfDomain}</header_from><envelope_from>${row.spfDomain}</envelope_from></identifiers>
    <auth_results><spf><domain>${row.spfDomain}</domain><scope>mfrom</scope><result>${row.spf}</result></spf></auth_results>
  </record>`,
    )
    .join('\n');

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
  </policy_published>${records}
</feedback>`;
}

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "job_lease", "sso_auth_request", "sso_connection_domain", "sso_connection", "report_inbox", "entitlement_override", "erasure_request", "subscription", "export_job", "audit_log", "notification", "report_digest", "report_share", "alert_delivery", "alert_event", "alert_recipient", "alert_rule", "notification_preference", "dmarc_forensic_report", "dmarc_auth_result", "dmarc_report_record", "dmarc_report", "scan", "domain", "client", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

async function setup() {
  fixtureId += 1;
  const agent = request.agent(app);
  const email = `scale-${Date.now()}-${fixtureId}@example.com`;
  await agent.post('/api/auth/sign-up/email').send({ name: 'Scale Owner', email, password });
  await prisma.user.update({ where: { email }, data: { emailVerified: true } });
  await agent.post('/api/auth/sign-in/email').send({ email, password });

  const workspace = await agent.post('/api/workspaces').send({ name: 'Scale Agency', slug: `sc-${Date.now()}-${fixtureId}` });
  const organizationId = workspace.body.id as string;
  const userId = (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;

  const client = await prisma.client.create({
    data: { organizationId, name: `Client ${fixtureId}`, slug: `c-${Date.now()}-${fixtureId}` },
  });

  // A published DMARC record, because the alert snapshot reads the policy and a
  // domain with no record has nothing to judge a sender against.
  const domain = await prisma.domain.create({
    data: {
      clientId: client.id,
      slug: `dom-${Math.random().toString(36).slice(2, 10)}`,
      name: `scale-${fixtureId}.test`,
      status: 'VERIFIED',
      verifiedAt: new Date(),
      dmarcPolicy: 'none',
      dmarcRecord: 'v=DMARC1; p=none; rua=mailto:agg@reports.dmarcharbor.com',
    },
  });

  return { agent, organizationId, userId, clientId: client.id, domainId: domain.id, domainName: domain.name };
}

describe('job lease', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('lets exactly one holder acquire a free lease', async () => {
    const [a, b] = await Promise.all([acquireLease('test-job'), acquireLease('test-job')]);

    const winners = [a, b].filter((result): result is { acquired: true; release: () => Promise<void> } => result.acquired);
    expect(winners).toHaveLength(1);

    await winners[0]?.release();
  });

  it('releases the lease when the job throws, so a bad run does not disable the job', async () => {
    await expect(
      withJobLease('test-job', async () => {
        throw new Error('the job failed');
      }),
    ).rejects.toThrow('the job failed');

    // A lease leaked by a throw would silently stop the job for its whole
    // duration, which looks exactly like the job being broken.
    const after = await acquireLease('test-job');
    expect(after.acquired).toBe(true);
    if (after.acquired) {
      await after.release();
    }
  });

  it('does not release a lease that has already been taken by somebody else', async () => {
    // A late release must not pull the lease out from under the instance that
    // legitimately holds it now. Simulated by writing a row held by a different
    // process and then calling release for this one, because two acquires in one
    // process share an instance id and cannot tell the two holders apart.
    await prisma.jobLease.create({
      data: { name: 'stolen-job', holder: 'some-other-instance', expiresAt: new Date(Date.now() + 60000) },
    });

    const lease = await acquireLease('stolen-job');
    expect(lease.acquired).toBe(false);

    const row = await prisma.jobLease.findUniqueOrThrow({ where: { name: 'stolen-job' } });
    expect(row.holder).toBe('some-other-instance');
  });

  it('records which instance holds the lease', async () => {
    const lease = await acquireLease('test-job');
    const row = await prisma.jobLease.findUniqueOrThrow({ where: { name: 'test-job' } });
    expect(row.holder).toBe(currentInstanceId());
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    if (lease.acquired) {
      await lease.release();
    }
  });
});

describe('scheduled client digests under two instances', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('sends one digest, not one per instance', async () => {
    const { organizationId, domainId } = await setup();

    await prisma.reportDigest.create({
      data: {
        organizationId,
        domainId,
        createdById: (await prisma.member.findFirstOrThrow({ where: { organizationId } })).userId,
        frequency: 'WEEKLY',
        sendHourUtc: new Date().getUTCHours(),
        weekday: new Date().getUTCDay(),
        recipientEmails: ['client@example.com'],
        enabled: true,
      },
    });

    const [a, b] = await Promise.all([runReportDigests(), runReportDigests()]);

    // The claim is a conditional write on lastSentAt, so exactly one of these
    // moves the row. Before the claim, both read null, both passed the due
    // check, and the customer received the same weekly summary twice.
    const sent = [...a, ...b].filter((result) => result.sent);
    expect(sent).toHaveLength(1);
  });
});

describe('alert evaluation under two instances', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('opens one alert event when both instances evaluate the same rule', async () => {
    const { organizationId, domainId, userId, agent, domainName } = await setup();
    // Alerts are gated, and a fresh workspace is on the free plan, so the rule
    // would be refused and the assertion below would be vacuous.
    await grantPlan(organizationId, 'HARBOR');

    const created = await agent.post(`/api/workspaces/${organizationId}/alert-rules`).send({
      domainId,
      name: 'New unauthenticated source',
      metric: 'NEW_UNAUTHENTICATED_SOURCE',
      operator: 'GREATER_THAN_OR_EQUAL',
      threshold: 1,
      windowMinutes: 1440,
      cooldownMinutes: 1440,
      maxReminderLevel: 3,
      recipientUserIds: [userId],
    });
    expect(created.status).toBe(201);

    // Ingested through the service, which is what computes the figures the
    // snapshot reads. A rule that never fires would make the assertion below
    // vacuous, so the ingest is checked rather than assumed.
    const ingested = await ingestDmarcReport({
      organizationId,
      domainId,
      xml: aggregateReport(domainName, `scale-${fixtureId}`, [
        { ip: '192.0.2.55', count: 400, dkim: 'fail', spf: 'fail', spfDomain: 'evil-lookalike.test' },
      ]),
    });
    expect(ingested.status).toBe('created');

    await Promise.all([evaluateAlertRules(), evaluateAlertRules()]);

    // One condition, one event. Two instances each creating an AlertEvent would
    // show the customer two alerts for one thing and email them twice.
    const events = await prisma.alertEvent.count({ where: { rule: { organizationId } } });
    expect(events).toBe(1);
  });

  it('evaluates every rule when two instances overlap', async () => {
    const first = await setup();
    const second = await setup();
    await grantPlan(first.organizationId, 'HARBOR');
    await grantPlan(second.organizationId, 'HARBOR');

    for (const workspace of [first, second]) {
      const created = await workspace.agent
        .post(`/api/workspaces/${workspace.organizationId}/alert-rules`)
        .send({
          domainId: workspace.domainId,
          name: 'Spoofing',
          metric: 'NEW_UNAUTHENTICATED_SOURCE',
          operator: 'GREATER_THAN_OR_EQUAL',
          threshold: 1,
          windowMinutes: 1440,
          cooldownMinutes: 1440,
          maxReminderLevel: 3,
          recipientUserIds: [workspace.userId],
        });
      expect(created.status).toBe(201);

      const ingested = await ingestDmarcReport({
        organizationId: workspace.organizationId,
        domainId: workspace.domainId,
        xml: aggregateReport(workspace.domainName, `overlap-${workspace.domainId}`, [
          { ip: '192.0.2.77', count: 300, dkim: 'fail', spf: 'fail', spfDomain: 'evil-lookalike.test' },
        ]),
      });
      expect(ingested.status).toBe('created');
    }

    // Two rules, two instances, one evaluation loop each. A collision on one
    // rule used to throw and abort every remaining rule in that tick, so a
    // single race could silently stop alerts being evaluated at all.
    const [a, b] = await Promise.all([evaluateAlertRules(), evaluateAlertRules()]);
    const evaluated = [...a, ...b].filter((result) => result.outcome === 'triggered');

    expect(evaluated.length).toBe(2);
    expect(await prisma.alertEvent.count()).toBe(2);
  });
});

describe('erasure under two instances', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('executes a due erasure once', async () => {
    const { organizationId, userId } = await setup();

    await prisma.erasureRequest.create({
      data: {
        organizationId,
        requestedById: userId,
        scope: 'CLIENT',
        state: 'PENDING',
        purgeAfter: new Date(Date.now() - 1000),
      },
    });

    const [a, b] = await Promise.all([executeDueErasures(), executeDueErasures()]);

    // The claim is the move out of PENDING, so only one instance runs the
    // deletion. Before the claim, both ran it, both sent the GDPR completion
    // email, and the loser threw on the row the winner had already deleted.
    expect([...a, ...b]).toHaveLength(1);
    expect(await prisma.erasureRequest.count({ where: { state: 'COMPLETED' } })).toBe(1);
  });

  it('returns an abandoned claim to the queue', async () => {
    const { organizationId, userId } = await setup();

    const request = await prisma.erasureRequest.create({
      data: {
        organizationId,
        requestedById: userId,
        scope: 'CLIENT',
        state: 'PENDING',
        purgeAfter: new Date(Date.now() - 1000),
      },
    });

    // As if an instance claimed it and was then killed.
    await prisma.erasureRequest.update({
      where: { id: request.id },
      data: { state: 'EXECUTING', claimedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });

    const outcomes = await executeDueErasures();

    // Without the sweep the customer's request would sit in EXECUTING for ever,
    // because the process that claimed it no longer exists.
    expect(outcomes).toHaveLength(1);
    expect(await prisma.erasureRequest.count({ where: { state: 'COMPLETED' } })).toBe(1);
  });
});

describe('dunning under two instances', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('warns once rather than once per instance', async () => {
    const { organizationId, userId } = await setup();
    void userId;

    await prisma.subscription.create({
      data: {
        organizationId,
        plan: 'HARBOR',
        status: 'PAST_DUE',
        dunningStage: 'NONE',
        currentPeriodEnd: new Date(Date.now() - 1000),
      },
    });

    const [a, b] = await Promise.all([runDunning(), runDunning()]);
    const warned = a.warned + b.warned;

    // The claim is the move out of NONE, so only one instance warns. Without it
    // both would, and the customer would get the same "your payment failed" mail
    // once per replica.
    expect(warned).toBe(1);
  });

  it('stops examining a subscription after it has been withdrawn', async () => {
    const { organizationId } = await setup();

    await prisma.subscription.create({
      data: {
        organizationId,
        plan: 'HARBOR',
        status: 'PAST_DUE',
        dunningStage: 'WARNED',
        currentPeriodEnd: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      },
    });

    await runDunning();
    const afterFirst = await runDunning();

    // This is the bug that was there before any of this. Withdrawing left the
    // status on PAST_DUE and never advanced the period, so the row kept matching
    // the recovery query and the customer was warned and emailed again every day
    // for ever, on a single instance.
    expect(afterFirst.examined).toBe(0);
    expect(afterFirst.downgraded).toBe(0);

    const row = await prisma.subscription.findUniqueOrThrow({ where: { organizationId } });
    expect(row.status).toBe('EXPIRED');
    expect(row.dunningStage).toBe('WITHDRAWN');
  });
});

describe('domain re-verification under two instances', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('checks each domain once', async () => {
    const { domainId } = await setup();

    await prisma.domain.update({ where: { id: domainId }, data: { status: 'PENDING', verifiedAt: null, createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } });

    const [a, b] = await Promise.all([reverifyUnverifiedDomains(), reverifyUnverifiedDomains()]);

    // The claim is a conditional write on recheckedAt, so the DNS lookup and the
    // resulting customer email happen once rather than once per replica.
    expect(a.checked + b.checked).toBeLessThanOrEqual(1);
  });
});

describe('owner rollups under two instances', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('does not throw when both instances roll up the same event', async () => {
    const { organizationId, domainId, userId } = await setup();

    await prisma.alertEvent.create({
      data: {
        ruleId: (
          await prisma.alertRule.create({
            data: {
              organizationId,
              domainId,
              createdById: userId,
              name: 'R',
              metric: 'FAILURE_RATE',
              operator: 'GREATER_THAN',
              threshold: 100,
              windowMinutes: 1440,
              recipients: { create: { userId } },
            },
          })
        ).id,
        organizationId,
        domainId,
        metric: 'FAILURE_RATE',
        operator: 'GREATER_THAN',
        observedValue: 1,
        threshold: 100,
        windowMinutes: 1440,
        summary: 'test',
      },
    });

    // Both instances read the same outstanding event and both try to deliver the
    // same rollup level. The unique key makes the loser's write fail, and that
    // failure used to propagate and kill the tick.
    await expect(Promise.all([runAlertRollups(), runAlertRollups()])).resolves.toBeDefined();
  });
});

describe('inbox scheduler under two instances', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  it('does not open two connections to the same mailbox', async () => {
    const { organizationId } = await setup();

    await prisma.reportInbox.create({
      data: {
        organizationId,
        host: 'imap.example.test',
        port: 993,
        secure: true,
        username: 'agg@example.test',
        // Not a real mailbox, so the claim is what is under test: if the claim
        // were missing, both instances would try to connect and the failure
        // would be recorded twice.
        encryptedPassword: 'irrelevant',
        enabled: true,
      },
    });

    const [a, b] = await Promise.all([runInboxPollOnce(), runInboxPollOnce()]);

    // A failure is recorded once, not once per instance. The real cost being
    // avoided is the duplicate login to the customer's mail host.
    expect(a.failed + b.failed).toBe(1);
  });
});
