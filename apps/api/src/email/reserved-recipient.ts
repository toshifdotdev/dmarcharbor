/**
 * Addresses mail is never sent to.
 *
 * RFC 2606 and RFC 6761 reserve `.test`, `.example`, `.invalid` and
 * `.localhost`, and the domains example.com, example.net and example.org, so
 * that no real mailbox can ever sit behind them. Seed data and tests use them
 * for exactly that reason, and the local schedulers still mailed them through
 * the real provider: a DNS alert about a sample domain went out through Resend
 * to a `.test` address. Every one of those is a bounce counted against the
 * sending domain's reputation.
 *
 * Checked at the one place mail leaves for the provider (`sendEmail`), so it
 * covers the queue and the direct senders alike. The console provider is not
 * affected: it prints, and the dev seed reads the verification link it prints
 * for a `.test` address.
 */
const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost']);
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

/** The bare address from `name <a@b>` or `a@b`, lower-cased. */
function bareAddress(value: string): string {
  const angle = /<([^>]+)>/.exec(value);
  return (angle ? angle[1]! : value).trim().toLowerCase();
}

/** Why mail to this recipient must not be sent, or null when it may be. */
export function undeliverableReason(recipient: string): string | null {
  const address = bareAddress(recipient);
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) {
    return 'not an email address';
  }
  const domain = address.slice(at + 1).replace(/\.+$/, '');
  const tld = domain.split('.').pop() ?? '';
  if (RESERVED_TLDS.has(tld)) {
    return `.${tld} is a reserved top-level domain`;
  }
  const reserved = RESERVED_DOMAINS.find((name) => domain === name || domain.endsWith(`.${name}`));
  if (reserved) {
    return `${reserved} is a reserved domain`;
  }
  return null;
}

/** Thrown by `sendEmail` instead of handing a reserved recipient to the provider. */
export class UndeliverableRecipientError extends Error {
  constructor(
    readonly recipient: string,
    readonly reason: string,
  ) {
    super(`Not sent to ${recipient}: ${reason}.`);
    this.name = 'UndeliverableRecipientError';
  }
}
