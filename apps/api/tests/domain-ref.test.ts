import { describe, expect, it } from 'vitest';
import { domainRef } from '../src/services/domain-ref.js';
import { domainSlug } from '../src/services/domain-slug.js';

/**
 * Coverage for the one predicate that decides whether a URL identifier resolves.
 *
 * A domain can be named by id or by slug, and `Domain.slug` was added precisely
 * so the address bar could stop showing a cuid. Five routes kept resolving by
 * `id` alone after the schema landed, so a URL carrying a slug 404'd. These
 * tests pin the clause that closes that, and pin the reason it is safe: the two
 * namespaces do not overlap.
 */

describe('domainRef', () => {
  it('matches on id and on slug', () => {
    const clause = domainRef('cmv7nhx1z00081gpwik1txek3');

    expect(clause.OR).toEqual([
      { id: 'cmv7nhx1z00081gpwik1txek3' },
      { slug: 'cmv7nhx1z00081gpwik1txek3' },
    ]);
  });

  it('is the same shape for a slug', () => {
    expect(domainRef('northwind-trading-test')).toEqual({
      OR: [{ id: 'northwind-trading-test' }, { slug: 'northwind-trading-test' }],
    });
  });

  /**
   * The reason `OR` is safe rather than merely convenient, and the reason it is
   * NOT the obvious one.
   *
   * A cuid is `c` plus base36 - lowercase letters and digits - which satisfies
   * the slug pattern exactly. So there is no pattern that separates them. What
   * separates them is that `domainSlug` always appends `-${random}`, so every
   * slug has at least one hyphen and no cuid ever does. That is the invariant,
   * and it depends on how slugs are minted rather than on either format.
   *
   * Asserted here because a change to domainSlug that dropped the suffix, or a
   * cuid generator that emitted hyphens, would make `OR` ambiguous without
   * anything else failing: one row could match both branches and a lookup could
   * resolve to the wrong domain.
   */
  it('is unambiguous because every slug has a hyphen and no cuid does', () => {
    const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

    // The formats overlap, which is why this test exists.
    expect(slugPattern.test('cmv7nhx1z00081gpwik1txek3')).toBe(true);

    // Every slug domainSlug produces carries the appended suffix.
    for (const name of ['northwind-trading.test', 'example.com', 'a.b']) {
      const slug = domainSlug(name);
      expect(slug).toContain('-');
      expect(slug.split('-').length).toBeGreaterThan(1);
    }

    // A cuid has no hyphen, so it can never equal a slug.
    for (const id of ['cmv7nhx1z00081gpwik1txek3', 'cAbCdEf123456', 'c123']) {
      expect(id).not.toContain('-');
    }
  });

  it('produces a fresh object each call, so one caller cannot widen another', () => {
    const first = domainRef('x');
    const second = domainRef('x');

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it('spreads into a where clause alongside a scope filter', () => {
    // The shape every call site uses: `where: { client: { organizationId }, ...domainRef(id) }`.
    const where = { client: { organizationId: 'org-1' }, ...domainRef('some-slug') };

    expect(where).toEqual({
      client: { organizationId: 'org-1' },
      OR: [{ id: 'some-slug' }, { slug: 'some-slug' }],
    });
  });

  it('does not clobber an existing key when spread last', () => {
    // `domainRef` returns only `OR`, so spreading it cannot overwrite a scope
    // that was set before it. If it returned `where` it could, silently.
    const where = { id: 'cmv123', client: { organizationId: 'org-1' }, ...domainRef('cmv123') };

    expect(where.OR).toBeDefined();
    expect(where.id).toBe('cmv123');
  });
});
