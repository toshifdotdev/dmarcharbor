/**
 * One answer to "may we open a connection to this address?".
 *
 * Two features take a hostname from a customer and connect to it: outgoing
 * webhook delivery and the IMAP report inbox. Both are server side request
 * forgery by construction, because the whole point is that we connect to an
 * address the customer chose. The only defence is refusing the ranges that are
 * not on the public internet, and the defence has to be identical in both places
 * or one of them becomes the way in.
 *
 * The list that matters most is link-local. 169.254.169.254 is how an EC2, GCE or
 * Azure instance is asked for its instance metadata and IAM credentials, and
 * answering that request returns a token that can read every other secret on the
 * machine. It is the highest value single target on a cloud host and it was the
 * one private range missing.
 *
 * This checks the address as written. It does not resolve names, so a hostname
 * that resolves to a private address still passes. That is a real gap and it is
 * called out where it matters: resolving here would introduce a DNS lookup into
 * request handling and a time-of-check to time-of-use race, so the honest
 * boundary is that these functions police the literal address, and anything that
 * accepts a name must resolve and re-check before connecting.
 */

/**
 * Expands the ways an IPv4 address can be written into a single octet tuple.
 *
 * A URL host is a string until something resolves it, and runtimes accept
 * `2130706433` and `0x7f000001` as 127.0.0.1. A validator that does not agree with
 * the resolver about what an address is, is decoration.
 */
function normaliseIpv4(host: string): [number, number, number, number] | null {
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (dotted) {
    const octets = dotted.slice(1).map(Number);
    return octets.every((octet) => octet <= 255) ? (octets as [number, number, number, number]) : null;
  }

  const toTuple = (value: number): [number, number, number, number] | null =>
    value <= 0xffff_ffff
      ? [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
      : null;

  const asHex = /^0x[0-9a-f]{1,8}$/.test(host) ? Number.parseInt(host.slice(2), 16) : null;
  if (asHex !== null) {
    return toTuple(asHex);
  }

  /**
   * Octal, checked before decimal because a leading zero is a radix prefix rather
   * than a zero. `017700000001` is 127.0.0.1 and is a real historical way of
   * writing it; Number() reads it as decimal and lands on 17,700,000,001, which is
   * out of range and would have been waved through rather than refused.
   */
  if (/^0[0-7]+$/.test(host)) {
    return toTuple(Number.parseInt(host, 8));
  }

  const asDecimal = /^\d{1,10}$/.test(host) ? Number(host) : null;
  if (asDecimal !== null) {
    return toTuple(asDecimal);
  }

  return null;
}

/**
 * Whether a hostname is somewhere a request should never be sent.
 *
 * Loopback, RFC1918, carrier grade NAT, link-local, unique local IPv6, and the
 * cloud metadata names, which resolve to link-local but read as ordinary
 * hostnames and so never reach the numeric checks.
 */
export function isPrivateOrReservedHost(hostname: string): boolean {
  // URL parsing keeps IPv6 literals bracketed, so [::1] arrives as "[::1]".
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return true;
  }
  if (host === '::1' || host === '0.0.0.0' || host === '::') {
    return true;
  }
  if (host === 'metadata.google.internal' || host === 'metadata.goog' || host.endsWith('.compute.internal')) {
    return true;
  }

  const ipv4 = normaliseIpv4(host);
  if (ipv4) {
    const [a, b] = ipv4;
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    ) {
      return true;
    }
  }

  // fc00::/7 unique local, fe80::/10 link-local.
  if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) {
    return true;
  }

  return false;
}

/**
 * Resolves a hostname and refuses it if any answer is private or reserved.
 *
 * This is what `isPrivateOrReservedHost` cannot do on its own. Checking the
 * string as written answers the question "did the customer type a number that
 * looks private", and the question that matters is "where will this connection
 * actually go". A hostname is free to resolve to anything, so
 * `rebind.attacker.test` passes the string check and then answers
 * `169.254.169.254` at connect time.
 *
 * Every address is checked rather than the first, because a round robin that
 * returns one public address and one link-local address would otherwise pass on
 * whichever the resolver happened to order first - and `lookup` with `all: true`
 * returns them all so the check is over the whole answer set.
 *
 * Returns the addresses rather than nothing, so the caller can pin the connection
 * to what was checked. Resolving twice, once to check and once to connect, leaves
 * the window this exists to close: DNS can change between the two, which is the
 * whole technique.
 */
export async function assertPublicHost(
  hostname: string,
  lookup: (hostname: string) => Promise<Array<{ address: string }>>,
): Promise<Array<{ address: string }>> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Already an address, so there is nothing to resolve and no window to close.
  if (isPrivateOrReservedHost(host)) {
    throw new Error('That address is on a private or reserved network.');
  }

  const addresses = await lookup(host);

  if (addresses.length === 0) {
    throw new Error('That host did not resolve.');
  }

  for (const entry of addresses) {
    if (isPrivateOrReservedHost(entry.address.replace(/^\[|\]$/g, ''))) {
      throw new Error('That host resolves to a private or reserved address.');
    }
  }

  return addresses;
}