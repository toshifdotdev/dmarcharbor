/**
 * mfa.ts — the small amount of parsing the security screen does itself.
 *
 * The API returns the otpauth:// URI, and the screen shows the secret as text
 * for people whose authenticator cannot scan a code. Nothing here contacts a
 * QR service or logs the URI: the QR is drawn in this browser from the URI.
 */

/** The base32 secret inside an otpauth://totp URI, or null if it is not one. */
export function totpSecretFromUri(uri: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "otpauth:") return null;
  const secret = (parsed.searchParams.get("secret") ?? "").replace(/\s+/g, "").toUpperCase();
  // Base32 only. Returning anything else would be printed as a setup key that
  // no authenticator app can accept.
  return /^[A-Z2-7]+=*$/.test(secret) ? secret : null;
}

/** Four-character groups, the way authenticator apps display a setup key. */
export function groupSecret(secret: string): string {
  return (secret.replace(/\s+/g, "").toUpperCase().match(/.{1,4}/g) ?? []).join(" ");
}
