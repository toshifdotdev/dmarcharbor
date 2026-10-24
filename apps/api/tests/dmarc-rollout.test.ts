import { describe, expect, it } from 'vitest';
import {
  classifyNewSenderRisk,
  enforcementStageDays,
  newSenderWindowDays,
  recommendPolicyStage,
} from '../src/services/dmarc-rollout.service.js';
import { buildDmarcRecord, daysAtPolicy } from '../src/services/onboarding.service.js';

const RUA = 'rua=mailto:dmarc-reports@reports.dmarcharbor.com';

describe('record generation under RFC 9989', () => {
  it('writes the monitoring record of RFC 9989 appendix B.2.1', () => {
    const record = buildDmarcRecord('example.com', 'none', false);
    expect(record.value).toBe(`v=DMARC1; p=none; ${RUA}`);
    expect(record.testing).toBe(false);
    expect(record.nonExistentSubdomains).toBeNull();
  });

  it('never writes pct, whatever policy is asked for', () => {
    for (const policy of ['none', 'quarantine', 'reject'] as const) {
      expect(buildDmarcRecord('example.com', policy, true).value).not.toMatch(/pct=(?!0)/);
      expect(buildDmarcRecord('example.com', policy, false).value).not.toContain('pct');
    }
  });

  it('writes testing mode as t=y, paired with pct=0 for receivers still on RFC 7489', () => {
    const record = buildDmarcRecord('example.com', 'quarantine', false, { testing: true });
    expect(record.value).toBe(`v=DMARC1; p=quarantine; ${RUA}; t=y; pct=0`);
    expect(record.testing).toBe(true);
    expect(record.notes.join(' ')).toContain('t=y is testing mode');
    expect(record.notes.join(' ')).toContain('RFC 7489');
  });

  it('leaves testing mode out of p=none, where it has no effect (RFC 9989 4.7)', () => {
    const record = buildDmarcRecord('example.com', 'none', false, { testing: true });
    expect(record.value).not.toContain('t=y');
    expect(record.testing).toBe(false);
  });

  it('writes np for non-existent subdomains when asked', () => {
    const record = buildDmarcRecord('example.com', 'none', false, { nonExistentSubdomains: 'reject' });
    expect(record.value).toBe(`v=DMARC1; p=none; ${RUA}; np=reject`);
    expect(record.notes.join(' ')).toContain('np=reject');
  });

  it('carries the stage guidance of RFC 9989 section 7.4 in the notes', () => {
    expect(buildDmarcRecord('example.com', 'none', false).notes.join(' ')).toContain(`${enforcementStageDays} days`);
    const reject = buildDmarcRecord('example.com', 'reject', false).notes.join(' ');
    expect(reject).toContain('DKIM');
    expect(reject).toContain('mailing lists');
  });
});

describe('the next policy stage', () => {
  it('holds p=none until the evidence supports quarantine', () => {
    const waiting = recommendPolicyStage({ publishedPolicy: 'none', testing: false, historicTags: [], readyFor: 'none' });
    expect(waiting.next).toEqual({ policy: 'quarantine', testing: false });
    expect(waiting.advancing).toBe(false);
    expect(waiting.reason).toContain('at least a month');

    const ready = recommendPolicyStage({ publishedPolicy: 'none', testing: false, historicTags: [], readyFor: 'quarantine' });
    expect(ready.advancing).toBe(true);
  });

  it('never recommends a pct step', () => {
    for (const publishedPolicy of ['none', 'quarantine', 'reject'] as const) {
      const stage = recommendPolicyStage({ publishedPolicy, testing: false, historicTags: [], readyFor: 'reject' });
      expect(JSON.stringify(stage)).not.toMatch(/pct=\d/);
    }
  });

  it('moves a policy out of testing mode before anything else', () => {
    const stage = recommendPolicyStage({ publishedPolicy: 'quarantine', testing: true, historicTags: [], readyFor: 'quarantine' });
    expect(stage.next).toEqual({ policy: 'quarantine', testing: false });
    expect(stage.reason).toContain('Remove t=y');
  });

  it('names the DKIM and mailing-list conditions before p=reject', () => {
    const stage = recommendPolicyStage({ publishedPolicy: 'quarantine', testing: false, historicTags: [], readyFor: 'quarantine' });
    expect(stage.next).toEqual({ policy: 'reject', testing: false });
    expect(stage.advancing).toBe(false);
    expect(stage.cautions.join(' ')).toContain('DKIM');
    expect(stage.cautions.join(' ')).toContain('mailing lists');
  });

  it('asks for retired tags to be removed', () => {
    const stage = recommendPolicyStage({ publishedPolicy: 'reject', testing: false, historicTags: ['pct', 'ri'], readyFor: 'none' });
    expect(stage.next).toBeNull();
    expect(stage.cautions[0]).toContain('Remove pct, ri');
  });
});

describe('days a policy has been in force, from the reports', () => {
  const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));
  const report = (policyP: string | null, from: number, to: number) => ({ policyP, dateRangeBegin: day(from), dateRangeEnd: day(to) });

  it('counts back from the newest report to the last change of policy', () => {
    // Newest first, as the readiness check reads them.
    const reports = [report('quarantine', 40, 41), report('quarantine', 20, 21), report('none', 10, 11), report('quarantine', 0, 1)];
    expect(daysAtPolicy(reports, 'quarantine')).toBe(21);
  });

  it('skips reports that carry no policy rather than counting them', () => {
    expect(daysAtPolicy([report('quarantine', 35, 36), report(null, 20, 21), report('quarantine', 0, 1)], 'quarantine')).toBe(36);
  });

  it('is zero when the newest report shows a different policy', () => {
    expect(daysAtPolicy([report('none', 5, 6), report('quarantine', 0, 1)], 'quarantine')).toBe(0);
  });
});

describe('new sender risk', () => {
  it('calls a sender fully authenticated when both pass', () => {
    expect(classifyNewSenderRisk(true, true)).toBe('authenticated');
  });

  it('calls a sender partial when only one passes, which is normal for a new service', () => {
    expect(classifyNewSenderRisk(true, false)).toBe('partially-authenticated');
    expect(classifyNewSenderRisk(false, true)).toBe('partially-authenticated');
  });

  it('calls a sender unauthenticated when neither passes, which is the spoofing signal', () => {
    expect(classifyNewSenderRisk(false, false)).toBe('unauthenticated');
  });
});

describe('rollout constants', () => {
  it('uses a seven day new sender window', () => {
    expect(newSenderWindowDays).toBe(7);
  });

  it('holds each enforcement stage for at least a month (RFC 9989 7.4)', () => {
    expect(enforcementStageDays).toBeGreaterThanOrEqual(30);
  });
});
