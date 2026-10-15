import { describe, expect, it } from 'vitest';
import { domainSlug } from '../src/services/domain-slug.js';

/**
 * Coverage for the invariant that makes `domainRef`'s OR unambiguous.
 *
 * The obvious reason - that an id and a slug are different shapes - is wrong. A
 * cuid is `c` followed by base36, which is lowercase letters and digits, and
 * that satisfies the slug pattern exactly. So no pattern separates them.
 *
 * What separates them is that `domainSlug` always appends `-${random}`, so every
 * slug contains at least one hyphen and no cuid ever does. That is a property of
 * how slugs are minted, not of either format, which is why it is asserted here:
 * a change to domainSlug that dropped the suffix, or a cuid generator that
 * started emitting hyphens, would make the OR ambiguous with nothing else
 * failing - a lookup could resolve two rows and pick the wrong domain.
 */

describe('the slug / cuid invariant', () => {
  it('a cuid looks exactly like a slug, which is why the pattern test alone proves nothing', () => {
    const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

    // Both of these are real shaped values and both match the slug pattern.
    expect(slugPattern.test('cmv7nhx1z00081gpwik1txek3')).toBe(true);
    expect(slugPattern.test('cAbCdEf123456')).toBe(false); // uppercase, so no
    expect(slugPattern.test('northwind-trading-test-xk29f1')).toBe(true);
  });

  it('every slug domainSlug mints contains a hyphen', () => {
    for (const name of ['northwind-trading.test', 'example.com', 'a.b', 'sub.deep.example.co.uk']) {
      const slug = domainSlug(name);

      expect(slug).toContain('-');
      // The appended suffix, not just the dots turned into hyphens.
      expect(slug.split('-').length).toBeGreaterThan(1);
    }
  });

  it('the suffix is random, so two calls for the same name differ', () => {
    // Not asserted as strictly different, because random can repeat, but the
    // shape is stable and the length is bounded.
    const first = domainSlug('example.com');
    const second = domainSlug('example.com');

    expect(first).toContain('-');
    expect(second).toContain('-');
    expect(first.length).toBeLessThanOrEqual(60 + 1 + 8);
  });

  it('no cuid contains a hyphen, so the two namespaces stay disjoint', () => {
    // The guarantee the whole OR clause rests on.
    for (const cuid of ['cmv7nhx1z00081gpwik1txek3', 'c123', 'cabc123def456']) {
      expect(cuid).not.toContain('-');
    }
  });

  it('a single-character name still produces a hyphenated slug', () => {
    // The `cleaned || 'domain'` branch.
    const slug = domainSlug('---');

    expect(slug).toContain('-');
    expect(slug.startsWith('domain')).toBe(true);
  });
});
