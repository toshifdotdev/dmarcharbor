import type { Metadata } from "next";
import Link from "next/link";
import { SWITCH_PAGE, SWITCH_QUESTIONS, SWITCH_STEPS } from "@/lib/switch-guide";
import { publicMetadata } from "@/lib/seo";
import { canonicalOrigin } from "@/lib/site-origin";
import { breadcrumbJsonLd, faqPageJsonLd, graph, nodeId } from "@/lib/structured-data";
import { ToolFrame } from "@/components/harbor/tools/tool-frame";
import { FigureHead } from "@/components/harbor/tools/lookup-line";
/**
 * /switch-dmarc-provider — moving a client's domains from another DMARC
 * service, step by step, as stations on one line, then the questions MSPs ask
 * about it, which are also the page's FAQPage. The two records are drawn as
 * the literal DNS they are, on a sample .example domain. Public and indexed on
 * our own host; on an agency's domain the proxy sends it to the portal
 * (lib/white-label.ts VENDOR_ROUTES).
 */
export async function generateMetadata(): Promise<Metadata> {
  return publicMetadata({ title: SWITCH_PAGE.title, description: SWITCH_PAGE.description, path: SWITCH_PAGE.path });
}

/** A sample record before and during the switch. Sample domain, sample addresses. */
const SAMPLE = {
  before: "v=DMARC1; p=quarantine; rua=mailto:reports@old-service.example; ruf=mailto:forensic@old-service.example; fo=1",
  dual: "v=DMARC1; p=quarantine; rua=mailto:<the client's report address>,mailto:reports@old-service.example; ruf=mailto:forensic@old-service.example; fo=1",
  cutover: "v=DMARC1; p=quarantine; rua=mailto:<the client's report address>; fo=1",
};

export default async function SwitchProviderGuidePage() {
  const origin = await canonicalOrigin();
  const page = new URL(SWITCH_PAGE.path, origin).toString();
  const faq = faqPageJsonLd(
    origin,
    SWITCH_PAGE.path,
    SWITCH_QUESTIONS.map((q) => ({ id: q.id, question: q.question, answer: q.answer, section: null, sectionId: null, pending: false })),
  );
  const structured = graph([
    {
      "@type": "HowTo",
      "@id": `${page}#howto`,
      name: SWITCH_PAGE.title,
      description: SWITCH_PAGE.description,
      url: page,
      inLanguage: "en",
      isPartOf: { "@id": nodeId(origin, "website") },
      step: SWITCH_STEPS.map((step, i) => ({
        "@type": "HowToStep",
        position: i + 1,
        name: step.name,
        text: step.text,
        url: `${page}#${step.id}`,
      })),
    },
    ...(faq ? [faq] : []),
    breadcrumbJsonLd(origin, [{ name: "Switch DMARC provider", path: SWITCH_PAGE.path }]),
  ]);

  return (
    <ToolFrame
      slug={null}
      structured={structured}
      crumb={null}
      showTools
      closingHeadline="Every report, on both sides, until you choose."
      headline="Switch DMARC provider without losing a day of reports."
      lead={
        <p>
          Taking on a client that already has a DMARC service? Report to both while you check, then cut over. The
          domain&rsquo;s policy never changes and no report is lost.{" "}
          <Link href="/sign-up" className="link">
            Start free
          </Link>
          ; the switch kit is on every plan.
        </p>
      }
    >
      <div className="flex flex-col gap-16">
        <section data-testid="switch-steps" aria-labelledby="steps-head">
          <FigureHead name={<span id="steps-head">How a switch runs</span>} meta={`${SWITCH_STEPS.length} stops, in order`} />
          <ol className="m-0 mt-6 list-none p-0">
            {SWITCH_STEPS.map((step, i) => {
              const last = i === SWITCH_STEPS.length - 1;
              return (
                <li key={step.id} id={step.id} className={`relative scroll-mt-6 pl-10 ${last ? "" : "pb-8"}`}>
                  {last ? null : <span aria-hidden className="absolute bottom-0 left-[7px] top-[10px] w-[5px] bg-done" />}
                  <span aria-hidden className="absolute left-0 top-[2px] size-[19px] rounded-full border-[3px] border-done bg-done" />
                  <h2 className="text-[17px] font-bold leading-[1.35] text-fg">{step.name}</h2>
                  <p className="mt-1 max-w-[44rem] text-[15.5px] leading-[1.55] text-fg-2">{step.text}</p>
                </li>
              );
            })}
          </ol>
        </section>

        <section data-testid="switch-records" aria-labelledby="records-head">
          <FigureHead name={<span id="records-head">The record, at each stop</span>} meta="sample: _dmarc.pellowyn-dental.example" />
          <dl className="mt-4 flex flex-col">
            {(
              [
                ["Before", "what the domain publishes today", SAMPLE.before],
                ["Dual reporting", "our address added first; everything else as it was", SAMPLE.dual],
                ["Cut over", "the old service's addresses removed; policy unchanged", SAMPLE.cutover],
              ] as const
            ).map(([name, kind, value]) => (
              <div key={name} className="border-b border-rule py-4 last:border-b-0">
                <dt className="text-[15.5px] text-fg">
                  <span className="font-bold">{name}</span> <span className="text-fg-4">{kind}</span>
                </dt>
                <dd className="mt-2">
                  <code className="data block break-all rounded-[8px] bg-paper-3 px-3 py-2 text-[13.5px] text-fg-2">{value}</code>
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 max-w-[44rem] text-[14px] leading-[1.55] text-fg-4">
            Sample record on a sample domain. The switch kit writes the real ones from each domain&rsquo;s live DMARC
            record, with the client&rsquo;s own report address.
          </p>
        </section>

        <section data-testid="switch-questions" aria-labelledby="questions-head">
          <FigureHead name={<span id="questions-head">Questions MSPs ask about switching</span>} meta="answered in full" />
          <div className="mt-2">
            {SWITCH_QUESTIONS.map((q) => (
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
