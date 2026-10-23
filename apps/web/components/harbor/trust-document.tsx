/**
 * trust-document.tsx — the public Trust Center an auditor opens.
 *
 * Its reader is a security or procurement reviewer at the client, with a
 * questionnaire open in another window. They need to find each answer fast,
 * quote it exactly, and print the page for a meeting. So: a summary of the
 * facts they will be asked first (personal data held, who processes it, where
 * it lives, deletions done), then each section with a stable address, a
 * contents list that tracks where they are, and print.
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

const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

export function TrustDocument({ payload }: { payload: TrustCenterPayload }) {
  const personal = payload.dataHeld.filter((d) => d.containsPersonalData).length;

  return (
    <article>
      <header className="flex flex-col gap-4 border-b border-fg pb-8">
        <p className="legend">Published by {payload.provider.workspaceName}</p>
        <h1 className="display max-w-[24ch] text-[30px] leading-[1.05] text-fg sm:text-[40px]">
          What we hold about {payload.client.name}, and who can see it.
        </h1>
        <p className="max-w-[70ch] text-body text-fg-2">
          This page is public on purpose, so a reviewer at {payload.client.name} can read these data handling claims
          without an account, a sales call or an NDA. It is generated from the live record, not from marketing copy.
          Generated <span className="tnum font-semibold text-fg">{date(payload.generatedAt)}</span>.
        </p>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="legend">Domains covered</span>
          {payload.client.domains.length ? (
            payload.client.domains.map((d) => (
              <span key={d} className="data text-ui font-semibold text-fg">
                {d}
              </span>
            ))
          ) : (
            <span className="text-ui text-fg-3">none listed</span>
          )}
        </div>
      </header>

      <div className="mt-8">
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
      </div>

      <div className="mt-10 grid gap-10 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-12">
        <aside className="hidden lg:block">
          <div className="sticky top-8">
            <Contents headings={SECTIONS} />
          </div>
        </aside>

        <div className="flex min-w-0 flex-col gap-2">
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
            <h3 className="mt-6 text-body font-bold text-fg">Completed erasures</h3>
            {payload.erasures.length === 0 ? (
              <p className="mt-1 text-ui text-fg-3">None have been carried out for this client.</p>
            ) : (
              <div className="mt-2">
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
            <p className="mt-3 text-ui text-fg-3">Export and erasure are available on every plan at no cost. They are not a paid feature.</p>
          </Section>

          <footer className="mt-10 border-t border-fg pt-6 text-meta text-fg-3">
            <p className="max-w-[80ch]">
              Every claim on this page is served by the platform at the address you are reading, from the live record. To
              check that a compliance pack issued by {payload.provider.workspaceName} is genuine and unchanged, compare its
              published SHA-256 fingerprint in the{" "}
              <Link href="/verify" className="link">
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
    <section aria-labelledby={id} className="mt-8 first:mt-0">
      <LegalHeading2 id={id}>{title}</LegalHeading2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="border-t border-rule">
      {rows.map(([k, v]) => (
        <div key={k} className="grid gap-1 border-b border-rule py-3 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-6">
          <dt className="text-ui font-bold text-fg">{k}</dt>
          <dd className="max-w-[70ch] text-body text-fg-2">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
