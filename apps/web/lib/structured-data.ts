/**
 * structured-data.ts — the JSON-LD this product publishes about itself.
 *
 * Only facts that are actually settled are emitted. The legal entity name, the
 * support phone and the registered address are placeholders until the business
 * supplies them (lib/legal-docs.ts), so they are absent here rather than filled
 * with a stand-in: structured data is read by machines that trust it, and a
 * crawler building an entity card from "[legal entity name: supplied by the
 * business before launch]" is strictly worse than one with no entity at all.
 * For the same reason there is no aggregateRating and no review: there are
 * none to report.
 *
 * Every node has a stable @id on the canonical origin (`/#organization`,
 * `/#website`, `/#software`, `/faq#faqpage`), so the blocks on different pages
 * describe one company, one site and one product rather than restating them.
 *
 * The FAQPage is built from docs/FAQ.md by the same parse the page renders
 * (components/harbor/legal-markdown.ts faqEntries), so every question in the
 * markup is on the page with the same words and the same anchor. An answer
 * that still carries a fact the business has not supplied is left out of the
 * markup; it stays on the page, marked as pending.
 *
 * `dangerouslySetInnerHTML` is used to emit this, which is normally the thing to
 * avoid. Here the data is built from constants, the repository's own documents
 * and the plan catalog, never from user input, and jsonLdString escapes the
 * characters that could close the element early.
 *
 * No imports through the "@/" alias, so the unit tests can load this file.
 */

import type { FaqEntry } from "../components/harbor/legal-markdown";

export const ORGANIZATION_NAME = "DMARC Harbor";

/** The @id of each shared node, on the canonical origin. */
export function nodeId(origin: string, node: "organization" | "website" | "software"): string {
  return new URL(`/#${node}`, origin).toString();
}

/** What the company is, as far as it is knowable today. */
export function organizationJsonLd(origin: string): Record<string, unknown> {
  return {
    "@type": "Organization",
    "@id": nodeId(origin, "organization"),
    name: ORGANIZATION_NAME,
    // A short statement of what the company is for, matching the marketing page.
    description: "DMARC email-authentication monitoring for MSPs and IT agencies.",
    url: new URL("/", origin).toString(),
    // The square mark. A logo must be square-ish and at least 112px for Google
    // to use it; the 1200x630 social card is neither.
    logo: {
      "@type": "ImageObject",
      url: new URL("/icons/icon-512.png", origin).toString(),
      width: 512,
      height: 512,
    },
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

/** The site, published by the company. */
export function websiteJsonLd(origin: string): Record<string, unknown> {
  return {
    "@type": "WebSite",
    "@id": nodeId(origin, "website"),
    name: ORGANIZATION_NAME,
    url: new URL("/", origin).toString(),
    inLanguage: "en",
    publisher: { "@id": nodeId(origin, "organization") },
  };
}

/** The product itself, so a crawler can tell what kind of thing this is. */
export function softwareApplicationJsonLd(origin: string): Record<string, unknown> {
  return {
    "@type": "SoftwareApplication",
    "@id": nodeId(origin, "software"),
    name: ORGANIZATION_NAME,
    url: new URL("/", origin).toString(),
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "Email authentication monitoring",
    operatingSystem: "Web",
    description:
      "DMARC monitoring for MSPs and IT agencies. Per-domain DMARC posture from real report data, compliance packs with a published SHA-256 fingerprint, and a client portal in your own brand. It measures and proves, and changes DNS only when you ask.",
    // The entry point only; every plan's price is on /pricing, whose block
    // adds them to this same node (planOffersJsonLd).
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      url: new URL("/pricing", origin).toString(),
      description: "Free plan available; paid plans on the pricing page.",
    },
    featureList: [
      "Aggregate DMARC report ingestion and measurement",
      "Per-domain posture: aligned, blocking, unverified, not measured",
      "Compliance packs with a published SHA-256 fingerprint",
      "Public fingerprint verifier",
      "Revocable report share links",
      // The portal is Harbor and up; its own domain is Admiralty only, so the
      // site-wide node beside the free offer does not claim the domain.
      "Client portal in your own brand",
      "Email, Slack and Teams alerting rules",
      "Free DMARC, SPF, DKIM and BIMI lookups and a DMARC record generator, with no account",
    ],
    isAccessibleForFree: true,
    publisher: { "@id": nodeId(origin, "organization") },
  };
}

/** One Offer per plan, priced as the pricing page shows them. */
export interface StructuredOfferInput {
  name: string;
  /** In minor units, as the catalog stores them. */
  monthlyMinor: number;
  /** Per-domain plans are excluded: their unit is not the plan's monthly price. */
  pricing?: "flat" | "per_domain";
}

/**
 * The plan offers, in USD monthly, as the `offers` of the product node.
 *
 * One price per plan rather than the full cross-product of currency and
 * interval the page can show. Structured data carries one figure, and the
 * figure a crawler reads has to be one that is genuinely on the page: USD
 * monthly is. The INR price and the annual price are rendered on the pricing
 * page itself, which is where a buyer comparing them needs to be.
 *
 * Per-domain plans are excluded. An Offer of "$2.00 a month" for Fleet would
 * state the unit price as the plan price, which is false by an order of
 * magnitude at the minimum.
 *
 * The node carries the product's @id, so it is the same SoftwareApplication
 * as the site graph's, with its prices attached, not a second product.
 */
export function planOffersJsonLd(origin: string, plans: StructuredOfferInput[]): Record<string, unknown> {
  const pricingUrl = new URL("/pricing", origin).toString();
  const offers = plans
    .filter((plan) => plan.pricing !== "per_domain")
    .map((plan) => {
      const price = (plan.monthlyMinor / 100).toFixed(2);
      return {
        "@type": "Offer",
        name: plan.name,
        price,
        priceCurrency: "USD",
        url: pricingUrl,
        availability: "https://schema.org/InStock",
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price,
          priceCurrency: "USD",
          billingDuration: "P1M",
          unitCode: "MON",
        },
      };
    });

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        "@id": nodeId(origin, "software"),
        name: ORGANIZATION_NAME,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        offers,
      },
      breadcrumbJsonLd(origin, [{ name: "Pricing", path: "/pricing" }]),
    ],
  };
}

