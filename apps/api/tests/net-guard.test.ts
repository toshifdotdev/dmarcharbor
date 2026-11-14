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

  it('refuses IPv6 forms that carry a private IPv4 address inside them', () => {
    // A dual-stack host connects ::ffff:10.0.0.5 to 10.0.0.5, and the URL
    // parser rewrites the dotted form to hex, so both spellings must refuse.
    for (const host of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '[::ffff:a9fe:a9fe]',
      '::ffff:10.0.0.5',
      '::10.0.0.5',
      '64:ff9b::a00:5',
      '64:ff9b::169.254.169.254',
      '2002:a9fe:a9fe::1',
      '2001:0:4136:e378::1',
      'ff02::1',
    ]) {
      expect(isPrivateOrReservedHost(host), host).toBe(true);
    }
    // The same forms around a public address are just that address.
    expect(isPrivateOrReservedHost('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedHost('64:ff9b::808:808')).toBe(false);
  });

  it('refuses multicast, reserved and benchmarking IPv4 ranges', () => {
    for (const host of ['224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.0.8']) {
      expect(isPrivateOrReservedHost(host), host).toBe(true);
    }
  });

  it('does not refuse a public name that merely starts like a private IPv6 prefix', () => {
    expect(isPrivateOrReservedHost('fdic.gov')).toBe(false);
    expect(isPrivateOrReservedHost('fcm.googleapis.com')).toBe(false);
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