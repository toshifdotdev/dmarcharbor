import Link from "next/link";
import { readHostBrand } from "@/lib/host-brand";
import { LEGAL_DOCS, legalBody, type LegalDoc } from "@/lib/legal-docs";
import { LegalMarkdown } from "@/components/legal-markdown";
import {
  HostUnverifiedBanner,
  MarketingFooter,
  MarketingHeader,
  brandName,
} from "@/components/marketing";

/**
 * legal-doc-view.tsx — the public legal documents.
 *
 * One shared layout for every document; they differ only in title, version and
 * body. Every page is public and loads signed out — an auditor, a buyer, and a
 * lawyer with no account all reach the same text. Monolith document
 * typography: restrained, print-like, no operator chrome.
 *
 * The version and effective date ride every page because an acceptance record
 * must point at a specific text: a document without a version cannot be the
 * thing acceptance points at.
 *
 * A document is never summarised on another page — pages link here. A
 * paraphrase of a DPA is not a DPA.
 */

export async function LegalDocView({ slug }: { slug: string }) {
  const brand = await readHostBrand();
  const doc = LEGAL_DOCS.find((d) => d.slug === slug);

  if (!doc) {
    return (
      <div className="relative z-10 min-h-screen" data-host-brand={brand.state}>
        {brand.state === "unverified" ? <HostUnverifiedBanner /> : null}
        <MarketingHeader brand={brand} />
        <main className="mx-auto w-full max-w-[720px] px-6 py-16">
          <h1
            className="text-[26px] font-semibold tracking-[-0.02em]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            This document does not exist.
          </h1>
          <p className="mt-3 text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            The legal documents below all exist and load without an account.
          </p>
          <LegalIndex active={null} />
        </main>
        <MarketingFooter brand={brand} />
      </div>
    );
  }

  const body = legalBody(doc);

  return (
    <div className="relative z-10 min-h-screen" data-host-brand={brand.state}>
      {brand.state === "unverified" ? <HostUnverifiedBanner /> : null}
      <MarketingHeader brand={brand} />

      <main className="mx-auto w-full max-w-[720px] px-6 py-12">
        {/* The identity of the text: what it is, which version, when effective. */}
        <header className="border-b pb-6" style={{ borderColor: "var(--color-line-strong)" }}>
          <p className="label">{brandName(brand)} · Legal</p>
          <h1
            className="mt-2 text-[30px] font-semibold leading-[1.15] tracking-[-0.03em]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {doc.title}
          </h1>
          <p className="num mt-2 text-[11.5px]" style={{ color: "var(--color-ink-3)" }}>
            version {doc.version} · effective {doc.effectiveDate}
          </p>
        </header>

        {body.kind === "placeholder" ? (
          <p
            role="status"
            className="mt-6 text-[13px] leading-[1.8]"
            style={{ color: "var(--color-unverified)" }}
          >
            {body.text}
          </p>
        ) : null}

        {/* The required sections are the floor that must exist while the
            supplied text has not landed. Once the file renders, it is the
            authoritative document and carries its own clauses: rendering both
            would duplicate the mandated paragraph and put two different entity
            placeholders on one page. The harness asserts the mandated Paddle
            paragraph is present on the rendered page either way. */}
        {body.kind === "placeholder"
          ? doc.required?.map((section) => (
              <section key={section.heading} className="mt-6">
                <h2
                  className="text-[19px] font-semibold tracking-[-0.02em]"
                  style={{ fontFamily: "var(--font-display)", color: "var(--color-ink)" }}
                >
                  {section.heading}
                </h2>
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph} className="mt-3 text-[13.5px] leading-[1.8]" style={{ color: "var(--color-ink-2)" }}>
                    {paragraph}
                  </p>
                ))}
              </section>
            ))
          : null}

        <div className="mt-6">
          <LegalMarkdown markdown={body.text} />
        </div>

        <LegalIndex active={doc.slug} />
      </main>

      <MarketingFooter brand={brand} />
    </div>
  );
}

/** The documents, reachable from every document — never a dead-end page. */
function LegalIndex({ active }: { active: string | null }) {
  return (
    <nav
      className="mt-12 border-t pt-6"
      style={{ borderColor: "var(--color-line-strong)" }}
      aria-label="Legal documents"
    >
      <p className="label">All documents</p>
      <ul className="mt-3 grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2">
        {LEGAL_DOCS.map((d: LegalDoc) => (
          <li key={d.slug}>
            <Link
              href={`/${d.slug}`}
              className="text-[13px] underline"
              style={{ color: d.slug === active ? "var(--color-ink)" : "var(--color-ink-2)" }}
            >
              {d.title}
            </Link>
          </li>
        ))}
        <li>
          <Link href="/support" className="text-[13px] underline" style={{ color: "var(--color-ink-2)" }}>
            Support
          </Link>
        </li>
      </ul>
    </nav>
  );
}
