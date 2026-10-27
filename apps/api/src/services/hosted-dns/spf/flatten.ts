/**
 * Flattening SPF sources into address ranges.
 *
 * The rule is blunt on purpose: a source is flattened only when its whole
 * resolved tree is a monotonic list of pass mechanisms ending in a safe all.
 * Anything whose meaning depends on the message (exists, macros), on a
 * non-pass qualifier, or on a name we cannot read keeps its include so the
 * receiver evaluates it exactly as before. Publishing fewer addresses than
 * the source authorises is the one failure this module exists to prevent.
 */

import { isIP } from 'node:net';
import { evaluateSpfLookups } from '../../../scanner/spf-evaluate.js';
import type { DnsReader } from '../../../scanner/types.js';
import {
  formatCidr,
  isPrivateOrReservedNetwork,
  mergeNetworks,
  parseCidr,
  type ParsedCidr,
} from './networks.js';
import { parseSpfTerms, type SpfTerm } from './terms.js';

export type SpfSource =
  | { kind: 'include'; value: string }
  | { kind: 'ip4' | 'ip6'; value: string }
  | { kind: 'a' | 'mx'; value: string };

export interface SourceOutcome {
  source: SpfSource;
  mode: 'flattened' | 'passthrough' | 'refused' | 'error';
  /** Formatted and merged for flattened sources and user ip4/ip6. */
  networks: string[];
  /** What a passthrough costs a receiver; zero when flattened. */
  lookups: number;
  /** Why a source was passed through, refused or failed, in plain words. */
  reason: string | null;
}

export interface FlattenOptions {
  maxQueries?: number;
  deadlineMs?: number;
  /**
   * The domain the record belongs to, used for a bare a or mx. Extensions
   * beyond the two budget options are deliberate: the service always fills it,
   * and unit tests can omit it when every source names its own host.
   */
  customerDomain?: string;
  /**
   * Test seam for the reserved-range check. The documentation ranges used by
   * tests are classified as reserved by isNonPublicIp, so a test that wants
   * them to behave as public can say so explicitly.
   */
  isUnusableNetwork?: (network: ParsedCidr) => boolean;
}

interface Budget {
  queries: number;
  maxQueries: number;
  deadline: number;
}

const MAX_DEPTH = 10;
const MAX_MX_EXCHANGES = 10;
const budgetMessage = 'Not finished within the lookup budget.';
const internetMessage = 'This source authorises most of the internet.';
const privateMessage = 'Private addresses never send to the internet; SPF for them does nothing.';

type WalkMode = 'flattened' | 'passthrough' | 'refused' | 'error';

interface WalkResult {
  mode: WalkMode;
  networks: string[];
  reason: string | null;
}

interface Context {
  reader: DnsReader;
  budget: Budget;
  customerDomain: string;
  isUnusable: (network: ParsedCidr) => boolean;
}

function joins(chunks: string[][]): string[] {
  return chunks.map((chunk) => chunk.join('').trim());
}

function spfRecordsIn(chunks: string[][]): string[] {
  return joins(chunks).filter((record) => /^v=spf1(?:\s|$)/i.test(record));
}

function cleanHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}

function spend(context: Context, queries = 1): boolean {
  if (
    context.budget.queries + queries > context.budget.maxQueries ||
    Date.now() > context.budget.deadline
  ) {
    context.budget.queries = context.budget.maxQueries + 1;
    return false;
  }
  context.budget.queries += queries;
  return true;
}

function exhausted(context: Context): boolean {
  return context.budget.queries > context.budget.maxQueries || Date.now() > context.budget.deadline;
}

function error(reason: string): WalkResult {
  return { mode: 'error', networks: [], reason };
}

function refused(reason = internetMessage): WalkResult {
  return { mode: 'refused', networks: [], reason };
}

function passthrough(reason: string): WalkResult {
  return { mode: 'passthrough', networks: [], reason };
}

async function fetchSpf(target: string, context: Context): Promise<{ record?: string; reason?: string }> {
  if (!spend(context)) {
    return { reason: budgetMessage };
  }
  const result = await context.reader.resolveTxt(target);
  if (result.status === 'error') {
    return {
      reason: `The SPF record at ${target} could not be read (DNS error), so lookups below it were not counted.`,
    };
  }
  if (result.status === 'missing') {
    return { reason: `${target} does not exist or publishes nothing, so including it is a permanent error.` };
  }
  const records = spfRecordsIn(result.value ?? []);
  if (records.length === 0) {
    return { reason: `${target} publishes no SPF record, so including it is a permanent error.` };
  }
  if (records.length > 1) {
    return {
      reason: `${target} publishes ${records.length} SPF records, so including it is a permanent error.`,
    };
  }
  return { record: records[0] };
}

