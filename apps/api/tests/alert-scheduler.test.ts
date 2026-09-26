import { describe, expect, it } from 'vitest';
import { isWithinQuietHours } from '../src/services/alert.service.js';

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
});
