/**
 * trust-document.tsx — the public Trust Center an auditor opens.
 *
 * Its reader is a security or procurement reviewer at the client, with a
 * questionnaire open in another window. They need to find each answer fast,
 * quote it exactly, and print the page for a meeting. So it is set like the
 * public legal documents it sits beside: the document's identity first (who
 * publishes it, about whom, generated when), the facts they are asked first as
 * a row of figures, then each section with a stable address and a heading
 * that links to itself, and a contents line that marks where they are.
 *
 * Every claim is QUOTED from the API's payload, the platform's own wording:
 * nothing is rewritten, summarised beyond counting, or embellished. There is
 * no score and no action that changes anything.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import type { TrustCenterPayload } from "@/lib/types";
import { Readout, ReadoutStrip } from "@/components/ui/readout";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { ChevronDown } from "@/components/ui/icons";
import { Contents } from "./legal-client";
import { LegalHeading2 } from "./legal-render";

const SECTIONS = [
  { id: "how-it-is-held", text: "How this data is held" },
  { id: "what-is-held", text: "What is held" },
  { id: "who-can-read-it", text: "Who can read it" },
  { id: "retention-and-deletion", text: "Retention and deletion" },
  { id: "where-it-is-held", text: "Where it is held" },
  { id: "sub-processors", text: "Sub-processors" },
  { id: "rights", text: "Rights of the people in this data" },
];

/** The rail and the text column, as the legal documents set them. */
const RAIL = "grid gap-6 min-[1100px]:grid-cols-[248px_minmax(0,1fr)] min-[1100px]:gap-x-24";

const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