export interface HostSpec {
  host: string;
  v4Prefix: number | null;
  v6Prefix: number | null;
}

function parsePrefix(value: string, max: number): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const prefix = Number(value);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= max ? prefix : null;
}

export function parseHostSpec(value: string): HostSpec | null {
  const slash = value.indexOf('/');
  const host = cleanHost(slash < 0 ? value : value.slice(0, slash));
  let v4Prefix: number | null = null;
  let v6Prefix: number | null = null;
  if (slash >= 0) {
    const suffix = value.slice(slash);
    if (suffix.startsWith('//')) {
      v6Prefix = parsePrefix(suffix.slice(2), 128);
      if (v6Prefix === null) return null;
    } else {
      const second = suffix.indexOf('/', 1);
      const v4Text = second < 0 ? suffix.slice(1) : suffix.slice(1, second);
      v4Prefix = parsePrefix(v4Text, 32);
      if (v4Prefix === null) return null;
      if (second >= 0) {
        const rest = suffix.slice(second);
        if (!rest.startsWith('//')) return null;
        v6Prefix = parsePrefix(rest.slice(2), 128);
        if (v6Prefix === null) return null;
      }
    }
  }
  return { host, v4Prefix, v6Prefix };
}

function networkFor(address: string, prefix: number, family: 4 | 6): ParsedCidr | null {
  return parseCidr(`${address}/${prefix}`, family);
}

async function resolveHost(host: string, context: Context): Promise<{ addresses?: string[]; reason?: string }> {
  if (!context.reader.resolveAddress) {
    return { reason: 'This deployment cannot resolve addresses, so this source cannot be flattened.' };
  }
  if (!spend(context)) {
    return { reason: budgetMessage };
  }
  const result = await context.reader.resolveAddress(host);
  if (result.status === 'error') {
    return { reason: `The addresses of ${host} could not be read (DNS error).` };
  }
  if (result.status === 'missing' || !result.value || result.value.length === 0) {
    return { reason: `${host} has no addresses, so this a or mx source cannot be flattened.` };
  }
  return { addresses: result.value };
}

function networksFromAddresses(
  addresses: string[],
  prefixFor: (family: 4 | 6) => number,
): { networks?: string[]; reason?: string } {
  const networks: string[] = [];
  for (const address of addresses) {
    const family = isIP(address);
    if (family !== 4 && family !== 6) {
      continue;
    }
    const prefix = prefixFor(family);
    const minimum = family === 4 ? 8 : 16;
    if (prefix < minimum) {
      return { reason: internetMessage };
    }
    const network = networkFor(address, prefix, family);
    if (!network) {
      return { reason: `The address ${address} could not be read.` };
    }
    networks.push(formatCidr(network));
  }
  if (networks.length === 0) {
    return { reason: 'This source resolved to no usable addresses.' };
  }
  return { networks };
}

/**
 * A bare `a` or `mx` means the domain whose record is being evaluated (RFC
 * 7208 section 5: <domain>). Inside an included record that is the include
 * target, not the customer: `include:_spf.esp.example` holding `a mx` names the
 * provider's servers. Resolving the customer's domain there would publish the
 * customer's web server and drop the provider's mail servers.
 */
async function resolveA(spec: HostSpec, owner: string, context: Context): Promise<WalkResult> {
  const host = spec.host || cleanHost(owner);
  if (!host) {
    return error('This a term names no domain.');
  }
  if (host.includes('%')) {
    return passthrough('The source uses a macro, which depends on each message.');
  }
  const resolved = await resolveHost(host, context);
  if (!resolved.addresses) {
    return error(resolved.reason!);
  }
  const result = networksFromAddresses(resolved.addresses, (family) =>
    family === 4 ? spec.v4Prefix ?? 32 : spec.v6Prefix ?? 128,
  );
  if (!result.networks) {
    return result.reason === internetMessage ? refused() : error(result.reason!);
  }
  return { mode: 'flattened', networks: mergeNetworks(result.networks), reason: null };
}

