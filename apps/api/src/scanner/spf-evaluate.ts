import type { DnsReader, SpfLookupNode } from './types.js';

/**
 * Counting SPF DNS lookups the way a receiver does (RFC 7208 section 4.6.4).
 *
 * The terms that cost a lookup are the include, a, mx, ptr and exists
 * mechanisms and the redirect modifier, and the count runs through every
 * include and redirect: a record with three includes that each hold four more
 * costs 15, not 3. More than 10 and the receiver stops with a permanent error,
 * which means SPF fails for every message. The scanner used to count only the
 * top-level record, so it reported 3 where receivers counted 15.
 *
 * Also checked on the way, because each one is a permanent error at the
 * receiver too:
 * - more than two void lookups (names that return nothing);
 * - an include whose target publishes no SPF record, or more than one;
 * - a loop (a record that includes itself, directly or not);
 * - an mx term whose name has more than 10 MX records.
 *
 * Bounded: at most `maxQueries` DNS queries and `deadlineMs`, after which the
 * result says it is incomplete rather than guessing. The public checker runs
 * this, and a hostile record must not be able to make it run forever.
 */

export const spfLookupLimit = 10;
export const spfVoidLookupLimit = 2;

export interface SpfLookupEvaluation {
  lookupCount: number;
  voidLookupCount: number;
  lookupLimitExceeded: boolean;
  voidLookupLimitExceeded: boolean;
  tree: SpfLookupNode[];
  problems: string[];
  complete: boolean;
}

interface Options {
  maxQueries?: number;
  maxDepth?: number;
  deadlineMs?: number;
}

const QUALIFIER = /^[+\-~?]/;

function isMacro(target: string): boolean {
  return target.includes('%');
}

/** The domain-spec after "include:", "redirect=" and similar, without a CIDR suffix. */
function targetOf(term: string, separator: ':' | '='): string | null {
  const index = term.indexOf(separator);
  if (index < 0) {
    return null;
  }
  const value = term.slice(index + 1).split('/')[0]!.trim().toLowerCase().replace(/\.$/, '');
  return value || null;
}

function spfRecordsIn(txt: string[][]): string[] {
  return txt
    .map((chunks) => chunks.join('').trim())
    .filter((record) => /^v=spf1(?:\s|$)/i.test(record));
}

