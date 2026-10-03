import type { TrustCenterPayload } from "@/lib/types";

/**
 * trust-center.tsx — the auditor-facing document.
 *
 * This is a legal artefact, not a settings page: Monolith Light, serif
 * document typography, wide rules, and every claim QUOTED from the API's
 * payload — the wording is the contract's own, never rewritten here. There is
 * no score, no dashboard, no action that mutates anything. A reader can print
 * this page and take it to a procurement meeting.
 */
export function TrustCenterView({ payload }: { payload: TrustCenterPayload }) {
  return (
    <main data-surface="artefact" className="artefact relative z-10 min-h-screen">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <header>
          <p
            className="num text-[11px] tracking-[0.22em] uppercase"
            style={{ color: "var(--ink-3)" }}
          >
            Trust Center · published by {payload.provider.workspaceName}
          </p>
          <h1 className="mt-4 text-[34px] leading-tight" style={{ color: "var(--ink)" }}>
            What we hold about {payload.client.name}, and who can see it.
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
            This page is public on purpose. It exists so an auditor at{" "}
            {payload.client.name} can read our data handling claims without an
            account, a sales call, or a signed NDA. Generated{" "}
            <span className="num">
              {new Date(payload.generatedAt).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </span>
            .
          </p>
          <p className="num mt-3 text-[11.5px]" style={{ color: "var(--color-unmeasured)" }}>
            domains covered: {payload.client.domains.join(", ") || "—"}
          </p>
        </header>

        <Section title="How this data is held">
          <Definition term="Isolation">{payload.statement.isolation}</Definition>
          <Definition term="Covered by tests">{payload.statement.coveredByTests}</Definition>
          <Definition term="Law-enforcement requests">
            {payload.statement.lawEnforcementRequests}
          </Definition>
        </Section>

        <Section title="What is held">
          <table className="mt-4 w-full border-collapse">
            <thead>
              <tr>
                {["Category", "Description", "Personal data"].map((h) => (
                  <th
                    key={h}
                    className="num border-b pb-2 pr-4 text-left text-[10.5px] tracking-[0.14em] uppercase"
                    style={{ borderColor: "var(--line-strong)", color: "var(--ink-3)" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {payload.dataHeld.map((d) => (
                <tr key={d.category}>
                  <td
                    className="border-b py-3 pr-4 text-[13.5px] align-top"
                    style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                  >
                    {d.category}
                  </td>
                  <td
                    className="border-b py-3 pr-4 text-[13.5px] align-top"
                    style={{ borderColor: "var(--line)", color: "var(--ink-2)" }}
                  >
                    {d.description}
                  </td>
                  <td
                    className="num border-b py-3 text-[11.5px] align-top"
                    style={{
                      borderColor: "var(--line)",
                      color: d.containsPersonalData ? "var(--color-block)" : "var(--color-unmeasured)",
                    }}
                  >
                    {d.containsPersonalData ? "yes" : "no"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title="Who can read it">
          <table className="mt-4 w-full border-collapse">
            <tbody>
              {payload.access.map((a) => (
                <tr key={a.role}>
                  <td
                    className="w-44 border-b py-3 pr-4 align-top text-[13.5px]"
                    style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                  >
                    {a.role}
                  </td>
                  <td
                    className="border-b py-3 text-[13.5px]"
                    style={{ borderColor: "var(--line)", color: "var(--ink-2)" }}
                  >
                    {a.canRead}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title="Retention and deletion">
          <Definition term="Data">{payload.retention.data}</Definition>
          <Definition term="Audit">{payload.retention.audit}</Definition>
          <Definition term="Deletion window">{payload.retention.deletionWindow}</Definition>
          {payload.erasures.length > 0 ? (
            <div className="mt-5">
              <p
                className="num text-[10.5px] tracking-[0.14em] uppercase"
                style={{ color: "var(--ink-3)" }}
              >
                Completed erasures
              </p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {payload.erasures.map((e, i) => (
                  <li key={`${e.scope}-${i}`} className="text-[13px]" style={{ color: "var(--ink-2)" }}>
                    {e.scope}: {e.recordCount} record{e.recordCount === 1 ? "" : "s"} removed{" "}
                    {new Date(e.completedAt).toLocaleDateString("en-GB")}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>

        <Section title="Where it is held">
          <Definition term="Region">{payload.residency.region}</Definition>
          <Definition term="Hosting">{payload.residency.hosting}</Definition>
        </Section>

        <Section title="Sub-processors">
          <table className="mt-4 w-full border-collapse">
            <thead>
              <tr>
                {["Provider", "Purpose", "Data they touch"].map((h) => (
                  <th
                    key={h}
                    className="num border-b pb-2 pr-4 text-left text-[10.5px] tracking-[0.14em] uppercase"
                    style={{ borderColor: "var(--line-strong)", color: "var(--ink-3)" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {payload.subProcessors.map((s) => (
                <tr key={s.name}>
                  <td
                    className="border-b py-3 pr-4 align-top text-[13.5px]"
                    style={{ borderColor: "var(--line)", color: "var(--ink)" }}
                  >
                    {s.name}
                  </td>
                  <td
                    className="border-b py-3 pr-4 align-top text-[13.5px]"
                    style={{ borderColor: "var(--line)", color: "var(--ink-2)" }}
                  >
                    {s.purpose}
                  </td>
                  <td
                    className="border-b py-3 align-top text-[13.5px]"
                    style={{ borderColor: "var(--line)", color: "var(--ink-2)" }}
                  >
                    {s.data}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section title="Rights of the people in this data">
          <Definition term="Export">{payload.rights.export}</Definition>
          <Definition term="Erasure">{payload.rights.erasure}</Definition>
          <p className="mt-4 text-[13px]" style={{ color: "var(--color-unmeasured)" }}>
            Export and erasure are available on every plan at no cost. They are
            not a paid feature.
          </p>
        </Section>

        <footer className="mt-14 border-t pt-6" style={{ borderColor: "var(--line-strong)" }}>
          <p className="num text-[10.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
            Every claim on this page is served by the platform itself at the
            address you are reading, and generated from the live record: not
            from marketing copy. To prove a compliance pack issued by{" "}
            {payload.provider.workspaceName}, use the published SHA-256 digest
            and the compliance verifier.
          </p>
        </footer>
      </div>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-12 border-t pt-8" style={{ borderColor: "var(--line-strong)" }}>
      <h2 className="text-[19px]" style={{ color: "var(--ink)" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Definition({
  term,
  children,
}: {
  term: string;
  children: React.ReactNode;
}) {
  return (
    <dl className="mt-4 grid grid-cols-1 gap-1 sm:grid-cols-[13rem_minmax(0,1fr)] gap-x-8">
      <dt
        className="num text-[10.5px] tracking-[0.14em] uppercase"
        style={{ color: "var(--ink-3)" }}
      >
        {term}
      </dt>
      <dd className="text-[13.5px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
        {children}
      </dd>
    </dl>
  );
}