async function resolveMx(spec: HostSpec, owner: string, context: Context): Promise<WalkResult> {
  const host = spec.host || cleanHost(owner);
  if (!host) {
    return error('This mx term names no domain.');
  }
  if (host.includes('%')) {
    return passthrough('The source uses a macro, which depends on each message.');
  }
  if (!spend(context)) {
    return error(budgetMessage);
  }
  const mx = await context.reader.resolveMx(host);
  if (mx.status === 'error') {
    return error(`The MX records of ${host} could not be read (DNS error).`);
  }
  if (mx.status === 'missing' || !mx.value || mx.value.length === 0) {
    return error(`${host} has no MX records, so this mx source cannot be flattened.`);
  }
  if (mx.value.length > MAX_MX_EXCHANGES) {
    return error(`${host} has ${mx.value.length} MX records; SPF allows at most ${MAX_MX_EXCHANGES}.`);
  }
  const networks: string[] = [];
  for (const record of mx.value) {
    const exchange = cleanHost(record.exchange);
    if (!exchange) {
      continue;
    }
    const resolved = await resolveHost(exchange, context);
    if (!resolved.addresses) {
      return error(resolved.reason!);
    }
    const result = networksFromAddresses(resolved.addresses, (family) =>
      family === 4 ? spec.v4Prefix ?? 32 : spec.v6Prefix ?? 128,
    );
    if (!result.networks) {
      return result.reason === internetMessage ? refused() : error(result.reason!);
    }
    networks.push(...result.networks);
  }
  if (networks.length === 0) {
    return error(`${host} has no usable MX addresses, so this mx source cannot be flattened.`);
  }
  return { mode: 'flattened', networks: mergeNetworks(networks), reason: null };
}

function hasMacro(value: string | null): boolean {
  return value !== null && value.includes('%');
}

async function walkRecord(
  owner: string,
  record: string,
  depth: number,
  path: string[],
  context: Context,
): Promise<WalkResult> {
  let terms: SpfTerm[];
  try {
    terms = parseSpfTerms(record);
  } catch (errorValue) {
    return error(errorValue instanceof Error ? errorValue.message : 'The SPF record could not be read.');
  }

  const allTerm = terms.find(
    (term): term is Extract<SpfTerm, { kind: 'mechanism' }> =>
      term.kind === 'mechanism' && term.name === 'all',
  );
  const hasAll = Boolean(allTerm);
  const redirect = terms.find(
    (term): term is Extract<SpfTerm, { kind: 'modifier' }> =>
      term.kind === 'modifier' && term.name === 'redirect',
  );

  const networks: string[] = [];

  for (const term of terms) {
    if (term.kind === 'modifier') {
      continue;
    }
    if (term.name === 'all') {
      break;
    }
    if (term.qualifier !== '+') {
      return passthrough(
        `The source uses "${term.raw}", which is not a pass mechanism. It is kept as an include.`,
      );
    }
    if (term.name === 'exists') {
      return passthrough(
        `The source uses "${term.raw}", which is evaluated for each message. It is kept as an include.`,
      );
    }
    if (term.name === 'ptr') {
      return passthrough(
        `The source uses "${term.raw}", which cannot be flattened. It is kept as an include.`,
      );
    }
    if (hasMacro(term.value)) {
      return passthrough(
        'The source uses a macro, which depends on each message. It is kept as an include.',
      );
    }

    if (term.name === 'include') {
      const target = cleanHost(term.value ?? '');
      if (!target) {
        return error(`"${term.raw}" in ${owner} names no domain.`);
      }
      if (path.includes(target)) {
        return error(`${owner} includes ${target}, which leads back to itself: receivers stop with a permanent error.`);
      }
      if (depth >= MAX_DEPTH) {
        return error('The include chain is deeper than 10 records.');
      }
      const fetched = await fetchSpf(target, context);
      if (!fetched.record) {
        return error(fetched.reason!);
      }
      const child = await walkRecord(target, fetched.record, depth + 1, [...path, target], context);
      if (child.mode !== 'flattened') {
        return child;
      }
      networks.push(...child.networks);
      continue;
    }

    if (term.name === 'a' || term.name === 'mx') {
      const spec = parseHostSpec(term.value ?? '');
      if (!spec) {
        return error(`"${term.raw}" has an invalid CIDR suffix.`);
      }
      const result = term.name === 'a'
        ? await resolveA(spec, owner, context)
        : await resolveMx(spec, owner, context);
      if (result.mode !== 'flattened') {
        return result;
      }
      networks.push(...result.networks);
      continue;
    }

    if (term.name === 'ip4' || term.name === 'ip6') {
      const family = term.name === 'ip4' ? 4 : 6;
      const network = parseCidr(term.value ?? '', family);
      if (!network) {
        return error(`"${term.raw}" is not a valid IPv${family} network.`);
      }
      const minimum = family === 4 ? 8 : 16;
      if (network.prefix < minimum) {
        return refused();
      }
      networks.push(formatCidr(network));
    }
  }

  if (!hasAll && redirect) {
    const target = cleanHost(redirect.value);
    if (!target) {
      return error('The redirect names no domain.');
    }
    if (hasMacro(target)) {
      return passthrough('The source uses a macro, which depends on each message. It is kept as an include.');
    }
    if (path.includes(target)) {
      return error(`${owner} redirects to ${target}, which leads back to itself: receivers stop with a permanent error.`);
    }
    if (depth >= MAX_DEPTH) {
      return error('The include chain is deeper than 10 records.');
    }
    const fetched = await fetchSpf(target, context);
    if (!fetched.record) {
      return error(fetched.reason!);
    }
    const redirected = await walkRecord(target, fetched.record, depth + 1, [...path, target], context);
    if (redirected.mode !== 'flattened') {
      return redirected;
    }
    networks.push(...redirected.networks);
  }

  if (allTerm && allTerm.qualifier === '+') {
    return refused();
  }

  return { mode: 'flattened', networks: mergeNetworks(networks), reason: null };
}

