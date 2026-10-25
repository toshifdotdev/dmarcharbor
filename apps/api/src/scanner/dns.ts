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
