import { env } from '../config/env.js';

/**
 * The address a client publishes in rua.
 *
 * With subaddressing off every client shares one address, which is how the
 * product worked before this module existed. With `plus` the client's token is
 * appended to the local part, which identifies the client without changing how
 * a report is routed: routing still uses the policy domain inside the report.
 */
export const reportTokenPattern = /^[0-9a-f]{12}$/;

function sharedAddress(): { address: string; local: string; domain: string } {
  const address = env.REPORT_AGGREGATE_ADDRESS.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  return {
    address,
    local: at > 0 ? address.slice(0, at) : address,
    domain: at > 0 ? address.slice(at + 1) : '',
  };
}

export function clientAggregateAddress(reportToken: string): string {
  if (env.REPORT_ADDRESS_SUBADDRESSING === 'off') {
    return env.REPORT_AGGREGATE_ADDRESS;
  }
  const { local, domain } = sharedAddress();
  return `${local}+${reportToken}@${domain}`;
}

function isAddrSpec(value: string): boolean {
  return /^[^\s@,;]+@[^\s@,;]+$/.test(value);
}

/**
 * The bare address of a report URI, or null when it is not a usable mailto.
 *
 * Sizes (`mailto:a@b!10m`), percent encoding and case all appear in real
 * records, and a comparison that ignored any of them would either miss our own
 * address or claim somebody else's.
 */
export function normaliseReportUri(uri: string): string | null {
  const trimmed = uri.trim();
  if (!/^mailto:/i.test(trimmed)) {
    return null;
  }

  let rest = trimmed.slice('mailto:'.length);
  // RFC 7489 permits a size suffix after the address: !10m, !1g, and so on.
  rest = rest.replace(/![^!,;\s]*$/, '').trim();

  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }

  const address = decoded.trim().toLowerCase();
  return isAddrSpec(address) ? address : null;
}

export type ReportAddressClassification =
  | { kind: 'shared' }
  | { kind: 'client'; token: string }
  | { kind: 'foreign'; host: string }
  | { kind: 'invalid' };

/**
 * Which client, if any, an rua URI belongs to.
 *
 * Client addresses are recognised even while subaddressing is off. A customer
 * who published `local+token@domain` before the setting changed must not have
 * their own record classified as foreign and, worse, be told that adding our
 * address again would help.
 */
export function classifyReportAddress(uriOrAddress: string): ReportAddressClassification {
  const normalised =
    normaliseReportUri(uriOrAddress) ?? normaliseReportUri(`mailto:${uriOrAddress.trim()}`);
  if (!normalised) {
    return { kind: 'invalid' };
  }

  const shared = sharedAddress();
  if (normalised === shared.address) {
    return { kind: 'shared' };
  }

  const at = normalised.lastIndexOf('@');
  const local = normalised.slice(0, at);
  const domain = normalised.slice(at + 1);

  if (domain === shared.domain && local.startsWith(`${shared.local}+`)) {
    const token = local.slice(shared.local.length + 1);
    if (reportTokenPattern.test(token)) {
      return { kind: 'client', token };
    }
  }

  return { kind: 'foreign', host: domain };
}

export function isOurAddress(uriOrAddress: string): boolean {
  const kind = classifyReportAddress(uriOrAddress).kind;
  return kind === 'shared' || kind === 'client';
}
