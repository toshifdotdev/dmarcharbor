import { verifyCompliancePack, PublicError } from "@/lib/api-public";
import { ComplianceVerifyForm } from "@/components/compliance-verify";

/**
 * The compliance pack verifier. PUBLIC, no auth — an auditor checks a document
 * they hold against the platform's published fingerprint with no account.
 * The answer is only ever about a digest: never the document, never a client
 * name. Monolith Light, document typography: a legal artefact, not a screen.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ reference?: string }>;
}) {
  const { reference } = await searchParams;
  const trimmed = (reference ?? "").trim();

  let result: Awaited<ReturnType<typeof verifyCompliancePack>> | null = null;
  let notFound = false;

  if (trimmed) {
    try {
      result = await verifyCompliancePack(trimmed);
    } catch (error) {
      if (error instanceof PublicError && error.status === 404) notFound = true;
      else throw error;
    }
  }

  return (
    <main data-surface="artefact" className="artefact relative z-10 min-h-screen">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <header>
          <p
            className="num text-[11px] tracking-[0.22em] uppercase"
            style={{ color: "var(--ink-3)" }}
          >
            Compliance pack · public verifier
          </p>
          <h1 className="mt-4 text-[32px] leading-tight" style={{ color: "var(--ink)" }}>
            Does this document match the one we issued?
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
            Every compliance pack we issue is published as a SHA-256 digest of
            the exact bytes. A copy you hold is genuine when its digest matches
            the one recorded here — that is the whole test, and it needs no
            account.
          </p>
        </header>

        <ComplianceVerifyForm initialReference={trimmed} />

        {trimmed && notFound ? (
          <div
            role="status"
            className="mt-8 border-t pt-6"
            style={{ borderColor: "var(--line-strong)" }}
          >
            <p
              className="num text-[11px] tracking-[0.18em] uppercase"
              style={{ color: "var(--color-block)" }}
            >
              No match
            </p>
            <p className="mt-2 text-[14px]" style={{ color: "var(--ink-2)" }}>
              No issued pack carries this reference. Check the reference printed
              in the document — it appears on the cover page — and try again.
              A pack whose link was withdrawn also answers this way, by design.
            </p>
          </div>
        ) : null}

        {result?.found ? (
          <div className="mt-8 border-t pt-6" style={{ borderColor: "var(--line-strong)" }}>
            <p
              className="num text-[11px] tracking-[0.18em] uppercase"
              style={{ color: "var(--color-pass)" }}
            >
              Published
            </p>
            <p
              className="num mt-2 text-[11.5px] break-all"
              style={{ color: "var(--ink-3)" }}
            >
              reference {result.packs[0]?.reference ?? trimmed}
            </p>
            <p className="mt-2 text-[14px]" style={{ color: "var(--ink-2)" }}>
              This reference is recorded. Compare the digest below against the
              SHA-256 of the PDF you hold — a match means the bytes are exactly
              what we issued.
            </p>
            <ul className="mt-5 flex flex-col gap-4">
              {result.packs.map((p) => (
                <li
                  key={`${p.reference}-${p.createdAt}`}
                  className="border p-4"
                  style={{
                    borderColor: p.supersededAt ? "var(--line)" : "var(--line-strong)",
                    opacity: p.supersededAt ? 0.6 : 1,
                  }}
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <span
                      className="num text-[10.5px] tracking-[0.14em] uppercase"
                      style={{ color: "var(--ink-3)" }}
                    >
                      {p.documentVersion}
                    </span>
                    <span
                      className="num text-[10.5px] tracking-[0.14em] uppercase"
                      style={{
                        color: p.supersededAt ? "var(--color-unmeasured)" : "var(--color-pass)",
                      }}
                    >
                      {p.supersededAt
                        ? `superseded ${new Date(p.supersededAt).toLocaleDateString("en-GB")}`
                        : "current"}
                    </span>
                  </div>
                  <p
                    className="num mt-2 text-[11px] break-all"
                    style={{ color: "var(--ink)" }}
                    aria-label="SHA-256 digest of the issued document"
                  >
                    sha256: {p.sha256}
                  </p>
                  <p className="num mt-2 text-[11px]" style={{ color: "var(--ink-3)" }}>
                    {p.pageCount} page{p.pageCount === 1 ? "" : "s"} · {p.byteSize} bytes ·{" "}
                    issued {new Date(p.createdAt).toLocaleDateString("en-GB")} · as of{" "}
                    {new Date(p.asOf).toLocaleDateString("en-GB")}
                  </p>
                </li>
              ))}
            </ul>
            <p className="mt-5 text-[12px]" style={{ color: "var(--ink-3)" }}>
              This page answers only about a fingerprint. It never serves the
              document and never names a client — verification and confidentiality
              are different jobs, and this one is deliberately the former.
            </p>
          </div>
        ) : null}

        <footer className="mt-16 border-t pt-6" style={{ borderColor: "var(--line-strong)" }}>
          <p className="num text-[10.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
            This verifier is public by design: an auditor holds a document long
            before anyone at their company has an account with us. Hashing the
            file you hold (for example <code>sha256sum dmarc-compliance-….pdf</code>)
            and comparing it to the digest above is the complete test.
          </p>
        </footer>
      </div>
    </main>
  );
}
