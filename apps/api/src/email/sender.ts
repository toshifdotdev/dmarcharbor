import { env } from '../config/env.js';

/**
 * Who client facing email says it is from, and where a reply goes.
 *
 * When an agency's white label is on, the display name is the agency's
 * workspace name and the address is CLIENT_EMAIL_FROM_ADDRESS, a neutral
 * sending address shared by every agency. Without that, a client contact who
 * has only ever seen the agency's brand receives mail from "DMARC Harbor" and
 * reasonably wonders who that is.
 *
 * An Admiralty agency can also send from its own domain, for example
 * `reports@mail.wistholm.example`. That address is only ever used once the
 * email provider reports the domain verified and the plan includes it
 * (`ResolvedBranding.sendingAddress`); until then, and after a downgrade, the
 * shared address is used with the agency's name in front, exactly as before.
 *
 * Reply-To is the support address the agency publishes to its clients under
 * white label settings, and nothing else. It is never a staff sign-in address:
 * guessing one (the owner's, say) would hand a staff member's email to every
 * client contact. With no support address set there is no Reply-To, and a
 * reply goes to the From address, as it does for every other notification.
 */

/** Longer names are cut, so a long workspace name cannot fill the inbox column. */
const maximumDisplayNameLength = 64;

/**
 * The bare address from a From value: `Name <a@b.example>` or `a@b.example`.
 * Null when the value holds no usable address.
 */
export function addressOf(from: string): string | null {
  const bracketed = /<\s*([^<>\s@]+@[^<>\s@]+)\s*>\s*$/.exec(from);
  if (bracketed?.[1]) {
    return bracketed[1];
  }
  const bare = from.trim();
  return /^[^<>\s@"]+@[^<>\s@"]+$/.test(bare) ? bare : null;
}

/**
 * Makes a workspace name safe to put inside a quoted display name.
 *
 * CR and LF are removed so a name cannot start a second header, and quotes and
 * backslashes are removed rather than escaped, because providers and mail
 * clients disagree about escapes inside a quoted string and a name that renders
 * as `Wistholm \"IT\"` is worse than one without the quotes. Angle brackets go
 * too, so no client can mistake part of the name for the address.
 */
export function safeDisplayName(name: string): string {
  const cleaned = oneLine(name).replace(/["\\<>]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.length > maximumDisplayNameLength ? cleaned.slice(0, maximumDisplayNameLength).trim() : cleaned;
}

/**
 * A name on one line, for a subject. Control characters, which include CR, LF
 * and tab, become spaces. Done by code point because a regular expression over
 * control characters is what the lint rule against hidden characters in
 * patterns exists to stop.
 */
export function oneLine(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One plain address that is safe to put in a header as it is: no spaces,
 * quotes, angle brackets, commas or control characters, and exactly one @.
 *
 * Every address that reaches a header here was validated when it was saved,
 * but the header is where a CR or LF would do its damage, so it is checked
 * again at the point of use and a value that fails is dropped rather than sent.
 */
function headerSafeAddress(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return /^[^\s@"<>,;()\\[\]]+@[^\s@"<>,;()\\[\]]+$/.test(trimmed) && trimmed === oneLine(trimmed) ? trimmed : null;
}

/** The shared address every agency's client mail leaves from when it has no domain of its own. */
function sharedAddress(): string | null {
  return env.CLIENT_EMAIL_FROM_ADDRESS ?? addressOf(env.EMAIL_FROM);
}

/**
 * The full From header for an agency's client mail, for example
 * `"Wistholm IT" <reports@mail-relay.example>`.
 *
 * `address` is the agency's own verified sending address when it has one
 * (`ResolvedBranding.sendingAddress`); otherwise CLIENT_EMAIL_FROM_ADDRESS, and
 * otherwise the address part of EMAIL_FROM. The bare address is used when the
 * name has nothing left after cleaning. Returns undefined when no address can
 * be found, which sends from EMAIL_FROM.
 */
export function agencyFromHeader(agencyName: string, address?: string | null): string | undefined {
  const chosen = headerSafeAddress(address) ?? sharedAddress();
  if (!chosen) {
    return undefined;
  }
  const name = safeDisplayName(agencyName);
  return name ? `"${name}" <${chosen}>` : chosen;
}

/**
 * The same display name on the shared address, for a message whose own From
 * was refused by the provider (see the fallback in email.service.ts).
 *
 * Undefined when the header has no display name to keep, or already uses the
 * shared address, because then there is nothing different to retry with.
 */
export function sharedFromHeader(from: string): string | undefined {
  const shared = sharedAddress();
  const current = addressOf(from);
  if (!shared || !current || current.toLowerCase() === shared.toLowerCase()) {
    return undefined;
  }
  const quoted = /^\s*"([^"]*)"\s*</.exec(from);
  const bare = /^\s*([^"<>]+?)\s*</.exec(from);
  const name = safeDisplayName(quoted?.[1] ?? bare?.[1] ?? '');
  return name ? `"${name}" <${shared}>` : undefined;
}

/** What client facing mail needs from the resolved branding. */
export interface ClientEmailBranding {
  branded: boolean;
  workspaceName: string;
  supportEmail?: string | null;
  sendingAddress?: string | null;
}

/**
 * The From and Reply-To headers for a client facing message, or neither for
 * our own.
 *
 * Only a workspace whose plan includes white label (`branded`) sends under its
 * own name. Below that the client sees our name in the email anyway, so the
 * headers say the same thing and no Reply-To is added.
 */
export function clientEmailHeaders(
  branding: ClientEmailBranding | null | undefined,
): { from?: string; replyTo?: string } {
  if (!branding?.branded) {
    return {};
  }
  const from = agencyFromHeader(branding.workspaceName, branding.sendingAddress);
  const replyTo = headerSafeAddress(branding.supportEmail);
  return { ...(from ? { from } : {}), ...(replyTo ? { replyTo } : {}) };
}

/**
 * The From header alone. Kept for callers that only need the From line;
 * `clientEmailHeaders` is what client mail uses.
 */
export function clientEmailFrom(branding: ClientEmailBranding | null | undefined): string | undefined {
  return clientEmailHeaders(branding).from;
}
