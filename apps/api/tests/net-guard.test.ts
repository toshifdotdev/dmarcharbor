import { describe, expect, it } from 'vitest';
import { isPrivateOrReservedHost } from '../src/services/net-guard.js';

/**
 * Unit coverage for the shared address guard.
 *
 * These are the exact strings that decide whether a customer supplied hostname is
 * somewhere we are willing to open a connection to, and both webhook delivery and
 * the IMAP inbox now depend on this one function. A regression here is a server
 * side request forgery, so the cases are the literal attack strings rather than
 * the tidy ones.
 */
describe('private and reserved address guard', () => {
  it('refuses loopback however it is written', () => {
    for (const host of ['127.0.0.1', '2130706433', '0x7f000001', '017700000001', 'localhost', 'app.localhost']) {
      expect(isPrivateOrReservedHost(host), host).toBe(true);
    }
  });

  it('refuses RFC1918 and carrier grade NAT', () => {
    for (const host of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.1', '100.64.0.1', '100.127.255.254']) {
      expect(isPrivateOrReservedHost(host), host).toBe(true);
    }
  });

  /**
   * The single most valuable target on a cloud host, and the one range that was
   * missing. Answering 169.254.169.254 returns an IAM credential that can read
   * every other secret on the machine.
   */
  it('refuses the cloud metadata service by address', () => {
    for (const host of ['169.254.169.254', 'metadata.google.internal', 'metadata.goog', 'instance.compute.internal']) {
      expect(isPrivateOrReservedHost(host), host).toBe(true);
    }
  });

  it('refuses link-local and unique local IPv6', () => {
    for (const host of ['fe80::1', 'fe9a::1', 'feb0::1', 'fc00::1', 'fd12:3456::1', '::1', '::']) {
      expect(isPrivateOrReservedHost(host), host).toBe(true);
    }
  });

  it('refuses the unspecified and short names', () => {
    for (const host of ['0.0.0.0', '0', 'localhost', 'db.internal', 'cache.local', '']) {
      expect(isPrivateOrReservedHost(host), host).toBe(true);
    }
  });

  it('admits ordinary public addresses', () => {
    for (const host of ['example.com', 'hooks.slack.com', '8.8.8.8', '172.32.0.1', '100.63.255.254', '11.0.0.1']) {
      expect(isPrivateOrReservedHost(host), host).toBe(false);
    }
  });

  it('admits a bracketed IPv6 literal on a public range', () => {
    expect(isPrivateOrReservedHost('[2606:4700:4700::1111]')).toBe(false);
    expect(isPrivateOrReservedHost('[fe80::1]')).toBe(true);
  });

  /**
   * Stated as a limitation rather than a test, because it is the one thing this
   * function does not do and pretending otherwise would be worse than not having
   * it. A name that resolves to a private address passes, and closing that needs
   * a resolve-and-re-check immediately before connecting, which is where the two
   * call sites would have to change.
   */
  it('does not resolve names, so a hostname pointing inward still passes', () => {
    expect(isPrivateOrReservedHost('internal-service.example.com')).toBe(false);
  });
});