/** Home, then the given trail. Every item names an absolute URL. */
export function breadcrumbJsonLd(origin: string, trail: Array<{ name: string; path: string }>): Record<string, unknown> {
  const items = [{ name: ORGANIZATION_NAME, path: "/" }, ...trail];
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: new URL(item.path, origin).toString(),
    })),
  };
}

/**
 * The FAQ as a FAQPage. Pending answers are left out (see the top of this
 * file). Each question's url is its anchor on the page.
 *
 * Google shows FAQ rich results only for a few authoritative sites since 2023;
 * the markup is still the plainest machine-readable statement of "this page
 * answers these questions", which is what Bing and AI answer engines read.
 */
export function faqPageJsonLd(origin: string, path: string, entries: FaqEntry[]): Record<string, unknown> | null {
  const answered = entries.filter((entry) => !entry.pending && entry.answer.trim() !== "");
  if (answered.length === 0) return null;
  const page = new URL(path, origin).toString();
  return {
    "@type": "FAQPage",
    "@id": `${page}#faqpage`,
    url: page,
    inLanguage: "en",
    isPartOf: { "@id": nodeId(origin, "website") },
    about: { "@id": nodeId(origin, "software") },
    mainEntity: answered.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      url: `${page}#${entry.id}`,
      acceptedAnswer: { "@type": "Answer", text: entry.answer },
    })),
  };
}

/** A documentation page: the setup guide or the API reference. */
export function techArticleJsonLd(
  origin: string,
  input: { title: string; description: string; path: string; version?: string },
): Record<string, unknown> {
  const page = new URL(input.path, origin).toString();
  return {
    "@type": "TechArticle",
    "@id": `${page}#article`,
    headline: input.title,
    description: input.description,
    url: page,
    mainEntityOfPage: page,
    inLanguage: "en",
    ...(input.version ? { version: input.version } : {}),
    isPartOf: { "@id": nodeId(origin, "website") },
    about: { "@id": nodeId(origin, "software") },
    publisher: { "@id": nodeId(origin, "organization") },
  };
}

/** What a free tool page needs said about it: the fields lib/tools.ts holds. */
export interface StructuredToolInput {
  path: string;
  title: string;
  description: string;
}

