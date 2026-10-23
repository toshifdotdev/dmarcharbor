/**
 * legal-document.tsx — the public legal documents and the support page.
 *
 * Designed for the people who actually open these: a buyer's lawyer reading
 * the DPA end to end, an auditor checking one clause, an MSP forwarding the
 * sub-processor list to a client. So:
 *
 * - The document's identity is stated first and kept with it: title, version,
 *   effective date. An acceptance record points at a specific text, and a
 *   printout must carry which text it is.
 * - A contents list built from the document's own headings sits beside it and
 *   marks the section being read. Every heading links to itself.
 * - It prints as a document: no site frame, the address printed at the foot.
 * - Facts the business has not supplied yet (entity name, phone, address,
 *   effective date) are marked as pending in place, never filled with
 *   something plausible.
 * - The other documents are one click away, never a dead end.
 *
 * Every page here is public and loads signed out. A document is never
 * summarised on another page: pages link here, because a paraphrase of a DPA
 * is not a DPA.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { readHostBrand } from "@/lib/host-brand";
import { LEGAL_DOCS, LEGAL_EFFECTIVE_DATE, LEGAL_VERSION, legalBody } from "@/lib/legal-docs";
import { Contents, PrintButton } from "./legal-client";
import { LegalBody, LegalHeading2, legalHeadings, slugify, type LegalHeading } from "./legal-render";
import { brandName, PublicFooter, PublicHeader } from "./public-frame";

/** The shared frame: identity header, contents rail, body, document index. */
export async function DocumentFrame({
  slug,
  kicker,
  title,
  headings,
  current,
  children,
}: {
  slug: string;
  kicker: string;
  title: string;
  headings: LegalHeading[];
  current?: "support" | "legal";
  children: ReactNode;
}) {
  const brand = await readHostBrand();
  const name = brandName(brand);
  const pending = LEGAL_EFFECTIVE_DATE.includes("to be set");

  return (
    <div data-harbor data-host-brand={brand.state}>
      <div className="print:hidden">
        <PublicHeader brand={brand} current={current ?? "legal"} />
      </div>

      <main id="main" className="mx-auto w-full max-w-[1240px] px-5 pb-20 pt-10 sm:px-8 lg:pt-14">
        <header className="grid gap-6 border-b border-fg pb-8 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-12">
          <p className="legend lg:pt-3">
            {name} · {kicker}
          </p>
          <div>
            <h1 className="display text-[32px] leading-[1.05] text-fg sm:text-[44px]">{title}</h1>
            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-meta">
              <span data-testid="legal-version" className="text-fg-2">
                <span className="legend mr-1.5">Version</span>
                <span className="tnum data font-semibold text-fg">{LEGAL_VERSION}</span>
                <span className="mx-2 text-fg-4">·</span>
                <span className="legend mr-1.5">Effective</span>
                {pending ? (
                  <mark className="rounded-[2px] bg-warn-wash px-1 font-semibold text-warn">{LEGAL_EFFECTIVE_DATE}</mark>
                ) : (
                  <span className="font-semibold text-fg">{LEGAL_EFFECTIVE_DATE}</span>
                )}
              </span>
              <span className="ml-auto">
                <PrintButton />
              </span>
            </div>
          </div>
        </header>

        <div className="mt-10 grid gap-10 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-12">
          <aside className="hidden lg:block">
            <div className="sticky top-8 flex max-h-[calc(100vh-4rem)] flex-col gap-8 overflow-y-auto pb-4">
              <Contents headings={headings} />
              <DocumentIndex active={slug} />
            </div>
          </aside>
          <article className="min-w-0">{children}</article>
        </div>

        <div className="mt-16 border-t border-rule pt-8 lg:hidden">
          <DocumentIndex active={slug} />
        </div>

        <p className="mt-10 hidden text-meta text-fg-3 print:block">
          {title} · version {LEGAL_VERSION} · {name}. The current text is published at /{slug === "support" ? "support" : slug}.
        </p>
      </main>

      <div className="print:hidden">
        <PublicFooter brand={brand} />
      </div>
    </div>
  );
}

function DocumentIndex({ active }: { active: string }) {
  return (
    <nav aria-label="All documents" className="print:hidden">
      <p className="legend pb-2">All documents</p>
      <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-1">
        {[...LEGAL_DOCS.map((d) => [d.slug, d.title] as const), ["support", "Support and contact"] as const].map(([slug, title]) => (
          <li key={slug}>
            <Link
              href={`/${slug}`}
              aria-current={slug === active ? "page" : undefined}
              className={slug === active ? "text-ui font-semibold text-fg" : "text-ui text-fg-3 hover:text-fg hover:underline"}
            >
              {title}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export async function LegalDocument({ slug }: { slug: string }) {
  const doc = LEGAL_DOCS.find((d) => d.slug === slug);

  if (!doc) {
    return (
      <DocumentFrame slug={slug} kicker="Legal" title="This document does not exist" headings={[]}>
        <p className="text-body text-fg-2">Every document in the list loads without an account.</p>
      </DocumentFrame>
    );
  }

  const body = legalBody(doc);
  // Required sections render only while the supplied file has not landed:
  // once it has, the file is authoritative and carries its own clauses.
  const required = body.kind === "placeholder" ? (doc.required ?? []) : [];
  const requiredTitles = required.map((s) => s.heading);
  const headings = legalHeadings(body.kind === "file" ? body.text : "", requiredTitles);
  const requiredIds = headings.slice(0, required.length).map((h) => h.id);

  return (
    <DocumentFrame slug={doc.slug} kicker="Legal" title={doc.title} headings={headings}>
      {body.kind === "placeholder" ? (
        <p role="status" className="mb-8 max-w-[70ch] border-l-2 border-warn-mark bg-warn-wash/70 px-3 py-2 text-body text-fg-2">
          {body.text}
        </p>
      ) : null}

      {required.map((section, i) => (
        <section key={section.heading} className="mb-10">

          <LegalHeading2 id={requiredIds[i] ?? slugify(section.heading)}>{section.heading}</LegalHeading2>
          <div className="mt-4 flex flex-col gap-4 text-body text-fg-2">
            {section.paragraphs.map((p) => (
              <LegalBody key={p} markdown={p} />
            ))}
          </div>
        </section>
      ))}

      {body.kind === "file" ? <LegalBody markdown={body.text} idOffset={requiredTitles} /> : null}
    </DocumentFrame>
  );
}
