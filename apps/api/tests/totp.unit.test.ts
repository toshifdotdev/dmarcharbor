import { describe, expect, it } from 'vitest';
import { base32Decode, totpFromSecret, totpFromUri } from './helpers/totp.js';

describe('test TOTP helper', () => {
  it('matches the RFC 6238 SHA-1 test vector at T = 59 seconds', () => {
    expect(totpFromSecret('12345678901234567890', 59_000)).toBe('287082');
  });

  it('reads the base32 secret out of an otpauth URI', () => {
    const uri =
      'otpauth://totp/DMARC%20Harbor:user%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=DMARC%20Harbor&digits=6&period=30';
    expect(base32Decode('JBSWY3DPEHPK3PXP').toString('hex')).toBe('48656c6c6f21deadbeef');
    expect(totpFromUri(uri, 1_700_000_000_000)).toBe(
      totpFromSecret(base32Decode('JBSWY3DPEHPK3PXP'), 1_700_000_000_000),
    );
  });
});
