import { Resolver } from 'node:dns/promises';
import type { DnsReader, LookupResult, MxRecord } from './types.js';

const resolver = new Resolver({ tries: 1, timeout: 2500 });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'DNS lookup failed.';
}

function isMissingError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false;
  }

  const code = String((error as { code?: unknown }).code ?? '');
  return code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN';
}

/** Names under these have no authority to ask (RFC 2606, RFC 6761). */
const RESERVED_SUFFIX = /\.(test|example|invalid|localhost|local)$/i;

/**
 * The domain's own nameservers' IPv4 addresses, found by walking up from
 * `name` to the first label that has NS records. Null when none answer.
 */
async function authoritativeServers(name: string): Promise<string[] | null> {
  const labels = name.replace(/\.$/, '').split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    let hosts: string[];
    try {
      hosts = await resolver.resolveNs(candidate);
    } catch {
      continue;
    }
    if (hosts.length === 0) continue;
    const addresses = (
      await Promise.all(hosts.slice(0, 4).map((host) => resolver.resolve4(host).catch(() => [] as string[])))
    ).flat();
    return addresses.length > 0 ? [...new Set(addresses)].slice(0, 4) : null;
  }
  return null;
}

/**
 * A TXT lookup for a record someone has just published, such as an ownership
 * token.
 *
 * Asked of the zone's own nameservers first, because a recursive resolver
 * caches "no such record" for the zone's negative TTL (30 minutes on
 * Cloudflare). A Check pressed before the record existed then kept answering
 * "not found" for half an hour after it was published. Authoritative servers
 * do not cache their own zone.
 *
 * A found answer from them is taken as is. Anything else falls back to the
 * system resolver's answer, so a network that blocks direct DNS, or a name
 * with no authority (the reserved test TLDs), behaves exactly as before.
 */
export async function resolveTxtFresh(name: string, zoneHint: string): Promise<LookupResult<string[][]>> {
  if (!RESERVED_SUFFIX.test(zoneHint)) {
    try {
      const servers = await authoritativeServers(zoneHint);
      if (servers) {
        const direct = new Resolver({ tries: 1, timeout: 2500 });
        direct.setServers(servers);
        const value = await direct.resolveTxt(name);
        if (value.length > 0) return { status: 'found', value };
      }
    } catch {
      // Missing or unreachable at the authority: the system resolver decides.
    }
  }
  return systemDnsReader.resolveTxt(name);
}

export const systemDnsReader: DnsReader = {
  async resolveTxt(name: string): Promise<LookupResult<string[][]>> {
    try {
      return { status: 'found', value: await resolver.resolveTxt(name) };
    } catch (error) {
      return {
        status: isMissingError(error) ? 'missing' : 'error',
        error: errorMessage(error),
      };
    }
  },

  async resolveMx(name: string): Promise<LookupResult<MxRecord[]>> {
    try {
      const records = await resolver.resolveMx(name);
      return {
        status: 'found',
        value: records.map((record) => ({
          exchange: record.exchange,
          priority: record.priority,
        })),
      };
    } catch (error) {
      return {
        status: isMissingError(error) ? 'missing' : 'error',
        error: errorMessage(error),
      };
    }
  },

  async resolveCname(name: string): Promise<LookupResult<string[]>> {
    try {
      return { status: 'found', value: await resolver.resolveCname(name) };
    } catch (error) {
      return {
        status: isMissingError(error) ? 'missing' : 'error',
        error: errorMessage(error),
      };
    }
  },

  async resolvePtr(ip: string): Promise<LookupResult<string[]>> {
    try {
      return { status: 'found', value: await resolver.reverse(ip) };
    } catch (error) {
      return {
        status: isMissingError(error) ? 'missing' : 'error',
        error: errorMessage(error),
      };
    }
  },

  /**
   * A and AAAA together: "missing" only when the name has neither, which is
   * what makes an SPF "a" term a void lookup (RFC 7208 section 4.6.4).
   */
  async resolveAddress(name: string): Promise<LookupResult<string[]>> {
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(name), resolver.resolve6(name)]);
    const addresses = [
      ...(v4.status === 'fulfilled' ? v4.value : []),
      ...(v6.status === 'fulfilled' ? v6.value : []),
    ];
    if (addresses.length > 0) {
      return { status: 'found', value: addresses };
    }
    const failures = [v4, v6].filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.every((failure) => isMissingError(failure.reason))) {
      return { status: 'missing' };
    }
    return { status: 'error', error: errorMessage(failures.find((failure) => !isMissingError(failure.reason))?.reason) };
  },
};
