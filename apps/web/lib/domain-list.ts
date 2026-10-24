/**
 * domain-list.ts — reading a pasted list of domains.
 *
 * One operator pastes one domain per line, another pastes a spreadsheet column
 * with commas, and a third pastes a website address. The list is cleaned the
 * same way everywhere: URLs, email addresses, `www.` and a trailing dot all
 * reduce to the domain mail is sent from. Invalid rows are kept aside so they
 * are reported rather than silently dropped.
 */

export const DOMAIN_PATTERN =
  /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

export function cleanDomainInput(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^.*@/, "")
    .replace(/^www\./, "")
    .replace(/[/?#:].*$/, "")
    .replace(/\.+$/, "");
}

export interface ParsedDomainList {
  names: string[];
  invalid: string[];
  duplicates: number;
}

export function splitDomainList(raw: string): ParsedDomainList {
  const seen = new Set<string>();
  const names: string[] = [];
  const invalid: string[] = [];
  let duplicates = 0;

  for (const part of raw.split(/[\r\n,;\s]+/)) {
    if (!part.trim()) continue;
    const name = cleanDomainInput(part);
    if (!name) continue;
    if (seen.has(name)) {
      duplicates += 1;
      continue;
    }
    seen.add(name);
    (DOMAIN_PATTERN.test(name) ? names : invalid).push(name);
  }

  return { names, invalid, duplicates };
}
