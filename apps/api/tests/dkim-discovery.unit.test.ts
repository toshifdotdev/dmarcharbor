import { describe, expect, it } from 'vitest';
import {
  CONVENTION_SELECTORS,
  DKIM_LOOKUP_BUDGET,
  budgetDkimCandidates,
  dkimCandidates,
  spfIncludeTargets,
} from '../src/scanner/dkim-discovery.js';

/**
 * Which DKIM selectors are worth probing.
 *
 * The previous implementation probed twelve hardcoded labels and reported
 * "no common DKIM selector found" when it missed. That is a false negative on a
 * domain with working DKIM, which is worse than finding nothing: the customer is
 * told they are broken when they are not, and the fix is to go looking for a
 * record that is already there.
 *
 * The SPF record names who sends for the domain, and every one of those
 * providers publishes the selectors it uses. That turns evidence already in hand
 * into an accurate answer, so these tests are mostly about whether the derivation
 * reads the SPF record correctly and whether the budget is honest.
 */

describe('reading SPF include targets', () => {
  it('finds every include', () => {
    const spf = 'v=spf1 include:_spf.google.com include:amazonses.com ip4:1.2.3.4 ~all';

    expect(spfIncludeTargets(spf).sort()).toEqual(['_spf.google.com', 'amazonses.com']);
  });

  it('is case insensitive and tolerates macros', () => {
    const spf = 'v=spf1 INCLUDE:_spf.Google.com include:amazonses.com/24 ~all';

    expect(spfIncludeTargets(spf).sort()).toEqual(['_spf.google.com', 'amazonses.com']);
  });

  it('does not confuse other mechanisms with includes', () => {
    const spf = 'v=spf1 a mx ptr exists:%{i}.example.com redirect=_spf.old.com ~all';

    // redirect is not an include, and treating it as one would probe labels for
    // a mechanism that names nothing.
    expect(spfIncludeTargets(spf)).toEqual([]);
  });

  it('copes with no SPF at all', () => {
    expect(spfIncludeTargets(undefined)).toEqual([]);
    expect(spfIncludeTargets(null)).toEqual([]);
    expect(spfIncludeTargets('not an spf record')).toEqual([]);
  });
});

describe('deriving candidates', () => {
  it('probes the label a provider actually publishes', () => {
    const candidates = dkimCandidates('v=spf1 include:_spf.google.com ~all');

    const google = candidates.find((c) => c.selector === 'google');
    expect(google).toBeDefined();
    expect(google?.source).toBe('spf:_spf.google.com');
  });

  it('knows that Mailgun publishes several selectors', () => {
    const candidates = dkimCandidates('v=spf1 include:_spf.mailgun.org ~all');
    const fromMailgun = candidates.filter((c) => c.source === 'spf:_spf.mailgun.org').map((c) => c.selector);

    // k1 alone would have been found by the old convention list. k2 and k3 would
    // not, and a Mailgun setup rotated onto k2 was previously invisible.
    expect(fromMailgun.sort()).toEqual(['k1', 'k2', 'k3']);
  });

  it('keeps evidence ahead of convention so the budget is spent well', () => {
    const candidates = dkimCandidates('v=spf1 include:amazonses.com ~all');

    // amazonses is both a provider mapping and a convention. It must appear once,
    // attributed to the evidence rather than to the guess.
    const matches = candidates.filter((c) => c.selector === 'amazonses');
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe('spf:amazonses.com');
    expect(candidates[0].selector).toBe('amazonses');
  });

  it('never spends a lookup on a label that cannot exist', () => {
    const candidates = dkimCandidates('v=spf1 include:_spf.google.com ~all');

    for (const candidate of candidates) {
      expect(candidate.selector).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
    }
  });

  it('falls back to conventions when SPF names nothing useful', () => {
    const candidates = dkimCandidates('v=spf1 ip4:1.2.3.4 -all');

    expect(candidates.map((c) => c.selector)).toContain('default');
    expect(candidates.every((c) => c.source === 'convention')).toBe(true);
  });

  it('still checks the conventional floor when SPF is missing', () => {
    const candidates = dkimCandidates(undefined);
    expect(candidates.map((c) => c.selector)).toEqual([...CONVENTION_SELECTORS]);
  });

  it('ignores an include it has no mapping for', () => {
    // An unknown provider must not stop the conventional floor from running.
    const candidates = dkimCandidates('v=spf1 include:some-unknown-provider.test ~all');

    expect(candidates.map((c) => c.selector)).toEqual([...CONVENTION_SELECTORS]);
  });

  it('never duplicates a selector', () => {
    const candidates = dkimCandidates(
      'v=spf1 include:_spf.google.com include:google.com include:amazonses.com ~all',
    );

    const selectors = candidates.map((c) => c.selector);
    expect(new Set(selectors).size).toBe(selectors.length);
  });
});

describe('the lookup budget', () => {
  it('never exceeds it, however many providers the SPF record names', () => {
    // Every mapping in the table, at once, is the worst case a real record could
    // produce.
    const spf = `v=spf1 ${Object.keys({
      '_spf.google.com': 1, '_spf.protection.outlook.com': 1, amazonses: 1,
      '_spf.mailgun.org': 1, '_spf.mailchimp.com': 1, '_spf.sendgrid.net': 1,
      '_spf.postmarkapp.com': 1, '_spf.zendesk.com': 1, '_spf.brevo.com': 1,
      '_spf.pphosted.com': 1, '_spf.mimecast.com': 1, '_spf.salesforce.com': 1,
      '_spf.sophos.com': 1, 'spf.fastmail.com': 1, '_spf.clicktime.net': 1,
    }).map((target) => `include:${target}`).join(' ')} ~all`;

    const candidates = dkimCandidates(spf);
    expect(candidates.length).toBeGreaterThan(DKIM_LOOKUP_BUDGET);

    const { selected, skipped } = budgetDkimCandidates(candidates);
    expect(selected).toHaveLength(DKIM_LOOKUP_BUDGET);
    expect(skipped.length).toBeGreaterThan(0);
  });

  it('reports what it dropped rather than dropping it silently', () => {
    // "We checked 25 and gave up" and "we checked everything" are different
    // claims, and only the first is true.
    const many = Array.from({ length: 40 }, (_unused, index) => ({
      selector: `probe${index}`,
      source: 'convention',
    }));

    const { selected, skipped } = budgetDkimCandidates(many);

    expect(selected).toHaveLength(DKIM_LOOKUP_BUDGET);
    expect(skipped).toHaveLength(40 - DKIM_LOOKUP_BUDGET);
    expect(skipped[0]?.selector).toBe(`probe${DKIM_LOOKUP_BUDGET}`);
  });

  it('drops nothing when the list fits', () => {
    const few = [{ selector: 'google', source: 'convention' }];
    const { selected, skipped } = budgetDkimCandidates(few);

    expect(selected).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it('keeps evidence derived selectors ahead of conventions when trimming', () => {
    const candidates = dkimCandidates('v=spf1 include:_spf.zendesk.com ~all');

    const { selected } = budgetDkimCandidates(candidates, 3);

    // Trimming must never cost us an evidence backed label in favour of a guess.
    expect(selected.filter((c) => c.source.startsWith('spf:')).length).toBeGreaterThan(0);
  });
});