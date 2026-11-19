import { isIPv4, isIPv6 } from 'node:net';
import type { DnsReader, SpfLookupNode } from './types.js';

/**
 * Counting SPF DNS lookups the way a receiver does (RFC 7208 section 4.6.4).
 *
 * The terms that cost a lookup are the include, a, mx, ptr and exists
 * mechanisms and the redirect modifier, and the count runs through every
 * include and redirect: a record with three includes that each hold four more
 * costs 15, not 3. The scanner used to count only the top-level record, so it
 * reported 3 where receivers counted 15.
 *
 * A receiver checks the terms in order and stops at the first one that
 * matches the sending server, so the limit bites where evaluation reaches the
 * 11th lookup: mail matched by a term before that point still passes, and
 * mail from every service from there on gets a permanent error. The term
 * where that happens is reported as `limitReachedAt`.
 *
 * Also checked on the way, because each one is a permanent error at the
 * receiver too:
 * - a syntax error in the record or in a record it includes (`~al` for
 *   `~all`, an unknown mechanism, a malformed ip4 or ip6 term);
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
  /** The top-level term during which evaluation passes 10 lookups, when it does. */
  limitReachedAt?: string;
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

export interface SpfSyntaxError {
  term: string;
  /** Why the term breaks the grammar, with the likely intended term where one is obvious. */
  reason: string;
}

const MECHANISM = /^([a-z][a-z0-9]*)(.*)$/;
const MODIFIER = /^([a-z][a-z0-9_.-]*)=(.*)$/i;
const DUAL_CIDR = /^(?:\/(\d{1,2}))?(?:\/\/(\d{1,3}))?$/;

function cidrProblem(suffix: string | undefined, max: number): boolean {
  return suffix !== undefined && Number(suffix) > max;
}

/** "a" and "mx" take an optional domain and an optional ip4 and ip6 prefix length (a:host/24//64). */
function hostTermProblem(rest: string): boolean {
  let tail = rest;
  if (tail.startsWith(':')) {
    const slash = tail.indexOf('/');
    const host = slash < 0 ? tail.slice(1) : tail.slice(1, slash);
    if (!host) {
      return true;
    }
    tail = slash < 0 ? '' : tail.slice(slash);
  }
  const cidr = DUAL_CIDR.exec(tail);
  return !cidr || cidrProblem(cidr[1], 32) || cidrProblem(cidr[2], 128);
}

function addressTermProblem(rest: string, family: 4 | 6): string | null {
  if (!rest.startsWith(':')) {
    return `ip${family} needs an address, as in ip${family}:${family === 4 ? '192.0.2.0/24' : '2001:db8::/32'}`;
  }
  const value = rest.slice(1);
  const slash = value.lastIndexOf('/');
  const address = slash < 0 ? value : value.slice(0, slash);
  const prefix = slash < 0 ? undefined : value.slice(slash + 1);
  const validAddress = family === 4 ? isIPv4(address) : isIPv6(address);
  const max = family === 4 ? 32 : 128;
  if (!validAddress) {
    return `"${address}" is not an IPv${family} address`;
  }
  if (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max)) {
    return `/${prefix} is not an IPv${family} prefix length (0 to ${max})`;
  }
  return null;
}

/** The term someone most likely meant, for the mistakes seen in real records. */
function likelyMeant(raw: string, name: string): string | null {
  const qualifier = QUALIFIER.test(raw) ? raw[0] : '';
  if (/^al+$/.test(name) || (name.startsWith('all') && name !== 'all')) {
    return `${qualifier}all`;
  }
  if (name === 'ipv4' || name === 'ipv6') {
    return raw.replace(/ipv([46])/i, 'ip$1');
  }
  if (name === 'includes' || name === 'inlcude' || name === 'incude') {
    return raw.replace(new RegExp(name, 'i'), 'include');
  }
  return null;
}

