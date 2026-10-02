import { normalizeDomain } from '../scanner/domain.js';

/**
 * URL identifier for a domain.
 *
 * The cuid was reaching the address bar, links customers paste into chat, and
 * support emails, where it reads as a malfunction even when nothing is wrong. A
 * slug makes the URL name the thing it is about.
 *
 * Derived from the domain name because that is what a person would have typed,
 * with a short random suffix on the rare collision. The suffix comes from a
 * random source rather than a counter on purpose: two workspaces adding
 * example.com at the same moment should not have to queue, and a collision is
 * only ever cosmetic.
 */
export function domainSlug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  const base = cleaned || 'domain';
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * As above, but guaranteed to match. Intended for the import and bulk paths,
 * where a handful of retries is cheaper than a unique-violation abort that
 * discards the rest of the customer's batch.
 */
export async function uniqueDomainSlug(
  create: (slug: string) => Promise<unknown>,
  name: string,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = domainSlug(name);
    try {
      await create(candidate);
      return candidate;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002') {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Could not allocate a URL identifier for ${normalizeDomain(name)}.`);
}
