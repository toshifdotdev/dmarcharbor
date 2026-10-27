/**
 * Parsing one SPF record into terms.
 *
 * The managed-SPF code needs to know exactly what a mechanism says, not just
 * whether the record looks plausible, because a flattening mistake authorises
 * the wrong senders. The parser therefore refuses a mechanism it does not
 * know rather than guessing, while keeping every modifier (including unknown
 * ones) so nothing is silently lost.
 */

export type SpfQualifier = '+' | '-' | '~' | '?';

export type SpfMechanismName =
  | 'all'
  | 'include'
  | 'a'
  | 'mx'
  | 'ptr'
  | 'ip4'
  | 'ip6'
  | 'exists';

export type SpfTerm =
  | {
      kind: 'mechanism';
      qualifier: SpfQualifier;
      name: SpfMechanismName;
      value: string | null;
      raw: string;
    }
  | { kind: 'modifier'; name: string; value: string; raw: string };

const mechanismNames = new Set<SpfMechanismName>([
  'all',
  'include',
  'a',
  'mx',
  'ptr',
  'ip4',
  'ip6',
  'exists',
]);

const modifierPattern = /^([A-Za-z][A-Za-z0-9_.-]*)=(.*)$/;

function splitMechanism(raw: string): SpfTerm {
  let qualifier: SpfQualifier = '+';
  let body = raw;
  if (/^[+\-~?]/.test(body)) {
    qualifier = body[0] as SpfQualifier;
    body = body.slice(1);
  }

  const lower = body.toLowerCase();
  let name: string;
  let value: string | null = null;

  const colon = lower.indexOf(':');
  if (colon >= 0) {
    name = lower.slice(0, colon);
    value = body.slice(colon + 1);
  } else {
    const slash = lower.indexOf('/');
    if (slash >= 0) {
      name = lower.slice(0, slash);
      // Keep the slash suffix, including the leading slash(es), so a dual
      // CIDR (a/24//64) survives parsing intact.
      value = body.slice(slash);
    } else {
      name = lower;
    }
  }

  if (!mechanismNames.has(name as SpfMechanismName)) {
    throw new Error(`Unknown SPF mechanism "${raw}".`);
  }
  if (value === '') {
    value = null;
  }
  return {
    kind: 'mechanism',
    qualifier,
    name: name as SpfMechanismName,
    value,
    raw,
  };
}

export function parseSpfTerms(record: string): SpfTerm[] {
  const tokens = record.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens[0]!.toLowerCase() !== 'v=spf1') {
    throw new Error('This is not an SPF record: it does not start with v=spf1.');
  }

  const terms: SpfTerm[] = [];
  for (const raw of tokens.slice(1)) {
    const modifier = modifierPattern.exec(raw);
    if (modifier) {
      terms.push({
        kind: 'modifier',
        name: modifier[1]!.toLowerCase(),
        value: modifier[2]!,
        raw,
      });
      continue;
    }
    terms.push(splitMechanism(raw));
  }
  return terms;
}

/**
 * The qualifier on the record's all mechanism, as a term ("-all"). A record
 * with no all has the RFC's neutral default, "?all". This mirrors the helper
 * the DNS diff used privately; it now lives here so the diff and managed SPF
 * cannot disagree about what the record says.
 */
export function spfAllQualifier(record: string): string {
  for (const mechanism of record.trim().split(/\s+/).slice(1)) {
    const match = /^([+\-~?])?all$/i.exec(mechanism);
    if (match) {
      return `${match[1] ?? '+'}all`;
    }
  }
  return '?all';
}
