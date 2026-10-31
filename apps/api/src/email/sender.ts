import { env } from '../config/env.js';

/**
 * Who client facing email says it is from.
 *
 * When an agency's white label is on, the display name is the agency's
 * workspace name and the address is CLIENT_EMAIL_FROM_ADDRESS, a neutral
 * sending address shared by every agency. Without that, a client contact who
 * has only ever seen the agency's brand receives mail from "DMARC Harbor" and
 * reasonably wonders who that is.
 *
 * There is no Reply-To. We hold no contact address for an agency, and guessing
 * one (the owner's sign-in address, say) would publish a staff member's email
 * to every client contact. A reply goes to the neutral address, as it does for
 * every other notification.
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
 * The full From header for an agency's client mail, for example
 * `"Wistholm IT" <reports@mail-relay.example>`.
 *
 * Falls back to the address part of EMAIL_FROM when CLIENT_EMAIL_FROM_ADDRESS is
 * unset, and to the bare address when the name has nothing left after cleaning.
 * Returns undefined when no address can be found, which sends from EMAIL_FROM.
 */
export function agencyFromHeader(agencyName: string): string | undefined {
  const address = env.CLIENT_EMAIL_FROM_ADDRESS ?? addressOf(env.EMAIL_FROM);
  if (!address) {
    return undefined;
  }
  const name = safeDisplayName(agencyName);
  return name ? `"${name}" <${address}>` : address;
}

/**
 * The From header for a client facing message, or undefined for our own.
 *
 * Only a workspace whose plan includes white label (`branded`) sends under its
 * own name. Below that the client sees our name in the email anyway, so the
 * From line says the same thing.
 */
export function clientEmailFrom(branding: { branded: boolean; workspaceName: string } | null | undefined): string | undefined {
  if (!branding?.branded) {
    return undefined;
  }
  return agencyFromHeader(branding.workspaceName);
}
