/**
 * How a domain moves to enforcement, per RFC 9989 (May 2026).
 *
 * This used to be a pct ladder (5, 10, 25, 50, 100). RFC 9989 retired pct:
 * receivers that follow it ignore the tag, so "pct=5" now applies the whole
 * policy at those receivers while older ones apply it to 5%. Recommending a
 * pct step therefore means recommending a record that does two different
 * things. What the standard gives instead:
 *
 * - Section 7.4: a domain heading for p=reject should publish p=none for at
 *   least a month, then p=quarantine for an equally long period, comparing the
 *   message dispositions in the reports before it moves on.
 * - Section 7.4: a domain at p=reject MUST NOT rely on SPF alone and MUST
 *   apply valid DKIM signatures, because forwarding breaks SPF.
 * - Section 7.4: domains whose users post to mailing lists SHOULD NOT publish
 *   p=reject.
 * - Section 4.7 and appendix A.6: t=y is testing mode, the analogue of pct=0.
 *   Receivers apply the policy one level softer while it is published.
 */

export type RolloutPolicy = 'none' | 'quarantine' | 'reject';

/** RFC 9989 section 7.4: "at least a month" at each stage before the next. */
export const enforcementStageDays = 30;

export const newSenderWindowDays = 7;

export type NewSenderRisk = 'authenticated' | 'partially-authenticated' | 'unauthenticated';

export interface PolicyStageRecommendation {
  /** The p the domain publishes now ('unknown' before a record exists). */
  publishedPolicy: RolloutPolicy | 'unknown';
  /** t=y is published. */
  testing: boolean;
  /** Retired tags still in the record (pct, rf, ri). */
  historicTags: string[];
  /** The next record to publish, or null when there is no further step. */
  next: { policy: RolloutPolicy; testing: boolean } | null;
  /** Whether the readiness checks allow taking `next` now. */
  advancing: boolean;
  reason: string;
  /** What the standard says to check that this product cannot see. */
  cautions: string[];
}

const rejectCautions = [
  'Every service that sends as this domain must sign with DKIM: a domain at p=reject must not rely on SPF alone, because forwarding breaks SPF (RFC 9989 section 7.4).',
  'If people at this domain post to mailing lists, RFC 9989 section 7.4 advises against p=reject: list mail would be refused at other receivers. p=quarantine is the recommended end point for such domains.',
];

export function recommendPolicyStage(input: {
  publishedPolicy: RolloutPolicy | 'unknown';
  testing: boolean;
  historicTags: string[];
  /** From the readiness assessment: the strongest policy the evidence supports now. */
  readyFor: RolloutPolicy;
}): PolicyStageRecommendation {
  const { publishedPolicy, testing, historicTags, readyFor } = input;
  const base = { publishedPolicy, testing, historicTags };
  const retired =
    historicTags.length > 0
      ? [`Remove ${historicTags.join(', ')} from the record: RFC 9989 retired ${historicTags.length === 1 ? 'it' : 'them'}, and receivers that follow it ignore ${historicTags.length === 1 ? 'it' : 'them'}.`]
      : [];

  if (publishedPolicy === 'unknown' || publishedPolicy === 'none') {
    return {
      ...base,
      next: { policy: 'quarantine', testing: false },
      advancing: readyFor !== 'none',
      reason:
        readyFor !== 'none'
          ? 'The reports support moving to p=quarantine. Hold it for at least as long as p=none was held, comparing dispositions in the reports, before considering p=reject (RFC 9989 section 7.4).'
          : `Stay at p=none while reports arrive: RFC 9989 section 7.4 asks for at least a month (${enforcementStageDays} days) of monitoring, with every legitimate sender passing, before p=quarantine.`,
      cautions: retired,
    };
  }

  if (testing) {
    return {
      ...base,
      next: { policy: publishedPolicy, testing: false },
      advancing: readyFor !== 'none',
      reason: `t=y is published, so receivers that follow RFC 9989 handle failing mail one level softer than p=${publishedPolicy}. Remove t=y to apply p=${publishedPolicy} once the reports show every legitimate sender passing.`,
      cautions: [...retired, ...(publishedPolicy === 'reject' ? rejectCautions : [])],
    };
  }

  if (publishedPolicy === 'quarantine') {
    return {
      ...base,
      next: { policy: 'reject', testing: false },
      advancing: readyFor === 'reject',
      reason:
        readyFor === 'reject'
          ? 'The reports support p=reject: quarantine has been held long enough and DKIM covers the mail.'
          : `Hold p=quarantine for at least ${enforcementStageDays} days and compare dispositions in the reports before p=reject (RFC 9989 section 7.4).`,
      cautions: [...retired, ...rejectCautions],
    };
  }

  return {
    ...base,
    next: null,
    advancing: false,
    reason: 'p=reject is the strongest policy. Watch the reports for new sending services, which will fail until they are authenticated.',
    cautions: retired,
  };
}

/** Setup notes for a generated record, in the order a person needs them. */
export function recordNotes(
  domain: string,
  policy: RolloutPolicy,
  options: { testing: boolean; nonExistentSubdomains: RolloutPolicy | null },
): string[] {
  const notes = [`Create a TXT record on ${domain} at the host _dmarc.${domain}. A domain can have only one: replace any DMARC record already there.`];

  if (policy === 'none') {
    notes.push(
      'p=none is monitoring mode: reports arrive and no mail is blocked or quarantined (RFC 9989 section 5.1.4).',
      `Keep it for at least ${enforcementStageDays} days, and until every legitimate sender passes, before moving to p=quarantine (RFC 9989 section 7.4).`,
    );
  } else if (policy === 'quarantine') {
    notes.push(
      'p=quarantine asks receivers to treat failing mail as suspicious, usually by sending it to spam.',
      `Hold it for at least as long as p=none was held, at least ${enforcementStageDays} days, and compare dispositions in the reports before p=reject (RFC 9989 section 7.4).`,
    );
  } else {
    notes.push('p=reject asks receivers to refuse failing mail.', ...rejectCautions);
  }

  if (options.testing && policy !== 'none') {
    notes.push(
      `t=y is testing mode (RFC 9989 section 4.7): receivers that follow RFC 9989 handle failing mail one level softer, ${policy === 'reject' ? 'as quarantine' : 'as none'}, while reports keep arriving.`,
      'pct=0 is included only for receivers still on RFC 7489, which ignore t: for them it has the same meaning. Remove both tags together to apply the policy.',
    );
  }

  if (options.nonExistentSubdomains) {
    notes.push(
      `np=${options.nonExistentSubdomains} sets the policy for subdomains that do not exist in DNS, which send no legitimate mail. Receivers still on RFC 7489 ignore np and apply p.`,
    );
  }

  notes.push('pct is not used: RFC 9989 retired it, so it no longer means the same thing at every receiver.');
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
