import { describe, expect, it } from 'vitest';
import { assertPublicHost } from '../src/services/net-guard.js';

/**
 * The host check has to answer where a connection will go, not what was typed.
 *
 * `isPrivateOrReservedHost` only ever sees the string as written, so a hostname
 * that reads as public passes and is then free to answer `169.254.169.254` at
 * connect time. `assertPublicHost` closes that by resolving, checking every
 * answer, and returning the addresses so the caller can pin the socket to what
 * was checked.
 *
 * The resolution is injected rather than performed, so the tests describe the
 * guard rather than the network. A test that depends on real DNS either fails in
 * an offline environment or passes for reasons unrelated to the check.
 */

/** Resolves to the given addresses, rejecting with a resolver-shaped error on none. */
function lookupReturning(addresses: Array<{ address: string }>) {
  return async () => {
    if (addresses.length === 0) {
      throw new Error('EAI_AGAIN');
    }
    return addresses;
  };
}

describe('the host check resolves before allowing a connection', () => {
  it('refuses a hostname that answers a link-local address', async () => {
    // 169.254.169.254 is the cloud metadata service, which returns credentials
    // that can read every other secret on the machine.
    await expect(
      assertPublicHost('rebind.attacker.test', lookupReturning([{ address: '169.254.169.254' }])),
    ).rejects.toThrow(/private or reserved/i);
  });

  it('refuses when any answer in a round robin is private', async () => {
    // One public address and one private: the check is over the whole answer set
    // because the resolver may order them either way.
    await expect(
      assertPublicHost('mixed.test', lookupReturning([{ address: '203.0.113.10' }, { address: '10.0.0.5' }])),
    ).rejects.toThrow(/private or reserved/i);
  });

  it('refuses a host that does not resolve at all', async () => {
    await expect(
      assertPublicHost('nowhere.test', lookupReturning([])),
    ).rejects.toThrow(/did not resolve|EAI/i);
  });

  it('refuses a literal private address without asking the resolver', async () => {
    // Already an address, so there is nothing to resolve and no window to close.
    let called = 0;
    await expect(
      assertPublicHost('192.168.1.10', async () => {
        called += 1;
        return [];
      }),
    ).rejects.toThrow(/private or reserved/i);
    // The resolver must not be consulted for a literal address: the answer is
    // already known, and resolving it would decide the wrong question.
    expect(called).toBe(0);
  });

  it('allows a host that answers only public addresses, and returns them', async () => {
    const addresses = [{ address: '203.0.113.10' }, { address: '203.0.113.11' }];

    // The addresses are returned so the caller can pin the socket to them.
    expect(await assertPublicHost('reports.acme.test', lookupReturning(addresses))).toEqual(addresses);
  });

  it('refuses the metadata hostnames, which resolve but read as ordinary', async () => {
    // Checked for the name, not just the resolved address, because these are the
    // targets where that distinction is lost.
    for (const host of ['metadata.google.internal', 'metadata.goog', 'instance.compute.internal']) {
      await expect(
        assertPublicHost(host, lookupReturning([{ address: '203.0.113.10' }])),
      ).rejects.toThrow(/private or reserved/i);
    }
  });
});