/** Why a mechanism term does not parse, or null when it does. */
function mechanismProblem(raw: string, name: string, rest: string, parsed: boolean): string | null {
  switch (name) {
    case 'all':
      return rest === '' ? null : '"all" takes no value';
    case 'include':
    case 'exists':
      return rest.startsWith(':') ? null : `${name} needs a domain, as in ${name}:example.com`;
    case 'a':
    case 'mx':
      return hostTermProblem(rest) ? `"${raw}" is not a valid ${name} term` : null;
    case 'ptr':
      return rest === '' || (rest.startsWith(':') && rest.length > 1) ? null : '"ptr" takes an optional domain after a colon';
    case 'ip4':
      return addressTermProblem(rest, 4);
    case 'ip6':
      return addressTermProblem(rest, 6);
    default: {
      const meant = parsed ? likelyMeant(raw, name) : null;
      return meant ? `not an SPF mechanism; did you mean "${meant}"?` : 'not an SPF mechanism or modifier';
    }
  }
}

/**
 * Terms that break the SPF grammar (RFC 7208 section 12). A syntax error
 * anywhere in a record makes check_host() return permerror before it looks at
 * a single mechanism (section 4.6), so one stray character fails SPF for every
 * message the domain sends, at receivers that follow the standard.
 *
 * Unknown modifiers (name=value) are allowed and ignored, as the standard
 * says. An include, exists or redirect with an empty domain is left to the
 * lookup walk, which already reports it as naming no domain.
 */
export function spfSyntaxErrors(record: string): SpfSyntaxError[] {
  const terms = record.trim().split(/\s+/).slice(1).filter(Boolean);
  const errors: SpfSyntaxError[] = [];
  const modifiersSeen = new Set<string>();
  for (const raw of terms) {
    const modifier = MODIFIER.exec(raw);
    if (modifier) {
      const name = modifier[1]!.toLowerCase();
      if (name === 'redirect' || name === 'exp') {
        if (modifiersSeen.has(name)) {
          errors.push({ term: raw, reason: `${name}= may appear only once in a record` });
        }
        modifiersSeen.add(name);
      }
      continue;
    }
    const term = raw.replace(QUALIFIER, '');
    const parts = MECHANISM.exec(term.toLowerCase());
    const name = parts?.[1] ?? '';
    const rest = parts?.[2] ?? term;
    const reason = mechanismProblem(raw, name, rest, parts !== null);
    if (reason) {
      errors.push({ term: raw, reason });
    }
  }
  return errors;
}

/** How a syntax error in the domain's own record is reported. */
export function describeSpfSyntaxError(error: SpfSyntaxError): string {
  return (
    `"${error.term}" is not valid SPF syntax (${error.reason}). A syntax error anywhere in the record makes the whole ` +
    'SPF check a permanent error (RFC 7208 section 4.6), so receivers that follow the standard fail SPF for all mail from this domain.'
  );
}

/**
 * The top-level term during which a receiver passes the lookup limit.
 *
 * Walks the counted tree in evaluation order: a term's own lookup first, then
 * what it pulls in, and a redirect only after every mechanism, because
 * receivers apply redirect last wherever it is written.
 */
function termReachingLimit(tree: SpfLookupNode[]): string | undefined {
  let used = 0;
  const inOrder = (nodes: SpfLookupNode[]): SpfLookupNode[] => [
    ...nodes.filter((node) => !/^[+\-~?]?redirect=/i.test(node.term)),
    ...nodes.filter((node) => /^[+\-~?]?redirect=/i.test(node.term)),
  ];
  const passes = (node: SpfLookupNode): boolean => {
    const children = node.children ?? [];
    used += node.lookups - children.reduce((total, child) => total + child.lookups, 0);
    if (used > spfLookupLimit) {
      return true;
    }
    return inOrder(children).some(passes);
  };
  return inOrder(tree).find(passes)?.term;
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
    for (const error of spfSyntaxErrors(spf)) {
      problems.add(
        depth === 0
          ? describeSpfSyntaxError(error)
          : `The SPF record at ${owner} has "${error.term}", which is not valid SPF syntax (${error.reason}), so including it is a permanent error.`,
      );
    }
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
  const limitReachedAt = lookups > spfLookupLimit ? termReachingLimit(tree) : undefined;

  return {
    lookupCount: lookups,
    voidLookupCount: voids,
    lookupLimitExceeded: lookups > spfLookupLimit,
    voidLookupLimitExceeded: voids > spfVoidLookupLimit,
    tree,
    problems: [...problems],
    complete,
    ...(limitReachedAt ? { limitReachedAt } : {}),
  };
}
