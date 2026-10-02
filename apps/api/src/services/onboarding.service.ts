import { prisma } from '../database/prisma.js';
import { env } from '../config/env.js';
import { canCollectAggregateReports, hasAggregateReporting, readDmarcRecord } from '../scanner/dmarc-tags.js';
import { getDomainInsights, type DomainInsights } from './report-intelligence.service.js';
import { newSenderBlockers, senderBlockers } from './sender-breakdown.service.js';
import { normalizePct, pctNotes, readPct, recommendPctStep, type PctRecommendation } from './dmarc-rollout.service.js';

export type DmarcPolicyChoice = 'none' | 'quarantine' | 'reject';
export type ReadinessLevel = 'none' | 'quarantine' | 'reject';

export const readinessThresholds = {
  minimumDaysObserved: 7,
  minimumMessages: 1_000,
  quarantinePassRatePercent: 95,
  rejectPassRatePercent: 99,
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
  pct: number;
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
  daysObserved: number;
  messagesObserved: number;
  passRatePercent: number | null;
  openAlerts: number;
  staleAlerts: number;
  failingSenders: number;
  observedSenders: number;
  blockers: string[];
}

function daySpan(from: Date | null, to: Date): number {
  if (!from) {
    return 0;
  }
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));
}

function passRateFrom(insights: DomainInsights | null): number | null {
  if (!insights || insights.aggregate.messageCount === 0) {
    return null;
  }

  const spf = insights.aggregate.spfPassRate;
  const dkim = insights.aggregate.dkimPassRate;
  if (spf === null && dkim === null) {
    return null;
  }

  const values = [spf, dkim].filter((value): value is number => value !== null);
  const average = values.reduce((total, value) => total + value, 0) / values.length;
  return Math.round(average * 100) / 100;
}

