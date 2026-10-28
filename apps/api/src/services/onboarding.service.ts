import { prisma } from '../database/prisma.js';
import { env } from '../config/env.js';
import { hasAggregateReporting, readDmarcRecord } from '../scanner/dmarc-tags.js';
import { clientAggregateAddress, isOurAddress } from './report-address.service.js';
import { getDomainInsights, type DomainInsights } from './report-intelligence.service.js';
import { newSenderBlockers, senderBlockers } from './sender-breakdown.service.js';
import { domainRef } from './domain-ref.js';
import {
  enforcementStageDays,
  recommendPolicyStage,
  recordNotes,
  type PolicyStageRecommendation,
} from './dmarc-rollout.service.js';
import { historicDmarcTags } from '../scanner/dmarc-policy.js';
import { tlsRecordForDomain, type TlsRecordView } from './tls-report/record.js';

export type DmarcPolicyChoice = 'none' | 'quarantine' | 'reject';
export type ReadinessLevel = 'none' | 'quarantine' | 'reject';

/**
 * When the evidence supports the next policy.
 *
 * The day counts follow RFC 9989 section 7.4: at least a month at p=none, then
 * an equally long period at p=quarantine, before p=reject. They were 7 days of
 * reporting for either step. DKIM coverage is its own gate for reject, because
 * the same section says a domain at p=reject must not rely on SPF alone.
 */
export const readinessThresholds = {
  minimumDaysObserved: enforcementStageDays,
  minimumDaysAtQuarantine: enforcementStageDays,
  minimumMessages: 1_000,
  quarantinePassRatePercent: 95,
  rejectPassRatePercent: 99,
  rejectDkimPassRatePercent: 99,
} as const;

const policyOrder: Record<ReadinessLevel | 'unknown', number> = {
  none: 0,
  unknown: 0,
  quarantine: 1,
  reject: 2,
};

export function currentPolicyLevel(policy: string | null | undefined): ReadinessLevel | 'unknown' {
  const value = (policy ?? '').trim().toLowerCase();
  return value === 'none' || value === 'quarantine' || value === 'reject' ? value : 'unknown';
}

export interface DmarcRecordDraft {
  host: string;
  type: 'TXT';
  value: string;
  policy: DmarcPolicyChoice;
  /** t=y (with pct=0 for RFC 7489 receivers) is in the record. */
  testing: boolean;
  /** The np= value, or null when the record leaves non-existent subdomains to p. */
  nonExistentSubdomains: DmarcPolicyChoice | null;
  aggregateAddress: string;
  forensicAddress: string | null;
  notes: string[];
}

export type StepStatus = 'done' | 'pending' | 'blocked' | 'optional';

export interface OnboardingStep {
  id: string;
  title: string;
  status: StepStatus;
  detail: string;
}

export type OnboardingState =
  | 'ADDED'
  | 'AWAITING_VERIFICATION'
  | 'AWAITING_DMARC_RECORD'
  | 'AWAITING_REPORTS'
  | 'MONITORING'
  | 'NEEDS_ATTENTION';

export interface OnboardingState_ {
  state: OnboardingState;
  completedSteps: number;
  totalSteps: number;
  steps: OnboardingStep[];
  recommendedPolicy: ReadinessLevel;
  readiness: PolicyReadiness;
}

export interface PolicyReadiness {
  level: ReadinessLevel;
  ready: boolean;
  currentPolicy: ReadinessLevel | 'unknown';
  /** t=y is published, so the current policy is applied one level softer. */
  testing: boolean;
  daysObserved: number;
  /**
   * Days the reports show the current p in force, back to the last report
   * that showed a different one. What the stage rules of RFC 9989 section 7.4
   * are measured in.
   */
  daysAtCurrentPolicy: number;
  dkimPassRatePercent: number | null;
  messagesObserved: number;
  passRatePercent: number | null;
  openAlerts: number;
  staleAlerts: number;
  failingSenders: number;
  observedSenders: number;
  blockers: string[];
  /**
   * What stands between the domain and each enforcing policy, separately.
   *
   * `blockers` describes the next step the evidence supports, which is not
   * always the step someone asks for: a domain ready for quarantine has no
   * `blockers`, yet a jump straight to reject skips the quarantine stage.
   * A requested change is checked against its own level here.
   */
  blockersByLevel: { quarantine: string[]; reject: string[] };
}

