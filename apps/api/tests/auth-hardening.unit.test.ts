import { describe, expect, it } from 'vitest';
import { signInBrakeKey, SIGN_IN_FAILURE_LIMIT, SIGN_IN_FAILURE_WINDOW_MS, SIGN_IN_PAUSE_MS } from '../src/auth/sign-in-brake.js';
import { claimableCode } from '../src/auth/totp-replay.js';

describe('the per-account sign-in brake', () => {
  it('is 10 wrong passwords in 15 minutes, then a 15-minute pause', () => {
    expect(SIGN_IN_FAILURE_LIMIT).toBe(10);
    expect(SIGN_IN_FAILURE_WINDOW_MS).toBe(15 * 60_000);
    expect(SIGN_IN_PAUSE_MS).toBe(15 * 60_000);
  });

  it('keys one address the same however it was typed, and never stores the address', () => {
    const key = signInBrakeKey('dmarcharbor+test1@gmail.com');
    expect(signInBrakeKey('  DMARCharbor+Test1@Gmail.com ')).toBe(key);
    expect(signInBrakeKey('dmarcharbor+test2@gmail.com')).not.toBe(key);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('dmarcharbor');
  });
});

describe('one use per authenticator code', () => {
  it('claims only a six-digit code', () => {
    expect(claimableCode('123456')).toBe('123456');
    expect(claimableCode(' 123456 ')).toBe('123456');
    for (const code of ['12345', '1234567', 'abcdef', '', null, 123456, undefined]) {
      expect(claimableCode(code), String(code)).toBeNull();
    }
  });
});