/**
 * One free tool as a WebApplication: a free, browser-based utility published
 * by the company, with its trail under Free tools. Its own node (`#tool`),
 * not the product's, because the tool is free and needs no account while the
 * product is the monitoring service.
 */
export function toolJsonLd(origin: string, tool: StructuredToolInput): Record<string, unknown> {
  const page = new URL(tool.path, origin).toString();
  return graph([
    {
      "@type": "WebApplication",
      "@id": `${page}#tool`,
      name: tool.title,
      description: tool.description,
      url: page,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web",
      browserRequirements: "Requires JavaScript.",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      inLanguage: "en",
      isPartOf: { "@id": nodeId(origin, "website") },
      publisher: { "@id": nodeId(origin, "organization") },
    },
    breadcrumbJsonLd(origin, [
      { name: "Free tools", path: "/tools" },
      { name: tool.title, path: tool.path },
    ]),
  ]);
}

/** The tools index as a CollectionPage listing each tool by its @id. */
export function toolsIndexJsonLd(
  origin: string,
  input: { title: string; description: string; tools: StructuredToolInput[] },
): Record<string, unknown> {
  const page = new URL("/tools", origin).toString();
  return graph([
    {
      "@type": "CollectionPage",
      "@id": `${page}#page`,
      name: input.title,
      description: input.description,
      url: page,
      inLanguage: "en",
      isPartOf: { "@id": nodeId(origin, "website") },
      publisher: { "@id": nodeId(origin, "organization") },
      mainEntity: {
        "@type": "ItemList",
        itemListElement: input.tools.map((tool, index) => {
          const url = new URL(tool.path, origin).toString();
          return { "@type": "ListItem", position: index + 1, name: tool.title, url, item: { "@id": `${url}#tool` } };
        }),
      },
    },
    breadcrumbJsonLd(origin, [{ name: "Free tools", path: "/tools" }]),
  ]);
}

/** The glossary as a DefinedTermSet, each term at its anchor on the page. */
export function glossaryJsonLd(
  origin: string,
  input: { path: string; title: string; description: string; terms: Array<{ id: string; name: string; definition: string }> },
): Record<string, unknown> {
  const page = new URL(input.path, origin).toString();
  return graph([
    {
      "@type": "DefinedTermSet",
      "@id": `${page}#terms`,
      name: input.title,
      description: input.description,
      url: page,
      inLanguage: "en",
      isPartOf: { "@id": nodeId(origin, "website") },
      publisher: { "@id": nodeId(origin, "organization") },
      hasDefinedTerm: input.terms.map((term) => ({
        "@type": "DefinedTerm",
        "@id": `${page}#${term.id}`,
        name: term.name,
        description: term.definition,
        url: `${page}#${term.id}`,
        inDefinedTermSet: { "@id": `${page}#terms` },
      })),
    },
    breadcrumbJsonLd(origin, [{ name: input.title, path: input.path }]),
  ]);
}

/** A how-to guide: the steps to set one sender or mailbox host up. */
export function howToJsonLd(
  origin: string,
  input: { path: string; title: string; description: string; steps: Array<{ name: string; text: string }>; trail: Array<{ name: string; path: string }> },
): Record<string, unknown> {
  const page = new URL(input.path, origin).toString();
  return graph([
    {
      "@type": "HowTo",
      "@id": `${page}#howto`,
      name: input.title,
      description: input.description,
      url: page,
      inLanguage: "en",
      isPartOf: { "@id": nodeId(origin, "website") },
      publisher: { "@id": nodeId(origin, "organization") },
      step: input.steps.map((step, index) => ({
        "@type": "HowToStep",
        position: index + 1,
        name: step.name,
        text: step.text,
        url: `${page}#step-${index + 1}`,
      })),
    },
    breadcrumbJsonLd(origin, input.trail),
  ]);
}

/** A set of nodes in one block. */
export function graph(nodes: Array<Record<string, unknown> | null>): Record<string, unknown> {
  return { "@context": "https://schema.org", "@graph": nodes.filter((n): n is Record<string, unknown> => n !== null) };
}

/** The company, the site and the product, tied together with @id references,
 *  for every page on our host (app/layout.tsx). */
export function siteGraphJsonLd(origin: string): Record<string, unknown> {
  return graph([organizationJsonLd(origin), websiteJsonLd(origin), softwareApplicationJsonLd(origin)]);
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
