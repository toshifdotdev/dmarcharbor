import { describe, expect, it } from 'vitest';
import {
  classifyNewSenderRisk,
  newSenderWindowDays,
  nextPctStep,
  normalizePct,
  pctLadder,
  previousPctStep,
  readPct,
  recommendPctStep,
} from '../src/services/dmarc-rollout.service.js';
import { buildDmarcRecord } from '../src/services/onboarding.service.js';

describe('pct parsing', () => {
  it('treats a missing or empty pct as 100, which is the DMARC default', () => {
    expect(readPct({})).toBe(100);
    expect(readPct({ pct: '' })).toBe(100);
    expect(readPct({ pct: 'abc' })).toBe(100);
    expect(readPct({ pct: '250' })).toBe(100);
    expect(readPct({ pct: '-5' })).toBe(100);
  });

  it('reads a valid pct', () => {
    expect(readPct({ pct: '5' })).toBe(5);
    expect(readPct({ pct: ' 25 ' })).toBe(25);
    expect(readPct({ pct: '100' })).toBe(100);
    expect(readPct({ pct: '0' })).toBe(0);
  });

  it('rejects anything that is not a whole number in range', () => {
    expect(normalizePct('12.5')).toBeNull();
    expect(normalizePct(101)).toBeNull();
    expect(normalizePct(-1)).toBeNull();
    expect(normalizePct('ten')).toBeNull();
    expect(normalizePct(undefined)).toBeNull();
  });
});

describe('pct ladder', () => {
  it('moves one step at a time', () => {
    expect(nextPctStep(0)).toBe(5);
    expect(nextPctStep(5)).toBe(10);
    expect(nextPctStep(10)).toBe(25);
    expect(nextPctStep(25)).toBe(50);
    expect(nextPctStep(50)).toBe(100);
  });

  it('stops at 100', () => {
    expect(nextPctStep(100)).toBe(100);
  });

  it('knows the previous step so a rollback is possible', () => {
    expect(previousPctStep(100)).toBe(50);
    expect(previousPctStep(50)).toBe(25);
    expect(previousPctStep(5)).toBeNull();
  });

  it('recommends the next step only', () => {
    const recommendation = recommendPctStep(5, 'quarantine');
    expect(recommendation.recommendedPct).toBe(10);
    expect(recommendation.advancing).toBe(true);
  });

  it('holds at 100 rather than inventing a bigger number', () => {
    const recommendation = recommendPctStep(100, 'reject');
    expect(recommendation.recommendedPct).toBe(100);
    expect(recommendation.advancing).toBe(false);
  });

  it('does not ask for a canary while p is none', () => {
    const recommendation = recommendPctStep(5, 'none');
    expect(recommendation.recommendedPct).toBe(100);
    expect(recommendation.advancing).toBe(false);
  });
});

describe('record generation with pct', () => {
  it('omits pct at 100 because 100 is the default', () => {
    const record = buildDmarcRecord('example.com', 'reject', false, 100);
    expect(record.value).not.toContain('pct');
    expect(record.pct).toBe(100);
    expect(record.value).toContain('p=reject');
  });

  it('adds pct when it is below 100', () => {
    const record = buildDmarcRecord('example.com', 'quarantine', false, 5);
    expect(record.value).toContain('pct=5');
    expect(record.pct).toBe(5);
    expect(record.value).toContain('p=quarantine');
  });

  it('ignores pct while p is none, because it has no effect', () => {
    const record = buildDmarcRecord('example.com', 'none', false, 5);
    expect(record.value).not.toContain('pct');
    expect(record.pct).toBe(100);
  });

  it('falls back to 100 for an invalid pct instead of writing a broken record', () => {
    const record = buildDmarcRecord('example.com', 'reject', false, 999);
    expect(record.pct).toBe(100);
    expect(record.value).not.toContain('pct');
  });

  it('explains the canary in plain language', () => {
    const notes = buildDmarcRecord('example.com', 'quarantine', false, 5).notes.join(' ');
    expect(notes).toContain('5%');
    expect(notes).toContain('treated as pass');
    expect(notes).toContain('Roll back');
  });

  it('does not promise a rollback when pct is 100', () => {
    const notes = buildDmarcRecord('example.com', 'reject', false).notes.join(' ');
    expect(notes).toContain('left out');
    expect(notes).not.toContain('Roll back');
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

  it('keeps the ladder in ascending order ending at 100', () => {
    expect([...pctLadder]).toEqual([5, 10, 25, 50, 100]);
  });
});
