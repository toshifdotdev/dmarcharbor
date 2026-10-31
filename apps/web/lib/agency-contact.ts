/**
 * agency-contact.ts — the support contact an agency publishes to its clients,
 * checked before it becomes a link.
 *
 * The API checks both values when they are saved (validateSupportEmail and
 * validateSupportUrl in the API's branding.service.ts). They reach a page by
 * two routes: the portal's own branding read, and the x-harbor-brand header
 * the proxy writes from GET /api/branding/host. Both are checked again here
 * with the same rules, and a value that fails is dropped, never rendered. An
 * email that is not one plain address never becomes a mailto: link, and a page
 * that is not https never becomes an href, so no javascript: or http: address
 * can reach a client through either route.
 *
 * Pure, with no Next imports, so it is unit-tested (tests/agency-contact.test.ts)
 * and the proxy can use it.
 */

/** Letters, digits and hyphens per label, at least two labels, each 1 to 63 long. */
const plainHostname = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** One address: no display name, quotes, brackets, comma, semicolon or space. */
const plainAddress = /^([^\s@"<>,;:()\\[\]]{1,64})@([^\s@"<>,;:()\\[\]]+)$/;

/** True when a value holds a character below space or in the C1 range, which includes CR and LF. */
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

/** The support email as one plain address with a lowercased domain, or null. */
export function supportEmailOrNull(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 254 || hasControlCharacter(trimmed)) return null;
  const match = plainAddress.exec(trimmed);
  if (!match) return null;
  const domain = (match[2] ?? "").toLowerCase();
  if (domain.length > 253 || !plainHostname.test(domain)) return null;
  return `${match[1]}@${domain}`;
}

/** The support page as a full https address with no credentials, or null. */
export function supportUrlOrNull(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 500 || hasControlCharacter(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
  const href = url.toString();
  return href.length > 500 ? null : href;
}

export interface AgencyContact {
  email: string | null;
  url: string | null;
}

/** Both checked values, or null when neither survives: then nothing is shown. */
export function agencyContact(source: { supportEmail?: unknown; supportUrl?: unknown } | null | undefined): AgencyContact | null {
  if (!source) return null;
  const email = supportEmailOrNull(source.supportEmail);
  const url = supportUrlOrNull(source.supportUrl);
  return email || url ? { email, url } : null;
}

/**
 * The mailto: href for a checked address. The part before the @ is encoded,
 * so a character a mail client would read as the start of a query (`?`, `&`)
 * stays part of the address.
 */
export function mailtoHref(email: string): string {
  const at = email.lastIndexOf("@");
  return `mailto:${encodeURIComponent(email.slice(0, at))}@${email.slice(at + 1)}`;
}
