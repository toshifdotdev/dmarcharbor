import type { Metadata } from "next";
import Link from "next/link";
import { MSP_NEEDS, MSP_PAGE, MSP_QUESTIONS } from "@/lib/msp-page";
import { publicMetadata } from "@/lib/seo";
import { canonicalOrigin } from "@/lib/site-origin";
import { breadcrumbJsonLd, faqPageJsonLd, graph, nodeId } from "@/lib/structured-data";
import { ToolFrame } from "@/components/harbor/tools/tool-frame";
import { FigureHead } from "@/components/harbor/tools/lookup-line";

/**
 * /dmarc-for-msps — what an MSP needs from DMARC software, as stations on one
 * line, and the questions MSPs ask, as anchored headings that are also the
 * page's FAQPage. Public and indexed on our own host; on an agency's domain
 * the proxy sends it to the portal (lib/white-label.ts VENDOR_ROUTES).
 */
export async function generateMetadata(): Promise<Metadata> {
  return publicMetadata({ title: MSP_PAGE.title, description: MSP_PAGE.description, path: MSP_PAGE.path });
}

export default async function MspPage() {
  const origin = await canonicalOrigin();
  const page = new URL(MSP_PAGE.path, origin).toString();
  const faq = faqPageJsonLd(
    origin,
    MSP_PAGE.path,
    MSP_QUESTIONS.map((q) => ({ id: q.id, question: q.question, answer: q.answer, section: null, sectionId: null, pending: false })),
  );
  const structured = graph([
    {
      "@type": "WebPage",
      "@id": `${page}#page`,
      name: MSP_PAGE.title,
      description: MSP_PAGE.description,
      url: page,
      inLanguage: "en",
      isPartOf: { "@id": nodeId(origin, "website") },
      about: { "@id": nodeId(origin, "software") },
    },
    ...(faq ? [faq] : []),
    breadcrumbJsonLd(origin, [{ name: "DMARC for MSPs", path: MSP_PAGE.path }]),
  ]);

  return (
    <ToolFrame
      slug={null}
      structured={structured}
      crumb={null}
      showTools
      closingHeadline="Every client's mail, mapped."
      headline="DMARC monitoring for MSPs and IT agencies."
      lead={
        <p>
          Built for the people who look after email for many client companies: every client&rsquo;s domains in one
          place, reports in your brand, and a safe route to p=reject.{" "}
          <Link href="/sign-up" className="link">
            Start free
          </Link>{" "}
          with one client and two domains, no card.
        </p>
      }
    >
      <div className="flex flex-col gap-16">
        <section data-testid="msp-needs" aria-labelledby="needs-head">
          <FigureHead name={<span id="needs-head">What an MSP needs from DMARC software</span>} meta="and how it is met here" />
          <ol className="m-0 mt-6 list-none p-0">
            {MSP_NEEDS.map((need, i) => {
              const last = i === MSP_NEEDS.length - 1;
              return (
                <li key={need.id} id={need.id} className={`relative scroll-mt-6 pl-10 ${last ? "" : "pb-8"}`}>
                  {last ? null : <span aria-hidden className="absolute bottom-0 left-[7px] top-[10px] w-[5px] bg-done" />}
                  <span aria-hidden className="absolute left-0 top-[2px] size-[19px] rounded-full border-[3px] border-done bg-done" />
                  <h2 className="text-[17px] font-bold leading-[1.35] text-fg">{need.name}</h2>
                  <p className="mt-1 max-w-[44rem] text-[15.5px] leading-[1.55] text-fg-2">
                    {need.text}{" "}
                    <Link href={need.href} className="link whitespace-nowrap">
                      {need.linkLabel}
                    </Link>
                  </p>
                </li>
              );
            })}
          </ol>
        </section>

        <section data-testid="msp-questions" aria-labelledby="questions-head">
          <FigureHead name={<span id="questions-head">Questions MSPs ask</span>} meta="answered in full" />
          <div className="mt-2">
            {MSP_QUESTIONS.map((q) => (
              <div key={q.id} id={q.id} className="scroll-mt-6 border-b border-rule py-6 last:border-b-0">
                <h3 className="text-[17px] font-bold leading-[1.35] text-fg">{q.question}</h3>
                <p className="mt-2 max-w-[44rem] text-[15.5px] leading-[1.6] text-fg-2">{q.answer}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </ToolFrame>
  );
}