export async function evaluateSpfLookups(
  domain: string,
  record: string,
  reader: DnsReader,
  options: Options = {},
): Promise<SpfLookupEvaluation> {
  const maxQueries = options.maxQueries ?? 40;
  const maxDepth = options.maxDepth ?? 10;
  const deadline = Date.now() + (options.deadlineMs ?? 8_000);

  let lookups = 0;
  let voids = 0;
  let queries = 0;
  let complete = true;
  const problems = new Set<string>();

  const budgetLeft = (): boolean => {
    if (queries >= maxQueries || Date.now() > deadline) {
      complete = false;
      return false;
    }
    return true;
  };

  async function fetchSpf(target: string): Promise<{ record?: string; void: boolean; problem?: string; failed?: boolean }> {
    queries += 1;
    const result = await reader.resolveTxt(target);
    if (result.status === 'error') {
      complete = false;
      return { void: false, failed: true, problem: `The SPF record at ${target} could not be read (DNS error), so lookups below it were not counted.` };
    }
    if (result.status === 'missing') {
      return { void: true, problem: `${target} does not exist or publishes nothing, so including it is a permanent error.` };
    }
    const records = spfRecordsIn(result.value ?? []);
    if (records.length === 0) {
      return { void: false, problem: `${target} publishes no SPF record, so including it is a permanent error.` };
    }
    if (records.length > 1) {
      return { void: false, problem: `${target} publishes ${records.length} SPF records, so including it is a permanent error.` };
    }
    return { record: records[0], void: false };
  }

  async function walk(owner: string, spf: string, depth: number, path: string[]): Promise<SpfLookupNode[]> {
    const terms = spf.trim().split(/\s+/).slice(1).filter(Boolean);
    const hasAll = terms.some((term) => /^[+\-~?]?all$/i.test(term));

    // Each term becomes a node first; includes and redirects are fetched
    // together afterwards, so a deep record costs depth, not breadth, in time.
    const nodes: SpfLookupNode[] = [];
    const recursions: Array<{ node: SpfLookupNode; target: string }> = [];

    for (const raw of terms) {
      const term = raw.replace(QUALIFIER, '');
      const lower = term.toLowerCase();

      if (lower.startsWith('include:') || lower.startsWith('redirect=')) {
        const isRedirect = lower.startsWith('redirect=');
        const target = targetOf(term, isRedirect ? '=' : ':');
        if (isRedirect && hasAll) {
          // RFC 7208 section 6.1: redirect is ignored when the record has "all".
          nodes.push({ term: raw, lookups: 0, note: 'Ignored: the record also has an "all" mechanism.' });
          continue;
        }
        lookups += 1;
        const node: SpfLookupNode = { term: raw, lookups: 1 };
        nodes.push(node);
        if (!target) {
          problems.add(`"${raw}" in ${owner} names no domain.`);
        } else if (isMacro(target)) {
          node.note = 'Uses a macro, which depends on each message, so what it includes cannot be counted in advance.';
        } else if (path.includes(target)) {
          problems.add(`${owner} includes ${target}, which leads back to itself: receivers stop with a permanent error.`);
          node.note = 'Loop.';
        } else if (depth >= maxDepth) {
          complete = false;
          node.note = 'Not followed: the include chain is too deep.';
        } else {
          recursions.push({ node, target });
        }
        continue;
      }

      if (lower === 'a' || lower.startsWith('a:') || lower.startsWith('a/')) {
        lookups += 1;
        const node: SpfLookupNode = { term: raw, lookups: 1 };
        nodes.push(node);
        const target = lower.startsWith('a:') ? targetOf(term, ':') : owner;
        if (target && !isMacro(target) && reader.resolveAddress && budgetLeft()) {
          queries += 1;
          const result = await reader.resolveAddress(target);
          if (result.status === 'missing') {
            voids += 1;
            node.note = `${target} has no address, so this is a void lookup.`;
          }
        }
        continue;
      }

      if (lower === 'mx' || lower.startsWith('mx:') || lower.startsWith('mx/')) {
        lookups += 1;
        const node: SpfLookupNode = { term: raw, lookups: 1 };
        nodes.push(node);
        const target = lower.startsWith('mx:') ? targetOf(term, ':') : owner;
        if (target && !isMacro(target) && budgetLeft()) {
          queries += 1;
          const result = await reader.resolveMx(target);
          if (result.status === 'missing') {
            voids += 1;
            node.note = `${target} has no MX records, so this is a void lookup.`;
          } else if (result.status === 'found' && (result.value?.length ?? 0) > spfLookupLimit) {
            problems.add(`${target} has ${result.value!.length} MX records; an SPF "mx" term allows at most 10.`);
          }
        }
        continue;
      }

      if (lower === 'ptr' || lower.startsWith('ptr:')) {
        lookups += 1;
        nodes.push({ term: raw, lookups: 1, note: 'Deprecated: RFC 7208 section 5.5 says ptr should not be used.' });
        problems.add(`${owner} uses "ptr", which RFC 7208 says not to use: it is slow, unreliable, and some receivers ignore it.`);
        continue;
      }

      if (lower.startsWith('exists:')) {
        lookups += 1;
        nodes.push({ term: raw, lookups: 1 });
      }
      // ip4, ip6, all and exp= cost no lookup at evaluation time.
    }

    const fetched = await Promise.all(
      recursions.map(async ({ node, target }) => {
        if (!budgetLeft()) {
          node.note = 'Not followed: the lookup budget for one scan was reached.';
          return null;
        }
        return { node, target, result: await fetchSpf(target) };
      }),
    );

    for (const entry of fetched) {
      if (!entry) {
        continue;
      }
      const { node, target, result } = entry;
      if (result.void) {
        voids += 1;
      }
      if (result.problem) {
        if (!result.failed) {
          problems.add(result.problem);
        }
        node.note = result.problem;
      }
      if (result.record) {
        const children = await walk(target, result.record, depth + 1, [...path, target]);
        node.children = children;
        node.lookups += children.reduce((total, child) => total + child.lookups, 0);
      }
    }

    return nodes;
  }

  const normalizedDomain = domain.toLowerCase().replace(/\.$/, '');
  const tree = await walk(normalizedDomain, record, 0, [normalizedDomain]);

  return {
    lookupCount: lookups,
    voidLookupCount: voids,
    lookupLimitExceeded: lookups > spfLookupLimit,
    voidLookupLimitExceeded: voids > spfVoidLookupLimit,
    tree,
    problems: [...problems],
    complete,
  };
}
