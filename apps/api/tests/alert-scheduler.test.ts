import { describe, expect, it } from 'vitest';
import { isValidTimeZone, isWithinQuietHours } from '../src/services/alert.service.js';

function at(hours: number, minutes = 0): Date {
  return new Date(Date.UTC(2026, 0, 15, hours, minutes, 0));
}

describe('quiet hours', () => {
  it('detects a window inside a single day', () => {
    expect(isWithinQuietHours('22:00', '07:00', at(23, 30))).toBe(true);
    expect(isWithinQuietHours('22:00', '07:00', at(3, 15))).toBe(true);
    expect(isWithinQuietHours('22:00', '07:00', at(12))).toBe(false);
    expect(isWithinQuietHours('22:00', '07:00', at(7))).toBe(false);
  });

  it('handles a window that wraps past midnight', () => {
    expect(isWithinQuietHours('20:00', '02:00', at(21))).toBe(true);
    expect(isWithinQuietHours('20:00', '02:00', at(1))).toBe(true);
    expect(isWithinQuietHours('20:00', '02:00', at(10))).toBe(false);
  });

  it('handles a daytime window', () => {
    expect(isWithinQuietHours('09:00', '17:00', at(12))).toBe(true);
    expect(isWithinQuietHours('09:00', '17:00', at(18))).toBe(false);
  });

  it('never fires when the window is unset, incomplete, or invalid', () => {
    expect(isWithinQuietHours(null, null, at(3))).toBe(false);
    expect(isWithinQuietHours('22:00', null, at(23))).toBe(false);
    expect(isWithinQuietHours(null, '07:00', at(23))).toBe(false);
    expect(isWithinQuietHours('22:00', '22:00', at(23))).toBe(false);
    expect(isWithinQuietHours('nonsense', '07:00', at(23))).toBe(false);
    expect(isWithinQuietHours('99:00', '07:00', at(23))).toBe(false);
  });

  it('evaluates the window in the user timezone rather than UTC', () => {
    // 23:00 UTC on 15 January is 00:00 on 16 January in Berlin (UTC+1 in winter).
    expect(isWithinQuietHours('22:00', '07:00', at(23), 'UTC')).toBe(true);
    expect(isWithinQuietHours('22:00', '07:00', at(23), 'Europe/Berlin')).toBe(true);
    expect(isWithinQuietHours('00:00', '06:00', at(23), 'UTC')).toBe(false);
    expect(isWithinQuietHours('00:00', '06:00', at(23), 'Europe/Berlin')).toBe(true);

    // 12:00 UTC is 07:00 in New York, so a 06:00-08:00 window is only quiet locally.
    expect(isWithinQuietHours('06:00', '08:00', at(12), 'America/New_York')).toBe(true);
    expect(isWithinQuietHours('06:00', '08:00', at(12), 'UTC')).toBe(false);
  });

  it('falls back to UTC for an unknown timezone instead of failing open', () => {
    expect(isWithinQuietHours('22:00', '07:00', at(23), 'Mars/Olympus_Mons')).toBe(true);
    expect(isWithinQuietHours('22:00', '07:00', at(12), 'Mars/Olympus_Mons')).toBe(false);
  });

  it('validates IANA timezone names', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