export function TrustDocument({ payload }: { payload: TrustCenterPayload }) {
  const personal = payload.dataHeld.filter((d) => d.containsPersonalData).length;

  return (
    <article>
      <header className={`${RAIL} border-b border-fg pb-10 print:block print:pb-5`}>
        <p className="text-[15px] leading-[1.4] text-fg-4 min-[1100px]:pt-[0.55em]">
          Published by <span className="font-bold text-fg">{payload.provider.workspaceName}</span>
        </p>
        <div className="min-w-0">
          <h1 className="max-w-[20ch] text-[38px] font-[760] leading-[0.98] tracking-[-0.035em] text-fg [text-wrap:balance] sm:text-[52px] min-[1100px]:text-[60px] print:text-[24pt]">
            What we hold about {payload.client.name}, and who can see it.
          </h1>
          <p className="mt-7 max-w-[38rem] text-[17px] leading-[1.5] text-fg-2 sm:text-[19px]">
            This page is public on purpose, so a reviewer at {payload.client.name} can read these data handling claims
            without an account, a sales call or an NDA. It is generated from the live record, not from marketing copy.
          </p>
          <dl className="mt-7 flex flex-wrap items-baseline gap-x-8 gap-y-3 text-[15px]">
            <div className="flex items-baseline gap-2">
              <dt className="text-fg-4">Generated</dt>
              <dd className="tnum font-bold text-fg">{date(payload.generatedAt)}</dd>
            </div>
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <dt className="text-fg-4">Domains covered</dt>
              {payload.client.domains.length ? (
                payload.client.domains.map((d) => (
                  <dd key={d} className="data text-[14px] font-semibold text-fg [overflow-wrap:anywhere]">
                    {d}
                  </dd>
                ))
              ) : (
                <dd className="text-fg-3">none listed</dd>
              )}
            </div>
          </dl>
        </div>
      </header>

      {/* On a phone the contents are one tap away, above the text. */}
      <details className="group mt-8 border-b border-rule pb-4 min-[1100px]:hidden print:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[15px] font-semibold text-fg [&::-webkit-details-marker]:hidden">
          <span>
            Contents <span className="font-normal text-fg-4">{SECTIONS.length} sections</span>
          </span>
          <span aria-hidden className="text-fg-3 transition-transform duration-150 group-open:rotate-180">
            <ChevronDown size={16} />
          </span>
        </summary>
        <div className="pt-5">
          <Contents headings={SECTIONS} />
        </div>
      </details>

      <div className={`${RAIL} mt-10 min-[1100px]:mt-14 print:mt-6 print:block`}>
        <aside className="hidden min-[1100px]:block print:hidden">
          <div className="sticky top-8">
            <Contents headings={SECTIONS} />
          </div>
        </aside>

        <div className="flex min-w-0 flex-col">
          <ReadoutStrip>
            <Readout
              label="Personal data"
              value={`${personal} of ${payload.dataHeld.length}`}
              note="categories held contain personal data"
            />
            <Readout label="Sub-processors" value={String(payload.subProcessors.length)} note="named below, with what they touch" />
            <Readout label="Region" value={<span className="text-h3">{payload.residency.region}</span>} note={payload.residency.hosting} />
            <Readout label="Completed erasures" value={String(payload.erasures.length)} note="listed under retention" />
          </ReadoutStrip>

          <Section id="how-it-is-held" title="How this data is held">
            <Facts
              rows={[
                ["Isolation", payload.statement.isolation],
                ["Covered by tests", payload.statement.coveredByTests],
                ["Law-enforcement requests", payload.statement.lawEnforcementRequests],
              ]}
            />
          </Section>

          <Section id="what-is-held" title="What is held">
            <Table caption="Categories of data held" minWidth={560}>
              <THead>
                <tr>
                  <Th>Category</Th>
                  <Th>Description</Th>
                  <Th>Personal data</Th>
                </tr>
              </THead>
              <TBody>
                {payload.dataHeld.map((d) => (
                  <Tr key={d.category}>
                    <Td className="font-semibold">{d.category}</Td>
                    <Td className="text-fg-2">{d.description}</Td>
                    {/* A disclosure, not a state: set in ink, not in a warning colour. */}
                    <Td>{d.containsPersonalData ? <span className="font-bold text-fg">Yes</span> : <span className="text-fg-3">No</span>}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </Section>

          <Section id="who-can-read-it" title="Who can read it">
            <Facts rows={payload.access.map((a) => [a.role, a.canRead])} />
          </Section>

          <Section id="retention-and-deletion" title="Retention and deletion">
            <Facts
              rows={[
                ["Data", payload.retention.data],
                ["Audit", payload.retention.audit],
                ["Deletion window", payload.retention.deletionWindow],
              ]}
            />
            <h3 className="mt-8 text-[17px] font-bold tracking-[-0.01em] text-fg">Completed erasures</h3>
            {payload.erasures.length === 0 ? (
              <p className="mt-1.5 text-[15px] text-fg-3">None have been carried out for this client.</p>
            ) : (
              <div className="mt-3">
                <Table caption="Completed erasures" dense minWidth={420}>
                  <THead>
                    <tr>
                      <Th>Scope</Th>
                      <Th numeric>Records removed</Th>
                      <Th numeric>Completed</Th>
                    </tr>
                  </THead>
                  <TBody>
                    {payload.erasures.map((e, i) => (
                      <Tr key={`${e.scope}-${i}`}>
                        <Td>{e.scope}</Td>
                        <Td numeric>{e.recordCount.toLocaleString("en-GB")}</Td>
                        <Td numeric muted>
                          {date(e.completedAt)}
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </Section>

          <Section id="where-it-is-held" title="Where it is held">
            <Facts
              rows={[
                ["Region", payload.residency.region],
                ["Hosting", payload.residency.hosting],
              ]}
            />
          </Section>

          <Section id="sub-processors" title="Sub-processors">
            <Table caption="Sub-processors" minWidth={560}>
              <THead>
                <tr>
                  <Th>Provider</Th>
                  <Th>Purpose</Th>
                  <Th>Data they touch</Th>
                </tr>
              </THead>
              <TBody>
                {payload.subProcessors.map((s) => (
                  <Tr key={s.name}>
                    <Td className="font-semibold">{s.name}</Td>
                    <Td className="text-fg-2">{s.purpose}</Td>
                    <Td className="text-fg-2">{s.data}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </Section>

          <Section id="rights" title="Rights of the people in this data">
            <Facts
              rows={[
                ["Export", payload.rights.export],
                ["Erasure", payload.rights.erasure],
              ]}
            />
            <p className="mt-4 text-[15px] text-fg-3">Export and erasure are available on every plan at no cost. They are not a paid feature.</p>
          </Section>

          <footer className="mt-16 border-t border-fg pt-6 print:mt-8">
            <p className="max-w-[72ch] text-[13.5px] leading-[1.55] text-fg-4">
              Every claim on this page is served by the platform at the address you are reading, from the live record. To
              check that a compliance pack issued by {payload.provider.workspaceName} is genuine and unchanged, compare its
              published SHA-256 fingerprint in the{" "}
              <Link href="/verify" className="link text-fg-2">
                public verifier
              </Link>
              .
            </p>
          </footer>
        </div>
      </div>
    </article>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-16 print:mt-8">
      <LegalHeading2 id={id} variant="document">
        {title}
      </LegalHeading2>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="border-t border-rule">
      {rows.map(([k, v]) => (
        <div key={k} className="grid gap-1 border-b border-rule py-3.5 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-8">
          <dt className="text-[15px] font-bold text-fg">{k}</dt>
          <dd className="max-w-[68ch] text-[16px] leading-[1.6] text-fg-2 print:text-[10.5pt]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
