import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Checking an authenticator code outside the two-factor plugin, for the
 * ownership transfer's confirmation. The same algorithm and settings as the
 * plugin (RFC 6238, SHA-1, six digits, 30 seconds, one step either side),
 * without its side effects: verify-totp also rotates the session.
 */

const BASE32_PREFIX = 'base32:';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * The HMAC key, as the two-factor plugin derives it: the stored secret's
 * UTF-8 bytes, or the decoded bytes of a secret imported as `base32:<secret>`.
 */
export function totpKey(secret: string): Buffer {
  if (!secret.startsWith(BASE32_PREFIX)) return Buffer.from(secret, 'utf8');
  const input = secret.slice(BASE32_PREFIX.length).toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 with the plugin's settings: six digits, 30 seconds, one step either side. */
export function verifyTotp(key: Buffer, code: string, nowMs: number): boolean {
  // Six ASCII digits or nothing. A multibyte character made the padded buffer
  // longer than the expected one, and timingSafeEqual threw (a 500).
  if (!/^\d{6}$/.test(code)) {
    return false;
  }
  const step = Math.floor(nowMs / 30_000);
  let matched = false;
  for (let offset = -1; offset <= 1; offset += 1) {
    const expected = Buffer.from(hotp(key, step + offset));
    const given = Buffer.from(code.padEnd(expected.length, ' ').slice(0, expected.length));
    matched = timingSafeEqual(expected, given) || matched;
  }
  return matched && code.length === 6;
}

export function hotp(key: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}
