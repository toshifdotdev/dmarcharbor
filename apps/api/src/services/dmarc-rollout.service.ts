export type RolloutPolicy = 'none' | 'quarantine' | 'reject';

export const pctLadder = [5, 10, 25, 50, 100] as const;

export type PctStep = (typeof pctLadder)[number];

export const newSenderWindowDays = 7;

export type NewSenderRisk = 'authenticated' | 'partially-authenticated' | 'unauthenticated';

export function normalizePct(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    return null;
  }

  return parsed;
}

export function readPct(tags: Record<string, string>): number {
  return normalizePct(tags.pct) ?? 100;
}

export function nextPctStep(currentPct: number): PctStep {
  const next = pctLadder.find((step) => step > currentPct);
  return next ?? 100;
}

export function previousPctStep(currentPct: number): PctStep | null {
  const index = pctLadder.findIndex((step) => step === currentPct);
  if (index <= 0) {
    return null;
  }
  return pctLadder[index - 1] ?? null;
}

export interface PctRecommendation {
  currentPct: number;
  recommendedPct: PctStep;
  advancing: boolean;
  reason: string;
  skippedSteps: number;
}

export function recommendPctStep(currentPct: number, policy: RolloutPolicy): PctRecommendation {
  const normalized = normalizePct(currentPct) ?? 100;

  if (policy === 'none') {
    return {
      currentPct: normalized,
      recommendedPct: 100,
      advancing: false,
      reason:
        'p=none only observes and never acts on failures, so pct=100 is safe. Use pct on this record only after moving to p=quarantine.',
      skippedSteps: 0,
    };
  }

  if (normalized >= 100) {
    return {
      currentPct: normalized,
      recommendedPct: 100,
      advancing: false,
      reason: 'Enforcement is already applied to all mail. Hold at pct=100 and watch for new sending services.',
      skippedSteps: 0,
    };
  }

  const recommended = nextPctStep(normalized);
  const skipped = pctLadder.filter((step) => step > normalized && step < recommended).length;

  return {
    currentPct: normalized,
    recommendedPct: recommended,
    advancing: recommended > normalized,
    reason:
      `Move to pct=${recommended} so only ${recommended}% of mail is affected. ` +
      'If legitimate mail is rejected, receivers fall back to treating the rest as pass, so watch delivery before the next step.',
    skippedSteps: skipped,
  };
}

export function pctNotes(domain: string, policy: RolloutPolicy, pct: number): string[] {
  const notes = [
    `Create a TXT record on ${domain} at the host _dmarc.${domain}.`,
    'Start with p=none. It only observes and never blocks or quarantines mail.',
  ];

  if (policy === 'none') {
    notes.push('pct has no effect while p=none, so it is left out of this record.');
    return notes;
  }

  if (pct >= 100) {
    notes.push('pct is left out because 100 is the default, which applies the policy to all mail.');
    return notes;
  }

  notes.push(
    `pct=${pct} applies p=${policy} to ${pct}% of mail. The other ${100 - pct}% is treated as pass, so a mistake cannot block everything at once.`,
    'Move up one step at a time: 5, then 10, 25, 50, then 100.',
    'Watch delivery and the senders list at each step. Roll back to the previous pct immediately if legitimate mail is rejected.',
  );

  return notes;
}

export function classifyNewSenderRisk(dkimPass: boolean, spfPass: boolean): NewSenderRisk {
  if (dkimPass && spfPass) {
    return 'authenticated';
  }
  if (dkimPass || spfPass) {
    return 'partially-authenticated';
  }
  return 'unauthenticated';
}
