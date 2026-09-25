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
};
