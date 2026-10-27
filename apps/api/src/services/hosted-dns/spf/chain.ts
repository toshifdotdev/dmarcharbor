/**
 * Laying flattened networks out as one SPF record plus continuations.
 *
 * A TXT record has a practical ceiling around 255 bytes per character-string
 * and this product caps a part at 450 characters. The entry record carries the
 * networks that fit, then includes each continuation. A continuation that does
 * not match returns neutral, so the parent keeps evaluating: an address list
 * split across parts means exactly the same thing as one long list.
 */

import { formatCidr, parseCidr, type ParsedCidr } from './networks.js';

export interface SpfPart {
  name: string;
  content: string;
}

export interface ChainInput {
  token: string;
  zone: string;
  allQualifier: '-all' | '~all';
  /** Already merged across every flattened source and user ip4/ip6. */
  networks: string[];
  /** 'include:<domain>' terms, in source order. */
  passthrough: string[];
  /**
   * Lookup cost of each passthrough term. A plain include costs 1, but a
   * provider's include can pull in more, and the receiver's 10-lookup limit
   * counts all of them. Omitted entries default to one.
   */
  passthroughLookups?: number[];
}

export type ChainResult =
  | { parts: SpfPart[]; lookupCount: number }
  | { error: 'TOO_MANY_LOOKUPS' | 'TOO_MANY_PARTS'; lookupCount: number };

const MAX_PART_LENGTH = 450;
const MAX_CONTINUATIONS = 8;
const MAX_LOOKUPS = 10;

function sortKey(network: ParsedCidr): [number, bigint, number] {
  return [network.family === 4 ? 0 : 1, network.bits, network.prefix];
}

function compareKeys(a: [number, bigint, number], b: [number, bigint, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] < b[1]) return -1;
  if (a[1] > b[1]) return 1;
  return a[2] - b[2];
}

function sortedNetworks(networks: string[]): string[] {
  const parsed: Array<{ text: string; key: [number, bigint, number] }> = [];
  for (const text of networks) {
    const family = text.includes(':') ? 6 : 4;
    const network = parseCidr(text, family);
    if (network) {
      parsed.push({ text: formatCidr(network), key: sortKey(network) });
    }
  }
  parsed.sort((a, b) => compareKeys(a.key, b.key));
  return parsed.map((entry) => entry.text);
}

function contentLength(terms: string[]): number {
  return terms.length === 0 ? 0 : terms.join(' ').length;
}

function entryPrefix(token: string, zone: string, continuations: number): string[] {
  const names: string[] = [];
  for (let index = 0; index < continuations; index += 1) {
    names.push(`include:${token}-${index + 2}.spf.${zone}`);
  }
  return names;
}

function buildFor(input: ChainInput, networks: string[], continuations: number): SpfPart[] | null {
  const includes = entryPrefix(input.token, input.zone, continuations);
  const entrySuffix = [...includes, ...input.passthrough, input.allQualifier];
  const entryTerms = ['v=spf1', ...entrySuffix];
  if (contentLength(entryTerms) > MAX_PART_LENGTH) {
    return null;
  }

  let taken = 0;
  const entryNetworks: string[] = [];
  while (taken < networks.length) {
    const candidate = [...entryTerms.slice(0, 1), ...entryNetworks, networks[taken]!, ...entrySuffix];
    if (contentLength(candidate) > MAX_PART_LENGTH) {
      break;
    }
    entryNetworks.push(networks[taken]!);
    taken += 1;
  }

  const remaining = networks.slice(taken);
  const chunks: string[][] = [];
  let index = 0;
  for (let part = 0; part < continuations; part += 1) {
    const chunk: string[] = [];
    while (index < remaining.length) {
      const candidate = ['v=spf1', ...chunk, remaining[index]!];
      if (contentLength(candidate) > MAX_PART_LENGTH) {
        break;
      }
      chunk.push(remaining[index]!);
      index += 1;
    }
    chunks.push(chunk);
  }
  if (index < remaining.length) {
    return null;
  }
  if (chunks.some((chunk) => chunk.length === 0)) {
    return null;
  }

  const parts: SpfPart[] = [
    {
      name: `${input.token}.spf.${input.zone}`,
      content: ['v=spf1', ...entryNetworks, ...entrySuffix].join(' '),
    },
  ];
  for (let part = 0; part < continuations; part += 1) {
    parts.push({
      name: `${input.token}-${part + 2}.spf.${input.zone}`,
      content: ['v=spf1', ...chunks[part]!].join(' '),
    });
  }
  return parts;
}

export function buildSpfChain(input: ChainInput): ChainResult {
  const networks = sortedNetworks(input.networks);
  const passthroughLookups = input.passthrough.map(
    (_, index) => input.passthroughLookups?.[index] ?? 1,
  );
  const passthroughTotal = passthroughLookups.reduce((total, value) => total + Math.max(0, value), 0);
  if (1 + passthroughTotal > MAX_LOOKUPS) {
    return { error: 'TOO_MANY_LOOKUPS', lookupCount: 1 + passthroughTotal };
  }

  for (let continuations = 0; continuations <= MAX_CONTINUATIONS; continuations += 1) {
    const parts = buildFor(input, networks, continuations);
    if (!parts) {
      continue;
    }
    const lookupCount = 1 + continuations + passthroughTotal;
    if (parts.length > 9) {
      return { error: 'TOO_MANY_PARTS', lookupCount };
    }
    if (lookupCount > MAX_LOOKUPS) {
      return { error: 'TOO_MANY_LOOKUPS', lookupCount };
    }
    return { parts, lookupCount };
  }

  return { error: 'TOO_MANY_PARTS', lookupCount: 1 + MAX_CONTINUATIONS + passthroughTotal };
}
