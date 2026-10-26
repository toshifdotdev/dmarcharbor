import { createHmac } from 'node:crypto';

/**
 * Minimal RFC 6238 TOTP, used only by tests.
 *
 * Better Auth generates the secret and the otpauth:// URI; this reproduces what
 * an authenticator app would compute from that URI. It is deliberately not
 * imported by production code.
 */

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of clean) {
    const index = alphabet.indexOf(character);
    if (index < 0) {
      throw new Error('The TOTP secret is not valid base32.');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totpFromSecret(
  secret: string | Buffer,
  now = Date.now(),
  digits = 6,
  period = 30,
): string {
  const counter = Math.floor(now / 1000 / period);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const key = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const truncated =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(truncated % 10 ** digits).padStart(digits, '0');
}

export function totpFromUri(uri: string, now = Date.now()): string {
  const secret = new URL(uri).searchParams.get('secret');
  if (!secret) {
    throw new Error('The otpauth URI has no secret.');
  }
  return totpFromSecret(base32Decode(secret), now);
}
