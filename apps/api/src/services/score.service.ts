import type {
  DkimResult,
  DmarcResult,
  MxResult,
  ScoreBreakdown,
  ScoreFactor,
  SpfResult,
} from '../models/scan.model.js';

function addFactor(factors: ScoreFactor[], code: string, label: string, points: number, description: string): void {
  factors.push({ code, label, points, description });
}

export function calculateScore(
  dmarc: DmarcResult,
  spf: SpfResult,
  dkim: DkimResult,
  mx: MxResult,
): ScoreBreakdown {
  const factors: ScoreFactor[] = [];

  if (dmarc.status === 'missing') {
    addFactor(factors, 'dmarc_missing', 'DMARC missing', -35, 'No DMARC policy tells receivers how to handle failed authentication.');
  }
  if (dmarc.status === 'error') {
    addFactor(factors, 'dmarc_invalid', 'DMARC invalid', -30, 'The DMARC record is duplicated or contains invalid values.');
  }
  if (dmarc.status === 'found' && dmarc.policy === 'none') {
    addFactor(factors, 'dmarc_monitor_only', 'DMARC monitoring only', -15, 'The policy observes failures but does not request quarantine or rejection.');
  }
  if (dmarc.status === 'found' && !dmarc.hasAggregateReports) {
    addFactor(factors, 'dmarc_no_reports', 'No aggregate reports', -10, 'No rua reporting address was found for regular source summaries.');
  }
  if (spf.status === 'missing') {
    addFactor(factors, 'spf_missing', 'SPF missing', -20, 'No SPF record lists authorized sending servers.');
  }
  if (spf.status === 'error') {
    addFactor(factors, 'spf_invalid', 'SPF invalid', -20, 'Multiple or conflicting SPF records were found.');
  }
  if (spf.status === 'found' && spf.lookupCount > 10) {
    addFactor(factors, 'spf_lookup_limit', 'SPF lookup limit', -10, 'The SPF record may exceed the 10 DNS lookup limit.');
  }
  if (dkim.status === 'missing') {
    addFactor(factors, 'dkim_missing', 'DKIM not found', -15, 'No public DKIM key was found for the common selectors checked.');
  }
  if (dkim.status === 'error') {
    addFactor(factors, 'dkim_lookup_error', 'DKIM lookup incomplete', -5, 'One or more DKIM selector lookups could not be completed.');
  }
  if (mx.status === 'missing') {
    addFactor(factors, 'mx_missing', 'MX missing', -5, 'No mail exchanger was found; this may be intentional for sending-only domains.');
  }

  const final = Math.max(0, Math.min(100, 100 + factors.reduce((total, factor) => total + factor.points, 0)));
  return { base: 100, final, factors };
}
