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

  const workspace = await agent.post('/api/workspaces').send({ name: 'Scale Agency', slug: `sc-${Date.now()}-${fixtureId}`, dpaHasRead: true, dpaConfirmsAuthority: true});
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

  /**
   * The concurrent form of this test passed locally against the broken claim and
   * failed on CI, because whether it reproduces depends entirely on whether the two
   * list queries interleave before or after each other's claim. A regression test
   * whose failure depends on that is a coin flip, so the invariant is asserted
   * directly instead: a second pass that starts immediately after a first must find
   * the domain already claimed and refuse it.
   *
   * That is exactly the CI ordering. Its list query landed after the other instance's
   * claim, so it read the freshly written `recheckedAt` and its compare-and-swap
   * matched the very value it was meant to exclude.
   */
  it('refuses a domain another instance claimed moments ago', async () => {
    const { domainId } = await setup();

    await prisma.domain.update({
      where: { id: domainId },
      data: { status: 'PENDING', verifiedAt: null, createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
    });

    const first = await reverifyUnverifiedDomains();
    expect(first.checked).toBe(1);

    /**
     * Immediately after, with no wait.
     *
     * The row is still eligible by the schedule - the domain is three days old and
     * still pending - so the list query returns it again. What must stop it is the
     * claim, not the schedule. Under the old predicate this second call read
     * `recheckedAt` from its own list query, matched it in the CAS, and checked the
     * domain a second time, emailing the customer a second time.
     */
    const second = await reverifyUnverifiedDomains();

    expect(second.checked).toBe(0);
  });

  it('checks each domain once when two passes genuinely overlap', async () => {
    const { domainId } = await setup();

    await prisma.domain.update({
      where: { id: domainId },
      data: { status: 'PENDING', verifiedAt: null, createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
    });

    const [a, b] = await Promise.all([reverifyUnverifiedDomains(), reverifyUnverifiedDomains()]);

    // Kept as well as the deterministic case above, because the overlap is the real
    // production shape and this is the assertion that reads as the requirement.
    expect(a.checked + b.checked).toBeLessThanOrEqual(1);
  });

  it('claims again once the row is genuinely stale, so a domain is never stranded', async () => {
    const { domainId } = await setup();

    await prisma.domain.update({
      where: { id: domainId },
      data: { status: 'PENDING', verifiedAt: null, createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
    });

    expect((await reverifyUnverifiedDomains()).checked).toBe(1);

    /**
     * The other half of the invariant.
     *
     * A window that is safe against overlap but too long would make a domain
     * permanently un-reverifiable: every pass would find the row checked inside the
     * window and skip it. So aged past the window - twenty minutes for an unverified
     * domain - it must be claimable again.
     *
     * Aged five seconds rather than twenty-one minutes is the assertion that matters
     * here, and getting it wrong is what proved the window is genuinely enforced: an
     * earlier version of this test aged by five seconds, failed, and was correct to.
     */
    await prisma.domain.update({
      where: { id: domainId },
      data: { recheckedAt: new Date(Date.now() - 21 * 60 * 1000) },
    });

    expect((await reverifyUnverifiedDomains()).checked).toBe(1);
  });
});

describe('owner rollups under two instances', () => {
  beforeAll(resetDatabase);
  beforeEach(resetDatabase);

  async function outstandingEvent() {
    const { organizationId, domainId, userId } = await setup();

    const rule = await prisma.alertRule.create({
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
    });

    const event = await prisma.alertEvent.create({
      data: {
        ruleId: rule.id,
        organizationId,
        domainId,
        metric: 'FAILURE_RATE',
        operator: 'GREATER_THAN',
        observedValue: 1,
        threshold: 100,
        windowMinutes: 1440,
        summary: 'test',
        // Old enough that the rollup interval has certainly elapsed.
        triggeredAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      },
      select: { id: true },
    });

    return { eventId: event.id, organizationId };
  }

  /**
   * The counter is the escalation level, so a lost increment is a customer who stops
   * being chased one step earlier than they should. It used to be computed in the
   * application and written back, which loses an increment whenever two replicas roll
   * the same event up together.
   *
   * The previous test here only asserted that two concurrent rollups did not throw.
   * That is why the read-modify-write survived: a test that checks for the absence of
   * an exception cannot see a counter that quietly went up by one instead of two.
   */
  it('advances the rollup level by exactly one per rollup, even when two overlap', async () => {
    const { eventId } = await outstandingEvent();

    await Promise.all([runAlertRollups(), runAlertRollups()]);

    const afterFirstPair = await prisma.alertEvent.findUniqueOrThrow({
      where: { id: eventId },
      select: { ownerRollupLevel: true },
    });

    /**
     * One, not two.
     *
     * Whichever replica loses the claim must not have incremented. Under the old code
     * both read 0, both computed 1, and both wrote 1, so this assertion would have
     * passed by accident while the deliveries were duplicated.
     */
    expect(afterFirstPair.ownerRollupLevel).toBe(1);
  });

  it('keeps advancing on later rollups, so escalation is not stuck', async () => {
    const { eventId } = await outstandingEvent();

    await runAlertRollups();

    // Backdate the notification marker so the next rollup is due rather than
    // suppressed by the interval.
    await prisma.alertEvent.update({
      where: { id: eventId },
      data: { lastOwnerNotifiedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    });

    await runAlertRollups();

    const event = await prisma.alertEvent.findUniqueOrThrow({
      where: { id: eventId },
      select: { ownerRollupLevel: true },
    });

    /**
     * Two, having sent two rollups.
     *
     * A fix that stops the duplicate by refusing to increment at all would satisfy the
     * test above and silently disable escalation. This is the half that says the
     * counter still moves.
     */
    expect(event.ownerRollupLevel).toBe(2);
  });

  it('does not throw when both instances roll up the same event', async () => {
    const { eventId } = await outstandingEvent();

    await expect(Promise.all([runAlertRollups(), runAlertRollups()])).resolves.toBeDefined();

    expect(await prisma.alertEvent.count({ where: { id: eventId } })).toBe(1);
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
