import { describe, expect, it } from 'vitest';
import { classifySender } from '../src/services/sender-breakdown.service.js';

/**
 * DMARC passes when either aligned identifier passed, so the status input is
 * the both-failed count. A DKIM-passing, SPF-failing bulk sender therefore has
 * zero DMARC failures and is clean; the stricter both-checks figure is kept
 * separately for display. The integration suite proves the counts; this pins
 * the thresholds themselves.
 */
describe('sender classification', () => {
  it('calls a sender clean when nothing failed both aligned checks', () => {
    expect(classifySender(1_000, 0)).toBe('clean');
  });

  it('allows a small DMARC failure share as degraded', () => {
    expect(classifySender(1_000, 50)).toBe('degraded');
  });

  it('calls a sender failing above the threshold', () => {
    expect(classifySender(1_000, 51)).toBe('failing');
  });

  it('does not grade a sender with too little traffic', () => {
    expect(classifySender(49, 40)).toBe('insufficient-data');
  });
});
