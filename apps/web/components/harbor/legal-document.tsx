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
import { ChevronDown } from "@/components/ui/icons";
import { Contents, PrintButton } from "./legal-client";
import { LEGAL_TEXT, LegalBody, LegalHeading2, legalHeadings, PENDING_MARK, slugify, type LegalHeading } from "./legal-render";
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
  const showContents = headings.length >= 2;

  return (
    <div data-harbor data-host-brand={brand.state}>
      <div className="print:hidden">
        <PublicHeader brand={brand} current={current ?? "legal"} />
      </div>

      <main id="main" className="page-wrap pb-24 pt-12 sm:pt-16 min-[68.75rem]:pt-24 print:max-w-none print:p-0">
        {/* The document's identity, kept together and printed with it: whose
            document, what it is, which text, from when. */}
        <header className={`${RAIL_GRID} border-b border-fg pb-10 print:block print:pb-5`}>
          <p className="text-[15px] leading-[1.4] text-fg-4 min-[68.75rem]:pt-[0.55em]">
            <span className="font-bold text-fg">{name}</span> {kicker === "Support" ? "support" : "legal documents"}
          </p>
          <div className="min-w-0">
            <h1 className="max-w-[20ch] text-[40px] font-[760] leading-[0.98] tracking-[-0.035em] text-fg [text-wrap:balance] sm:text-[52px] min-[68.75rem]:text-[64px] print:text-[24pt]">
              {title}
            </h1>
            <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
              <p data-testid="legal-version" className="tnum text-[15px] text-fg-2">
                {/* Real spaces between the parts, so copied and spoken text
                    reads "Version 1.0 · Effective ..." rather than running the
                    words together. */}
                <span>Version</span> <span className="font-bold text-fg">{LEGAL_VERSION}</span>{" "}
                <span aria-hidden className="mx-1 text-fg-4">
                  ·
                </span>{" "}
                <span>Effective</span>{" "}
                {pending ? (
                  <mark className={PENDING_MARK}>{LEGAL_EFFECTIVE_DATE}</mark>
                ) : (
                  <span className="font-bold text-fg">{LEGAL_EFFECTIVE_DATE}</span>
                )}
              </p>
              <PrintButton />
            </div>
          </div>
        </header>

        {/* On a phone the contents are one tap away, above the text. */}
        {showContents ? (
          <details className="group mt-8 border-b border-rule pb-4 min-[68.75rem]:hidden print:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[15px] font-semibold text-fg [&::-webkit-details-marker]:hidden">
              <span>
                Contents <span className="font-normal text-fg-4">{headings.length} sections</span>
              </span>
              <span aria-hidden className="text-fg-3 transition-transform duration-150 group-open:rotate-180">
                <ChevronDown size={16} />
              </span>
            </summary>
            <div className="pt-5">
              <Contents headings={headings} />
            </div>
          </details>
        ) : null}

        <div className={`${RAIL_GRID} mt-10 min-[68.75rem]:mt-16 print:mt-6 print:block`}>
          <aside className="hidden min-[68.75rem]:block print:hidden">
            <div className="sticky top-8 flex max-h-[calc(100vh-4rem)] flex-col gap-12 overflow-y-auto pb-6 pr-2">
              <Contents headings={headings} />
              <DocumentIndex active={slug} rail />
            </div>
          </aside>
          <article className="min-w-0">{children}</article>
        </div>

        <div className="mt-20 border-t border-rule pt-10 min-[68.75rem]:hidden print:hidden">
          <DocumentIndex active={slug} />
        </div>

        <p className="mt-10 hidden border-t border-fg pt-3 text-[9pt] text-fg-2 print:block">
          {title} · version {LEGAL_VERSION} · {name}. The current text is published at /{slug === "support" ? "support" : slug}.
        </p>
      </main>

      <div className="print:hidden">
        <PublicFooter brand={brand} />
      </div>
    </div>
  );
}

/** The rail and the text column: the title, the contents and the body share
 *  one left edge for the text from 1100px. */
const RAIL_GRID = "grid gap-6 min-[68.75rem]:grid-cols-[248px_minmax(0,1fr)] min-[68.75rem]:gap-x-24";

/** Every public document, with the one open marked. They share one version,
 *  so the set is stated as a set. */
function DocumentIndex({ active, rail }: { active: string; rail?: boolean }) {
  return (
    <nav aria-label="All documents" className="print:hidden">
      <p className="pb-3 text-[14px] font-bold text-fg">
        All documents <span className="font-normal text-fg-4">version {LEGAL_VERSION}</span>
      </p>
      <ul className={rail ? "grid gap-y-2" : "grid gap-x-8 gap-y-2.5 sm:grid-cols-2 md:grid-cols-3"}>
        {[...LEGAL_DOCS.map((d) => [d.slug, d.title] as const), ["support", "Support and contact"] as const].map(([slug, title]) => (
          <li key={slug}>
            <Link
              href={`/${slug}`}
              aria-current={slug === active ? "page" : undefined}
              className={
                slug === active
                  ? "text-[14px] font-semibold text-fg underline decoration-fg decoration-[3px] underline-offset-[6px]"
                  : "text-[14px] text-fg-4 transition-colors duration-150 hover:text-fg"
              }
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
        <p className="text-[17px] leading-[1.6] text-fg-2">Every document in the list loads without an account.</p>
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
        // The text is not published yet: a state notice, in place of it.
        <p
          role="status"
          className="mb-12 flex max-w-[68ch] items-start gap-3 rounded-r-[10px] border-l-[3px] border-warn-mark bg-warn-wash px-4 py-3 text-[16px] leading-[1.55] text-fg-2"
        >
          <span aria-hidden className="mt-[7px] block size-2.5 shrink-0 rounded-full border-2 border-warn-mark" />
          <span>{body.text}</span>
        </p>
      ) : null}

      {required.map((section, i) => {
        const id = requiredIds[i] ?? slugify(section.heading);
        const m = /^(\d+(?:\.\d+)*\.?)\s+(.+)$/.exec(section.heading);
        return (
          <section key={section.heading} className="mb-12 last:mb-0">
            <LegalHeading2 id={id} variant="document" number={m ? m[1] : null}>
              {m ? m[2] : section.heading}
            </LegalHeading2>
            <div className={`mt-6 ${LEGAL_TEXT}`}>
              {section.paragraphs.map((p) => (
                <LegalBody key={p} markdown={p} />
              ))}
            </div>
          </section>
        );
      })}

      {body.kind === "file" ? <LegalBody markdown={body.text} idOffset={requiredTitles} /> : null}
    </DocumentFrame>
  );
}
