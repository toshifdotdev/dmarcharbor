/**
 * domain-ref.ts — how a route or service identifies which domain was asked for.
 *
 * A domain can be named by its id (`cmv7nhx1z...`) or by its slug
 * (`northwind-trading-test`). Both have to work everywhere, or a URL carrying
 * one of them 404s.
 *
 * WHY BOTH.
 *
 * `Domain.slug` was added so the address bar could stop showing a cuid. The
 * schema comment says so, and `route-hrefs.ts` says so: a database primary key
 * is a thing customers see, share, screenshot and paste into support emails.
 * The slug landed, `client.service.ts` learned to resolve either, and then
 * nothing else did — five other places resolved by `id` alone, so switching the
 * web app to building slug URLs would have 404'd onboarding, the client portal,
 * alerts, and digests. That is worse than an ugly URL, which is how this went
 * unnoticed.
 *
 * The two identifiers cannot collide in practice, and it is worth being precise
 * about why, because the obvious reason is the wrong one. A cuid is `c` followed
 * by base36 - lowercase letters and digits, no punctuation - which looks exactly
 * like a slug so far as a pattern can tell. The real guarantee is that
 * `domainSlug` always appends `-${random}`, so EVERY slug contains at least one
 * hyphen and NO cuid does. That is what keeps the two namespaces disjoint.
 *
 * It is a property of how slugs are minted rather than of the two formats, so
 * it is asserted in tests/domain-ref.test.ts. A future change to domainSlug that
 * stopped adding the suffix - or a cuid generator that started emitting hyphens
 * - would silently make `OR` ambiguous, and one row could then match on both
 * branches.
 *
 * Use this rather than writing `OR: [{ id }, { slug }]` by hand. The reason it
 * was missed in five places is that it was five separate decisions, and a
 * helper makes it one.
 */

/** The `OR` clause matching a domain by id or slug, for a `findFirst`. */
export function domainRef(idOrSlug: string): { OR: Array<{ id: string } | { slug: string }> } {
  return { OR: [{ id: idOrSlug }, { slug: idOrSlug }] };
}
