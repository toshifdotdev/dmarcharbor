/**
 * The apex record, and importing the customer's existing one.
 *
 * redirect= is what makes the whole arrangement safe: the customer keeps one
 * record that names us, our zone carries the all term, and the customer never
 * edits DNS again. Importing the old record is deliberately conservative:
 * anything whose meaning we cannot reproduce as a source list refuses the
 * import rather than silently dropping authorisation.
 */

import { parseCidr } from './networks.js';
import { parseSpfTerms, type SpfTerm } from './terms.js';
import type { SpfSource } from './flatten.js';

export function apexRecordFor(token: string, zone: string): string {
  return `v=spf1 redirect=${token}.spf.${zone}`;
}

function cleanHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}

function spfRecords(records: string[]): string[] {
  return records
    .map((record) => record.trim())
    .filter((record) => /^v=spf1(?:\s|$)/i.test(record));
}

/**
 * True only when the apex has exactly one SPF record whose only mechanism is
 * an optional all and whose redirect points at our entry record.
 */
export function apexPointsAtUs(records: string[], token: string, zone: string): boolean {
  const found = spfRecords(records);
  if (found.length !== 1) {
    return false;
  }
  let terms: SpfTerm[];
  try {
    terms = parseSpfTerms(found[0]!);
  } catch {
    return false;
  }
  const mechanisms = terms.filter(
    (term): term is Extract<SpfTerm, { kind: 'mechanism' }> => term.kind === 'mechanism',
  );
  if (mechanisms.some((term) => term.name !== 'all')) {
    return false;
  }
  const redirects = terms.filter(
    (term): term is Extract<SpfTerm, { kind: 'modifier' }> =>
      term.kind === 'modifier' && term.name === 'redirect',
  );
  if (redirects.length !== 1) {
    return false;
  }
  return cleanHost(redirects[0]!.value) === cleanHost(`${token}.spf.${zone}`);
}

export interface SpfImportResult {
  sources: SpfSource[];
  allQualifier: '-all' | '~all';
  notes: string[];
  error: string | null;
}

function hostWithSuffix(value: string | null, domain: string): string {
  if (value === null) {
    return cleanHost(domain);
  }
  if (value.startsWith('/')) {
    return `${cleanHost(domain)}${value}`;
  }
  const slash = value.indexOf('/');
  const host = cleanHost(slash < 0 ? value : value.slice(0, slash));
  return `${host}${slash < 0 ? '' : value.slice(slash)}`;
}

function hasMacro(value: string | null): boolean {
  return value !== null && value.includes('%');
}

/**
 * Turns a published SPF record into the source list managed SPF stores.
 *
 * ptr is dropped with a note. exists, macros and any non-pass mechanism
 * refuse the import: each changes behaviour per message, and a source list
 * cannot express that safely. The all qualifier carries over only when it is
 * -all or ~all; anything else becomes ~all, which cannot reject mail.
 */
export function sourcesFromRecord(record: string, domain: string): SpfImportResult {
  const notes: string[] = [];
  let terms: SpfTerm[];
  try {
    terms = parseSpfTerms(record);
  } catch (error) {
    return {
      sources: [],
      allQualifier: '~all',
      notes,
      error: error instanceof Error ? error.message : 'The existing SPF record could not be read.',
    };
  }

  const all = terms.find(
    (term): term is Extract<SpfTerm, { kind: 'mechanism' }> =>
      term.kind === 'mechanism' && term.name === 'all',
  );
  const redirect = terms.find(
    (term): term is Extract<SpfTerm, { kind: 'modifier' }> =>
      term.kind === 'modifier' && term.name === 'redirect',
  );

  const sources: SpfSource[] = [];
  const refuse = (reason: string): SpfImportResult => ({
    sources: [],
    allQualifier: '~all',
    notes,
    error: reason,
  });

  for (const term of terms) {
    if (term.kind === 'modifier') {
      continue;
    }
    if (term.name === 'all') {
      break;
    }
    if (term.qualifier !== '+') {
      return refuse(
        `The existing record uses "${term.raw}", which is not a pass mechanism, so it cannot be imported safely. Add sources by hand.`,
      );
    }
    if (term.name === 'ptr') {
      notes.push('ptr is deprecated; it was not carried over');
      continue;
    }
    if (term.name === 'exists') {
      return refuse(
        'The existing record uses exists, which is evaluated for each message, so it cannot be imported safely. Add sources by hand.',
      );
    }
    if (hasMacro(term.value)) {
      return refuse(
        'The existing record uses a macro, which depends on each message, so it cannot be imported safely. Add sources by hand.',
      );
    }

    if (term.name === 'include') {
      const value = cleanHost(term.value ?? '');
      if (!value || value.includes('/')) {
        return refuse(`"${term.raw}" is not a domain this service can import.`);
      }
      sources.push({ kind: 'include', value });
      continue;
    }
    if (term.name === 'ip4' || term.name === 'ip6') {
      const family = term.name === 'ip4' ? 4 : 6;
      if (!parseCidr(term.value ?? '', family)) {
        return refuse(`"${term.raw}" is not a valid IPv${family} network.`);
      }
      sources.push({ kind: term.name, value: (term.value ?? '').trim() });
      continue;
    }
    if (term.name === 'a' || term.name === 'mx') {
      sources.push({ kind: term.name, value: hostWithSuffix(term.value, domain) });
    }
  }

  if (redirect) {
    if (all) {
      notes.push('redirect is ignored when the record also has an all mechanism; it was not imported.');
    } else if (hasMacro(redirect.value)) {
      return refuse('The redirect uses a macro, which depends on each message, so it cannot be imported safely.');
    } else {
      const value = cleanHost(redirect.value);
      if (!value) {
        return refuse('The redirect names no domain, so it cannot be imported.');
      }
      sources.push({ kind: 'include', value });
    }
  }

  let allQualifier: '-all' | '~all' = '~all';
  if (all?.qualifier === '-') {
    allQualifier = '-all';
  } else if (all?.qualifier === '~') {
    allQualifier = '~all';
  } else if (!all) {
    notes.push('The existing record has no all qualifier; ~all was added.');
  } else {
    notes.push(`The existing all qualifier is ${all.qualifier}all; ~all was used instead.`);
  }

  return { sources, allQualifier, notes, error: null };
}