async function passthroughLookups(
  source: SpfSource,
  context: Context,
): Promise<{ lookups?: number; reason?: string }> {
  if (source.kind !== 'include') {
    return { lookups: 0 };
  }
  if (source.value.includes('%')) {
    return { lookups: 1 };
  }
  if (exhausted(context)) {
    return { reason: budgetMessage };
  }
  const remainingQueries = Math.max(1, context.budget.maxQueries - context.budget.queries);
  const remainingMs = Math.max(1, context.budget.deadline - Date.now());
  const evaluation = await evaluateSpfLookups(
    context.customerDomain || 'hosted-spf.invalid',
    `v=spf1 include:${source.value}`,
    context.reader,
    { maxQueries: remainingQueries, deadlineMs: remainingMs },
  );
  context.budget.queries += Math.max(1, evaluation.lookupCount);
  if (!evaluation.complete) {
    return {
      reason: evaluation.problems[0] ?? budgetMessage,
    };
  }
  return { lookups: evaluation.lookupCount };
}

async function flattenOne(source: SpfSource, context: Context): Promise<SourceOutcome> {
  const base = { source, networks: [] as string[], lookups: 0, reason: null as string | null };

  if (source.kind === 'ip4' || source.kind === 'ip6') {
    const family = source.kind === 'ip4' ? 4 : 6;
    const network = parseCidr(source.value, family);
    if (!network) {
      return { ...base, mode: 'error', reason: `"${source.value}" is not a valid IPv${family} network.` };
    }
    const minimum = family === 4 ? 8 : 16;
    if (network.prefix < minimum) {
      return { ...base, mode: 'refused', reason: internetMessage };
    }
    if (context.isUnusable(network)) {
      return { ...base, mode: 'refused', reason: privateMessage };
    }
    return { ...base, mode: 'flattened', networks: [formatCidr(network)] };
  }

  if (source.kind === 'a' || source.kind === 'mx') {
    const spec = parseHostSpec(source.value);
    if (!spec) {
      return { ...base, mode: 'error', reason: `"${source.value}" has an invalid CIDR suffix.` };
    }
    const result = source.kind === 'a'
      ? await resolveA(spec, context.customerDomain, context)
      : await resolveMx(spec, context.customerDomain, context);
    return {
      source,
      mode: result.mode,
      networks: result.networks,
      lookups: 0,
      reason: result.reason,
    };
  }

  const target = cleanHost(source.value);
  if (!target) {
    return { ...base, mode: 'error', reason: 'This include names no domain.' };
  }
  if (target.includes('%')) {
    return {
      ...base,
      mode: 'passthrough',
      lookups: 1,
      reason: 'The source uses a macro, which depends on each message. It is kept as an include.',
    };
  }
  if (exhausted(context)) {
    return { ...base, mode: 'error', reason: budgetMessage };
  }
  const fetched = await fetchSpf(target, context);
  if (!fetched.record) {
    return { ...base, mode: 'error', reason: fetched.reason! };
  }
  const walked = await walkRecord(target, fetched.record, 0, [target], context);
  if (walked.mode !== 'passthrough') {
    return {
      source,
      mode: walked.mode,
      networks: walked.networks,
      lookups: 0,
      reason: walked.reason,
    };
  }

  const counted = await passthroughLookups(source, context);
  if (counted.lookups === undefined) {
    return { ...base, mode: 'error', reason: counted.reason ?? budgetMessage };
  }
  return {
    source,
    mode: 'passthrough',
    networks: [],
    lookups: counted.lookups,
    reason: walked.reason,
  };
}

export async function flattenSources(
  sources: SpfSource[],
  reader: DnsReader,
  options: FlattenOptions = {},
): Promise<SourceOutcome[]> {
  const context: Context = {
    reader,
    budget: {
      queries: 0,
      maxQueries: options.maxQueries ?? 200,
      deadline: Date.now() + (options.deadlineMs ?? 20_000),
    },
    customerDomain: cleanHost(options.customerDomain ?? ''),
    isUnusable: options.isUnusableNetwork ?? isPrivateOrReservedNetwork,
  };

  const outcomes: SourceOutcome[] = [];
  for (const source of sources) {
    outcomes.push(await flattenOne(source, context));
  }
  return outcomes;
}
