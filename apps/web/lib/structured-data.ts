/**
 * structured-data.ts — the JSON-LD this product publishes about itself.
 *
 * Only facts that are actually settled are emitted. The legal entity name, the
 * support phone and the registered address are placeholders until the business
 * supplies them (lib/legal-docs.ts), so they are absent here rather than filled
 * with a stand-in: structured data is read by machines that trust it, and a
 * crawler building an entity card from "[legal entity name: supplied by the
 * business before launch]" is strictly worse than one with no entity at all.
 *
 * There is deliberately no FAQPage markup. The FAQ is still the placeholder in
 * lib/legal-docs.ts, and Google treats structured data that describes content
 * not present on the page as a manual-action problem. The moment the real FAQ
 * lands, this is where its questions go.
 *
 * `dangerouslySetInnerHTML` is used to emit this, which is normally the thing to
 * avoid. Here the data is built entirely from constants in this file and from the
 * plan catalog, never from user input, and the output is a JSON string rather
 * than a React child tree — which is the only way to emit a JSON-LD block.
 */

/** What the company is, as far as it is knowable today. */
export function organizationJsonLd(origin: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": origin,
    name: "DMARC Harbor",
    // A short statement of what the company is for, matching the marketing page.
    description: "DMARC email-authentication monitoring for MSPs and IT agencies.",
    url: origin,
    logo: new URL("/opengraph-image", origin).toString(),
    // The one contact route that is real. `telephone` is missing because the
    // number has not been supplied yet — see the note at the top of this file.
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
      email: "support@dmarcharbor.com",
      availableLanguage: ["English"],
    },
  };
}

/** The product itself, so a crawler can tell what kind of thing this is. */
export function softwareApplicationJsonLd(origin: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "DMARC Harbor",
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "Email authentication monitoring",
    operatingSystem: "Web",
    description:
      "Per-domain DMARC posture from real report data, compliance packs with a published SHA-256 fingerprint, and a client portal in your own brand. It measures and proves; it never edits anyone's DNS.",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      // Not a range: there is a free plan, which is the honest entry point.
      description: "Free plan available; paid plans from the pricing page.",
    },
    // What the product does NOT do is a claim the marketing page makes, and it
    // is worth having in the machine-readable copy too: it is the reason the
    // product is safe to run against a client's domains.
    featureList: [
      "Aggregate DMARC report ingestion and measurement",
      "Per-domain posture: aligned, blocking, unverified, not measured",
      "Compliance packs with a published SHA-256 fingerprint",
      "Public fingerprint verifier",
      "Revocable report share links",
      "Client portal on a custom domain",
      "Email and Slack alerting rules",
    ],
    isAccessibleForFree: true,
    publisher: { "@id": origin },
  };
}

/** One Offer per plan, priced as the pricing page shows them. */
export interface StructuredOfferInput {
  name: string;
  /** In minor units, as the catalog stores them. */
  monthlyMinor: number;
}

/**
 * The plan offers, in USD monthly.
 *
 * One price per plan rather than the full cross-product of currency and
 * interval the page can show. Structured data carries one figure, and the
 * figure a crawler reads has to be one that is genuinely on the page: USD
 * monthly is. The INR price and the annual price are rendered on the pricing
 * page itself, which is where a buyer comparing them needs to be.
 */
export function planOffersJsonLd(
  origin: string,
  plans: StructuredOfferInput[],
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "DMARC Harbor plans",
    itemListElement: plans.map((plan, index) => ({
      "@type": "ListItem",
      position: index + 1,
      item: {
        "@type": "Offer",
        name: plan.name,
        price: (plan.monthlyMinor / 100).toFixed(2),
        priceCurrency: "USD",
        url: new URL("/pricing", origin).toString(),
        availability: "https://schema.org/InStock",
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price: (plan.monthlyMinor / 100).toFixed(2),
          priceCurrency: "USD",
          unitCode: "MON",
          // A month is the billing period, not a measurement unit.
          referenceQuantity: {
            "@type": "QuantitativeValue",
            value: 1,
            unitCode: "MON",
          },
        },
      },
    })),
  };
}

/** A graph tying the nodes together with @id references, rather than three
 *  separate blocks that each restate the company. */
export function siteGraphJsonLd(origin: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@graph": [organizationJsonLd(origin), softwareApplicationJsonLd(origin)],
  };
}

/** Serialised for embedding. Compact separators keep the block small, and the
 *  escaping is what keeps a stray `</script>` in a description from closing the
 *  element early. */
export function jsonLdString(data: Record<string, unknown>): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}