/** The level whose blockers apply to a requested policy, as receivers apply it (t=y is one softer). */
export function enforcementLevelOf(policy: ReadinessLevel, testing: boolean): ReadinessLevel {
  if (policy === 'reject') return testing ? 'quarantine' : 'reject';
  if (policy === 'quarantine') return testing ? 'none' : 'quarantine';
  return 'none';
}

function daySpan(from: Date | null, to: Date): number {
  if (!from) {
    return 0;
  }
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * Days the reports show `policy` in force: from the newest report back to the
 * first one after a report that showed a different p. Reports without a
 * policy are skipped rather than counted either way.
 */
export function daysAtPolicy(
  reports: Array<{ policyP: string | null; dateRangeBegin: Date | null; dateRangeEnd: Date | null }>,
  policy: ReadinessLevel | 'unknown',
): number {
  if (policy === 'unknown') {
    return 0;
  }
  let earliest: Date | null = null;
  let latest: Date | null = null;
  for (const report of reports) {
    const published = report.policyP?.trim().toLowerCase();
    if (!published) {
      continue;
    }
    if (published !== policy) {
      break;
    }
    const begin = report.dateRangeBegin ?? report.dateRangeEnd;
    if (begin && (!earliest || begin < earliest)) {
      earliest = begin;
    }
    if (report.dateRangeEnd && (!latest || report.dateRangeEnd > latest)) {
      latest = report.dateRangeEnd;
    }
  }
  return earliest && latest ? daySpan(earliest, latest) : 0;
}

/**
 * The DMARC record to publish, written to RFC 9989.
 *
 * No pct: RFC 9989 retired it, so a pct value now means the whole policy at
 * receivers that follow RFC 9989 and a share of it at the rest. Testing a
 * policy is `testing`, which writes t=y and, for receivers still on RFC 7489
 * that ignore t, pct=0: the two mean the same thing (RFC 9989 appendix A.6),
 * so the record behaves the same at both generations of receiver. t=y has no
 * effect on p=none and is left out there.
 */
export function buildDmarcRecord(
  domain: string,
  policy: DmarcPolicyChoice,
  includeForensics: boolean,
  options: {
    testing?: boolean;
    nonExistentSubdomains?: DmarcPolicyChoice | null;
    /** The client's report address. Defaults to the shared address. */
    aggregateAddress?: string;
  } = {},
): DmarcRecordDraft {
  const testing = policy !== 'none' && options.testing === true;
  const nonExistentSubdomains = options.nonExistentSubdomains ?? null;
  const aggregateAddress = options.aggregateAddress ?? env.REPORT_AGGREGATE_ADDRESS;

  const parts = [
    'v=DMARC1',
    `p=${policy}`,
    `rua=mailto:${aggregateAddress}`,
  ];

  if (nonExistentSubdomains) {
    parts.push(`np=${nonExistentSubdomains}`);
  }

  if (testing) {
    parts.push('t=y', 'pct=0');
  }

  if (includeForensics) {
    parts.push(`ruf=mailto:${env.REPORT_FORENSIC_ADDRESS}`);
  }

  const notes = recordNotes(domain, policy, { testing, nonExistentSubdomains });

  if (includeForensics) {
    notes.push(
      'The ruf= tag sends per-message forensic reports that can contain personal data. DMARC Harbor stores recipient addresses only if the domain owner explicitly enables it.',
    );
  }

  return {
    host: `_dmarc.${domain}`,
    type: 'TXT',
    value: parts.join('; '),
    policy,
    testing,
    nonExistentSubdomains,
    aggregateAddress,
    forensicAddress: includeForensics ? env.REPORT_FORENSIC_ADDRESS : null,
    notes,
  };
}

export async function assessPolicyReadiness(
  organizationId: string,
  domainId: string,
  insights?: DomainInsights | null,
): Promise<PolicyReadiness> {
  const resolved = insights ?? (await getDomainInsights(organizationId, domainId));
  if (!resolved) {
    throw new Error('Domain not found.');
  }

  // Counted on the resolved id: `domainId` may be the slug, and alert events
  // key on id, so a slug here counted zero open alerts.
  const resolvedId = resolved.domain.id;
  const [openAlerts, staleAlerts] = await Promise.all([
    prisma.alertEvent.count({ where: { domainId: resolvedId, acknowledgedAt: null, resolvedAt: null, staleAt: null } }),
    prisma.alertEvent.count({ where: { domainId: resolvedId, staleAt: { not: null }, acknowledgedAt: null, resolvedAt: null } }),
  ]);

  const messagesObserved = resolved.aggregate.messageCount;
  const passRatePercent = resolved.aggregate.dmarcPassRate;
  const dkimPassRatePercent = resolved.aggregate.dkimPassRate;
  const daysObserved = daySpan(
    resolved.aggregate.messageWindow.begin ? new Date(resolved.aggregate.messageWindow.begin) : null,
    resolved.aggregate.messageWindow.end ? new Date(resolved.aggregate.messageWindow.end) : new Date(),
  );

  const currentPolicy = currentPolicyLevel(resolved.reporting.publishedPolicy);
  const [record, policyHistory] = await Promise.all([
    prisma.domain.findUnique({ where: { id: resolvedId }, select: { dmarcRecord: true } }),
    prisma.dmarcReport.findMany({
      where: { domainId: resolvedId, dateRangeEnd: { not: null } },
      select: { policyP: true, dateRangeBegin: true, dateRangeEnd: true },
      orderBy: { dateRangeEnd: 'desc' },
      take: 1_000,
    }),
  ]);
  const testing = readDmarcRecord(record?.dmarcRecord).tags.t?.trim().toLowerCase() === 'y';
  const daysAtCurrentPolicy = daysAtPolicy(policyHistory, currentPolicy);
  const senders = resolved.senders ?? [];
  const failingSenders = senders.filter((sender) => sender.status === 'failing');
  const observedSenders = senders.filter((sender) => sender.hasEnoughSignal).length;

  const evaluate = (level: ReadinessLevel): string[] => {
    const blockers: string[] = [];
    const requiredPassRate =
      level === 'reject' ? readinessThresholds.rejectPassRatePercent : readinessThresholds.quarantinePassRatePercent;

    if (messagesObserved < readinessThresholds.minimumMessages) {
      blockers.push(
        `Only ${messagesObserved} messages observed. At least ${readinessThresholds.minimumMessages} are needed before changing policy.`,
      );
    }

    if (daysObserved < readinessThresholds.minimumDaysObserved) {
      blockers.push(
        `Only ${daysObserved} days of reporting observed. RFC 9989 section 7.4 asks for at least a month (${readinessThresholds.minimumDaysObserved} days) of monitoring before enforcement.`,
      );
    }

    if (passRatePercent === null) {
      blockers.push('No DMARC results have been observed yet.');
    } else {
      const failureRate = Math.round((100 - passRatePercent) * 100) / 100;
      if (failureRate > 100 - requiredPassRate) {
        blockers.push(
          `DMARC pass rate is ${passRatePercent}%. At least ${requiredPassRate}% is required for p=${level}.`,
        );
      }
    }

    if (observedSenders > 0) {
      blockers.push(...senderBlockers(failingSenders));
      blockers.push(...newSenderBlockers(senders));
    }

    if (openAlerts > 0) {
      blockers.push(`${openAlerts} alert(s) are still open on this domain.`);
    }

    if (staleAlerts > 0) {
      blockers.push(`${staleAlerts} alert(s) have gone stale and need review.`);
    }

    if (policyOrder[currentPolicy] >= policyOrder[level] && !(testing && currentPolicy === level)) {
      blockers.push(`The domain already publishes p=${currentPolicy}.`);
    }

    if (level === 'reject') {
      if (policyOrder[currentPolicy] < policyOrder.quarantine) {
        blockers.push(
          'The domain is not on p=quarantine yet. RFC 9989 section 7.4 moves in stages: p=none, then p=quarantine for at least as long, then p=reject.',
        );
      } else if (currentPolicy === 'quarantine') {
        if (testing) {
          blockers.push('p=quarantine is still in testing mode (t=y), so receivers are not applying it yet. Remove t=y and hold quarantine before p=reject.');
        } else if (daysAtCurrentPolicy < readinessThresholds.minimumDaysAtQuarantine) {
          blockers.push(
            `The reports show p=quarantine in force for ${daysAtCurrentPolicy} days. RFC 9989 section 7.4 asks for at least ${readinessThresholds.minimumDaysAtQuarantine} at quarantine, comparing dispositions, before p=reject.`,
          );
        }
      }

      if (dkimPassRatePercent !== null && dkimPassRatePercent < readinessThresholds.rejectDkimPassRatePercent) {
        blockers.push(
          `Only ${dkimPassRatePercent}% of mail passed DKIM. A domain at p=reject must sign with DKIM rather than rely on SPF alone, because forwarding breaks SPF (RFC 9989 section 7.4); at least ${readinessThresholds.rejectDkimPassRatePercent}% is required.`,
        );
      }
    }

    return blockers;
  };

  const rejectBlockers = evaluate('reject');
  const quarantineBlockers = evaluate('quarantine');

  let level: ReadinessLevel = 'none';
  if (rejectBlockers.length === 0) {
    level = 'reject';
  } else if (quarantineBlockers.length === 0) {
    level = 'quarantine';
  }

  // When nothing is ready, report what blocks the next stage: for a domain
  // already enforcing quarantine that is reject, not "already publishes
  // p=quarantine".
  const blockers =
    level === 'reject'
      ? rejectBlockers
      : level === 'quarantine'
        ? quarantineBlockers
        : currentPolicy === 'quarantine' && !testing
          ? [...rejectBlockers]
          : [...quarantineBlockers];

  return {
    level,
    ready: level !== 'none',
    currentPolicy,
    testing,
    daysObserved,
    daysAtCurrentPolicy,
    dkimPassRatePercent,
    messagesObserved,
    passRatePercent,
    openAlerts,
    staleAlerts,
    failingSenders: failingSenders.length,
    observedSenders,
    blockers,
    blockersByLevel: { quarantine: quarantineBlockers, reject: rejectBlockers },
  };
}

export interface OnboardingResult extends OnboardingState_ {
  domain: { id: string; slug: string; name: string; status: string; score: number | null; dmarcPolicy: string | null };
  reporting: {
    publishedPolicy: string | null;
    /** t=y is published (RFC 9989 testing mode). */
    publishedTesting: boolean;
    /** Retired tags still in the published record (pct, rf, ri). */
    historicTags: string[];
    aggregateConfigured: boolean;
    forensicConfigured: boolean;
    collectionEnabled: boolean;
    identityRetentionEnabled: boolean;
  };
  /** The next policy stage, per RFC 9989 section 7.4. Replaces the retired pct ladder. */
  rollout: PolicyStageRecommendation;
  suggestedRecord: DmarcRecordDraft;
  /** The TLS-RPT record to publish, shown beside the DMARC suggestion. */
  tlsRpt: TlsRecordView;
}

export async function getOnboardingState(organizationId: string, domainId: string): Promise<OnboardingResult | null> {
  const domain = await prisma.domain.findFirst({
    where: { client: { organizationId }, ...domainRef(domainId) },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      score: true,
      dmarcPolicy: true,
      dmarcRecord: true,
      collectForensicReports: true,
      retainForensicPii: true,
      client: { select: { reportToken: true } },
    },
  });

  if (!domain) {
    return null;
  }

  const insights = await getDomainInsights(organizationId, domainId);
  const readiness = await assessPolicyReadiness(organizationId, domainId, insights);
  const tags = readDmarcRecord(domain.dmarcRecord);
  const verified = domain.status === 'VERIFIED';
  const dmarcPublished = tags.tags.v?.toLowerCase() === 'dmarc1';
  const aggregateConfigured = hasAggregateReporting(tags);
  /**
   * A mailto target is not proof that reports reach us.
   *
   * The old check was `rua` has any mailto, which called an incumbent's address
   * ours: the customer was told reports would be delivered while every report
   * went to a competitor. Ours is now recognised by address, and two pieces of
   * contrary evidence still count: a configured report inbox means the address
   * is reachable, and reports already received prove it is working.
   */
  const clientAddress = clientAggregateAddress(domain.client.reportToken);
  const aggregateCollectableByAddress = tags.aggregateMailtoTargets.some((target) => isOurAddress(target));
  const reportsReceived = (insights?.aggregate.reportCount ?? 0) > 0;
  const inboxEnabled =
    tags.aggregateMailtoTargets.length > 0 && !aggregateCollectableByAddress && !reportsReceived
      ? Boolean(await prisma.reportInbox.findFirst({ where: { organizationId, enabled: true }, select: { id: true } }))
      : false;
  const aggregateCollectable = aggregateCollectableByAddress || inboxEnabled || reportsReceived;
  const aggregateWebOnly =
    tags.aggregateMailtoTargets.length === 0 && tags.aggregateWebTargets.length > 0 && !aggregateCollectable;
  const foreignMailtoHosts = [
    ...new Set(
      tags.aggregateMailtoTargets
        .map((target) => target.split('@').pop())
        .filter((host): host is string => Boolean(host)),
    ),
  ];
  const foreignMailtoDetail = `The record sends reports to ${foreignMailtoHosts.join(', ')} but not to DMARC Harbor. Add ${clientAddress} to rua, or start a switch from the domain page.`;
  const forensicConfigured = tags.forensicTargets.length > 0;
  const openAlerts = readiness.openAlerts + readiness.staleAlerts;
  const historicTags = historicDmarcTags.filter((tag) => tags.tags[tag] !== undefined);
  const rollout = recommendPolicyStage({
    publishedPolicy: dmarcPublished ? currentPolicyLevel(tags.tags.p) : 'unknown',
    testing: readiness.testing,
    historicTags,
    readyFor: readiness.level,
  });

  const steps: OnboardingStep[] = [
    {
      id: 'domain_verified',
      title: 'Verify domain ownership',
      status: verified ? 'done' : 'pending',
      detail: verified
        ? 'Ownership is verified through a DNS TXT record.'
        : 'Publish the ownership TXT record, then run verification.',
    },
    {
      id: 'dmarc_published',
      title: 'Publish a DMARC record',
      status: !verified ? 'blocked' : dmarcPublished ? 'done' : 'pending',
      detail: dmarcPublished
        ? `A DMARC record is published with p=${domain.dmarcPolicy ?? 'unknown'}.`
        : 'Publish the generated TXT record at _dmarc with p=none to begin monitoring.',
    },
    {
      id: 'aggregate_reporting',
      title: 'Receive aggregate reports',
      status: !verified
        ? 'blocked'
        : !dmarcPublished
          ? 'blocked'
          : aggregateCollectable
            ? 'done'
            : 'pending',
      detail: aggregateCollectable
        ? reportsReceived
          ? 'Aggregate reports have already been received for this domain.'
          : aggregateCollectableByAddress
            ? 'The record includes our rua=mailto: address, so reports will be delivered to DMARC Harbor.'
            : `The record sends reports to ${foreignMailtoHosts.join(', ')}, and this workspace collects reports from its own mailbox.`
        : aggregateWebOnly
          ? 'This domain publishes reports to a web endpoint rather than a mailbox. DMARC Harbor does not read reports from there yet, so nothing will arrive for this domain until that is arranged.'
          : tags.aggregateMailtoTargets.length > 0
            ? foreignMailtoDetail
            : 'The record has no rua= tag, so no reports will arrive.',
    },
    {
      id: 'reports_flowing',
      title: 'Receive first report',
      status: !verified || !aggregateCollectable
        ? 'blocked'
        : reportsReceived
          ? 'done'
          : 'pending',
      detail: reportsReceived
        ? `${insights?.aggregate.reportCount} aggregate report(s) received.`
        : aggregateWebOnly || (tags.aggregateMailtoTargets.length > 0 && !aggregateCollectable)
          ? 'Waiting cannot help until reports are published somewhere DMARC Harbor can read them.'
          : 'Reports usually arrive within 24 to 48 hours of publishing the record.',
    },
    {
      id: 'forensic_optional',
      title: 'Enable forensic reporting',
      status: !verified || !dmarcPublished ? 'blocked' : forensicConfigured ? 'done' : 'optional',
      detail: forensicConfigured
        ? domain.collectForensicReports
          ? 'Forensic reports are collected with pseudonymous recipients.'
          : 'The record includes ruf=, but collection is switched off for this domain.'
        : 'Optional. Adds per-message failure evidence, which can contain personal data.',
    },
    {
      id: 'policy_tightened',
      title: 'Tighten the policy',
      status: !verified || !aggregateCollectable ? 'blocked' : readiness.ready ? 'done' : 'pending',
      detail: readiness.ready
        ? readiness.testing && readiness.level === readiness.currentPolicy
          ? `Ready to remove t=y and apply p=${readiness.level}.`
          : `Ready to move to p=${readiness.level}.`
        : readiness.blockers[0] ?? 'Keep p=none until the readiness checks pass.',
    },
  ];

  const state: OnboardingState = !verified
    ? 'AWAITING_VERIFICATION'
    : !dmarcPublished
      ? 'AWAITING_DMARC_RECORD'
      : aggregateWebOnly
        ? 'AWAITING_REPORTS'
        : !reportsReceived
          ? 'AWAITING_REPORTS'
          : openAlerts > 0
            ? 'NEEDS_ATTENTION'
            : 'MONITORING';

  const tlsRpt = await tlsRecordForDomain(
    domain.id,
    domain.name,
    domain.client.reportToken,
  );
  steps.splice(steps.length - 1, 0, {
    id: 'tls_reports_optional',
    title: 'Collect TLS reports',
    status: tlsRpt.status === 'ours' ? 'done' : 'optional',
    detail:
      tlsRpt.status === 'ours'
        ? 'TLS-RPT is published; reporters send delivery-failure reports by email.'
        : 'Optional. Publish a TLS-RPT record so senders can tell you why TLS deliveries failed.',
  });

  return {
    domain: {
      id: domain.id,
      slug: domain.slug,
      name: domain.name,
      status: domain.status,
      score: domain.score,
      dmarcPolicy: domain.dmarcPolicy,
    },
    reporting: {
      publishedPolicy: domain.dmarcPolicy,
      publishedTesting: readiness.testing,
      historicTags,
      aggregateConfigured,
      forensicConfigured,
      collectionEnabled: domain.collectForensicReports,
      identityRetentionEnabled: domain.retainForensicPii,
    },
    state,
    completedSteps: steps.filter((step) => step.status === 'done').length,
    totalSteps: steps.length,
    steps,
    recommendedPolicy: readiness.level,
    readiness,
    rollout: rollout,
    suggestedRecord: buildDmarcRecord(domain.name, 'none', !forensicConfigured, {
      aggregateAddress: clientAddress,
    }),
    tlsRpt,
  };
}
