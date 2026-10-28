import { describe, expect, it } from 'vitest';
import { describeProposal, policyLabel } from '../src/services/policy-proposal/proposal-words.js';
import { strictness } from '../src/services/policy-proposal/policy-proposal.service.js';
import { enforcementLevelOf } from '../src/services/onboarding.service.js';

const evidence = {
  daysObserved: 34,
  daysAtCurrentPolicy: 34,
  messagesObserved: 2400,
  passRatePercent: 99.2,
  dkimPassRatePercent: 99.6,
  failingSenders: 0,
  observedSenders: 4,
};

describe('what the client reads', () => {
  it('says what happens to fake mail, in words, for each step', () => {
    const quarantine = describeProposal({ domainName: 'acme.com', agencyName: 'Northwind IT', policy: 'quarantine', testing: false, evidence });
    expect(quarantine.headline).toBe('Send fake email that claims to be from acme.com to spam');
    expect(quarantine.effect).toContain("recipient's spam folder");
    expect(quarantine.trial).toBeNull();
    expect(quarantine.risk).toContain('Northwind IT');
    expect(quarantine.evidence).toBe(
      '99.2% of the 2,400 messages seen over the last 34 days passed the checks, and 0 of the 4 services sending as acme.com are failing them.',
    );

    const reject = describeProposal({ domainName: 'acme.com', agencyName: 'Northwind IT', policy: 'reject', testing: true, evidence });
    expect(reject.headline).toBe('Refuse fake email that claims to be from acme.com');
    expect(reject.trial).toContain('goes to spam rather than being refused');
  });

  it('quotes no evidence it does not have', () => {
    const words = describeProposal({
      domainName: 'acme.com',
      agencyName: 'Northwind IT',
      policy: 'quarantine',
      testing: false,
      evidence: { ...evidence, messagesObserved: 0, passRatePercent: null },
    });
    expect(words.evidence).toBeNull();
  });

  it('labels the policy for the agency, trial included', () => {
    expect(policyLabel('quarantine', true)).toBe('p=quarantine (trial, t=y)');
    expect(policyLabel('none', true)).toBe('p=none');
  });
});

describe('the rollout ladder', () => {
  it('orders every step, trials included, from none to reject', () => {
    const ladder = [
      { p: 'none', testing: false },
      { p: 'quarantine', testing: true },
      { p: 'quarantine', testing: false },
      { p: 'reject', testing: true },
      { p: 'reject', testing: false },
    ].map(strictness);
    expect([...ladder].sort((a, b) => a - b)).toEqual(ladder);
    expect(new Set(ladder).size).toBe(ladder.length);
  });

  it('checks a request against the level receivers will apply', () => {
    expect(enforcementLevelOf('quarantine', true)).toBe('none');
    expect(enforcementLevelOf('quarantine', false)).toBe('quarantine');
    expect(enforcementLevelOf('reject', true)).toBe('quarantine');
    expect(enforcementLevelOf('reject', false)).toBe('reject');
  });
});