export function buildDmarcRecord(
  domain: string,
  policy: DmarcPolicyChoice,
  includeForensics: boolean,
  pct?: number,
): DmarcRecordDraft {
  const requestedPct = normalizePct(pct) ?? 100;
  const effectivePct = policy === 'none' ? 100 : requestedPct;

  const parts = [
    'v=DMARC1',
    `p=${policy}`,
    `rua=mailto:${env.REPORT_AGGREGATE_ADDRESS}`,
  ];

  if (policy !== 'none' && effectivePct < 100) {
    parts.push(`pct=${effectivePct}`);
  }

  if (includeForensics) {
    parts.push(`ruf=mailto:${env.REPORT_FORENSIC_ADDRESS}`);
  }

  const notes = pctNotes(domain, policy, effectivePct);

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
    pct: effectivePct,
    aggregateAddress: env.REPORT_AGGREGATE_ADDRESS,
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

  const [openAlerts, staleAlerts] = await Promise.all([
    prisma.alertEvent.count({ where: { domainId, acknowledgedAt: null, resolvedAt: null, staleAt: null } }),
    prisma.alertEvent.count({ where: { domainId, staleAt: { not: null }, acknowledgedAt: null, resolvedAt: null } }),
  ]);

  const messagesObserved = resolved.aggregate.messageCount;
  const passRatePercent = passRateFrom(resolved);
  const daysObserved = daySpan(
    resolved.aggregate.messageWindow.begin ? new Date(resolved.aggregate.messageWindow.begin) : null,
    resolved.aggregate.messageWindow.end ? new Date(resolved.aggregate.messageWindow.end) : new Date(),
  );

  const currentPolicy = currentPolicyLevel(resolved.reporting.publishedPolicy);
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
        `Only ${daysObserved} days of reporting observed. At least ${readinessThresholds.minimumDaysObserved} days are needed.`,
      );
    }

    if (passRatePercent === null) {
      blockers.push('No SPF or DKIM results have been observed yet.');
    } else {
      const failureRate = Math.round((100 - passRatePercent) * 100) / 100;
      if (failureRate > 100 - requiredPassRate) {
        blockers.push(
          `Pass rate is ${passRatePercent}%. At least ${requiredPassRate}% is required for p=${level}.`,
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

    if (policyOrder[currentPolicy] >= policyOrder[level]) {
      blockers.push(`The domain already publishes p=${currentPolicy}.`);
    }

    if (level === 'reject' && policyOrder[currentPolicy] < policyOrder.quarantine) {
      blockers.push(
        'The domain is not on p=quarantine yet. Enforce in stages: move to quarantine, watch a full reporting cycle, then consider reject.',
      );
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

  const blockers = level === 'reject' ? rejectBlockers : level === 'quarantine' ? quarantineBlockers : [...quarantineBlockers];

  return {
    level,
    ready: level !== 'none',
    currentPolicy,
    daysObserved,
    messagesObserved,
    passRatePercent,
    openAlerts,
    staleAlerts,
    failingSenders: failingSenders.length,
    observedSenders,
    blockers,
  };
}

export interface OnboardingResult extends OnboardingState_ {
  domain: { id: string; name: string; status: string; score: number | null; dmarcPolicy: string | null };
  reporting: {
    publishedPolicy: string | null;
    publishedPct: number;
    aggregateConfigured: boolean;
    forensicConfigured: boolean;
    collectionEnabled: boolean;
    identityRetentionEnabled: boolean;
  };
  rollout: PctRecommendation;
  suggestedRecord: DmarcRecordDraft;
}

export async function getOnboardingState(organizationId: string, domainId: string): Promise<OnboardingResult | null> {
  const domain = await prisma.domain.findFirst({
    where: { id: domainId, client: { organizationId } },
    select: {
      id: true,
      name: true,
      status: true,
      score: true,
      dmarcPolicy: true,
      dmarcRecord: true,
      collectForensicReports: true,
      retainForensicPii: true,
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
  // Reporting is configured and reporting reaches us are different facts. A
  // rua=https: record configures reporting we cannot read, and telling the
  // customer on this screen that "reports will be delivered" would be the same
  // false claim the scanner used to make.
  const aggregateCollectable = canCollectAggregateReports(tags);
  const aggregateWebOnly = aggregateConfigured && !aggregateCollectable;
  const forensicConfigured = tags.forensicTargets.length > 0;
  const reportsReceived = (insights?.aggregate.reportCount ?? 0) > 0;
  const openAlerts = readiness.openAlerts + readiness.staleAlerts;
  const publishedPolicy = tags.tags.p?.trim().toLowerCase();
  const rolloutPolicy: DmarcPolicyChoice =
    publishedPolicy === 'quarantine' || publishedPolicy === 'reject' ? publishedPolicy : 'none';
  const rollout: PctRecommendation = recommendPctStep(readPct(tags.tags), rolloutPolicy);

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
        ? 'The record includes a rua=mailto: address, so reports will be delivered to DMARC Harbor.'
        : aggregateWebOnly
          ? 'This domain publishes reports to a web endpoint rather than a mailbox. DMARC Harbor does not read reports from there yet, so nothing will arrive for this domain until that is arranged.'
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
        : aggregateWebOnly
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
        ? `Ready to move to p=${readiness.level}.`
        : readiness.blockers[0] ?? 'Keep p=none until the readiness checks pass.',
    },
    {
      id: 'canary_rollout',
      title: 'Roll out in stages',
      status: !verified || !aggregateCollectable ? 'blocked' : rolloutPolicy === 'none' ? 'blocked' : rollout.advancing ? 'pending' : 'done',
      detail:
        rolloutPolicy === 'none'
          ? 'Once p is above none, use pct to apply the policy to a small share of mail first.'
          : rollout.advancing
            ? rollout.reason
            : 'Enforcement is applied to all mail. Watch for new sending services.',
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

  return {
    domain: {
      id: domain.id,
      name: domain.name,
      status: domain.status,
      score: domain.score,
      dmarcPolicy: domain.dmarcPolicy,
    },
    reporting: {
      publishedPolicy: domain.dmarcPolicy,
      publishedPct: readPct(tags.tags),
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
    suggestedRecord: buildDmarcRecord(domain.name, 'none', !forensicConfigured),
  };
}
