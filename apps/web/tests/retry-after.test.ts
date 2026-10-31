import { describe, expect, it } from 'vitest';
import { parseRetryAfter, retryAfterFrom, retryAfterText } from '../lib/retry-after.js';

/**
 * What a rate limit says about waiting.
 *
 * A 429 is never a permanent refusal, so every sentence must say to wait, and
 * say how long when the limiter did. Rounded up: coming back before the
 * window resets only earns a second refusal.
 */

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('120')).toBe(120);
  });

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-05-01T10:00:00Z');
    expect(parseRetryAfter('Fri, 01 May 2026 10:05:00 GMT', now)).toBe(300);
  });

  it('ignores a missing, zero, past or unreadable value', () => {
    const now = Date.parse('2026-05-01T10:00:00Z');
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('0')).toBeNull();
    expect(parseRetryAfter('Fri, 01 May 2026 09:00:00 GMT', now)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });

  it('caps an absurd wait at a day', () => {
    expect(parseRetryAfter('9999999')).toBe(86_400);
  });
});

describe('retryAfterFrom', () => {
  it('prefers Retry-After and falls back to Better Auth X-Retry-After', () => {
    expect(retryAfterFrom(new Headers({ 'retry-after': '30', 'x-retry-after': '90' }))).toBe(30);
    expect(retryAfterFrom(new Headers({ 'x-retry-after': '90' }))).toBe(90);
    expect(retryAfterFrom(new Headers())).toBeNull();
  });
});

describe('retryAfterText', () => {
  it('says to wait even when the limiter gave no figure', () => {
    expect(retryAfterText(null)).toBe('Wait a minute, then try again.');
  });

  it('rounds minutes and hours up', () => {
    expect(retryAfterText(45)).toBe('Wait a minute, then try again.');
    expect(retryAfterText(61)).toBe('Wait about 2 minutes, then try again.');
    expect(retryAfterText(3600)).toBe('Wait about an hour, then try again.');
    expect(retryAfterText(3601)).toBe('Wait about 2 hours, then try again.');
  });

  it('names the next step it was given', () => {
    expect(retryAfterText(300, 'reload the page')).toBe('Wait about 5 minutes, then reload the page.');
  });
});
