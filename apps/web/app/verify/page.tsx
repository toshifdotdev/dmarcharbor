import type { Metadata } from "next";
import { verifyCompliancePack, PublicError } from "@/lib/api-public";
import { getCapabilities } from "@/lib/api-ops";
import { requestOrigin } from "@/lib/metadata-origin";
import { publicMetadata } from "@/lib/seo";
import type { CompliancePackRecord } from "@/lib/types";
import { ArtefactFrame } from "@/components/harbor/artefact-frame";
import { FileCheck, ReferenceForm } from "@/components/harbor/pack-verifier";
import { KeyValue } from "@/components/ui/notice";
import { CopyButton, CopyValue } from "@/components/ui/copy";

/** Indexed on purpose. The page is only useful to someone who already holds a
 *  pack and needs to check it, and they arrive by searching for it rather than
 *  from a link inside the product, so a noindex here would hide the one route
 *  that has to be findable. */
export async function generateMetadata(): Promise<Metadata> {
  const origin = await requestOrigin();
  return publicMetadata({
    title: "Document fingerprint verifier",
    description:
      "Check that a compliance pack or monthly report you hold is the one that was issued. A SHA-256 digest of the exact bytes is published against the document reference, and a copy is genuine when its digest matches. No account needed.",
    path: "/verify",
    origin,
  });
}

function dateLabel(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "not recorded"
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function periodLabel(value: string | null): string {
  if (!value) return "Not applicable";
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return value;
  const [year, month] = [match[1]!, Number(match[2])];
  const names = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return month >= 1 && month <= 12 ? `${names[month - 1]} ${year}` : value;
}

function bytesLabel(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB (${n.toLocaleString("en-GB")} bytes)`;
  return `${(n / 1024 / 1024).toFixed(2)} MB (${n.toLocaleString("en-GB")} bytes)`;
}

/**
 * The document verifier. PUBLIC, no auth: an auditor checks a document they
 * hold against the published fingerprint with no account. The answer is only
 * ever about a digest: never the document itself, never a client name.
 *
 * This is not email verification. Email links land on the API's own
 * verify-email endpoint and then on /sign-in.
 *
 * Three outcomes, each said as what it is: a match is recorded, no pack carries
 * the reference (a withdrawn one answers the same way, by design), or the
 * lookup itself failed, which is not a "no".
 */
export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ reference?: string }> }) {
  const { reference } = await searchParams;
  const trimmed = (reference ?? "").trim();

  let packs: CompliancePackRecord[] | null = null;
  let outcome: "none" | "found" | "missing" | "failed" = "none";
  if (trimmed) {
    try {
      const res = await verifyCompliancePack(trimmed);
      packs = res.packs;
      outcome = res.found && res.packs.length > 0 ? "found" : "missing";
    } catch (error) {
      outcome = error instanceof PublicError && error.status === 404 ? "missing" : "failed";
    }
  }

  // The API's own demonstration reference, so the shape shown is real.
  const example = (await getCapabilities().catch(() => null))?.compliancePack?.exampleReference ?? null;

  // Current first, then superseded: the reader usually holds the latest.
  const ordered = (packs ?? []).slice().sort((a, b) => Number(a.superseded) - Number(b.superseded));

  return (
    <ArtefactFrame kind="Document verifier" meta={<>Public. No account needed. Answers only about a fingerprint.</>}>
      <div className="grid gap-x-14 gap-y-12 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-8">
          <header className="max-w-[62ch]">
            <h1 className="display text-[34px] leading-[1.02] text-fg sm:text-[40px]">
              Is this the document that was issued?
            </h1>
            <p className="mt-3 text-body text-fg-2">
              Every compliance pack and monthly report is published as a SHA-256 digest of its exact bytes, under the
              reference printed on its cover. A copy is genuine when its digest matches the one recorded here.
            </p>
          </header>

          <ReferenceForm initialReference={trimmed} example={example} />

          {outcome === "missing" ? (
            <section role="status" data-verify-result="missing" className="border-t border-rule pt-5 [animation:hb-rise_220ms_ease-out]">
              <p className="legend text-fail!">No document under this reference</p>
              <p className="data mt-2 break-all text-meta text-fg-3">{trimmed}</p>
              <p className="mt-2 max-w-[64ch] text-ui text-fg-2">
                No issued document carries this reference. Check it against the cover page, character by character. A
                document whose link was withdrawn answers the same way, by design, so this page cannot confirm that it
                ever existed.
              </p>
            </section>
          ) : null}

          {outcome === "failed" ? (
            <section role="alert" data-verify-result="failed" className="border-t border-rule pt-5">
              <p className="legend text-warn!">The lookup did not run</p>
              <p className="mt-2 max-w-[64ch] text-ui text-fg-2">
                The record could not be reached just now. This is not a &ldquo;no match&rdquo;: try again in a moment.
              </p>
            </section>
          ) : null}

          {outcome === "found" ? (
            <section data-verify-result="found" aria-labelledby="published-head" className="flex flex-col gap-6 border-t border-rule pt-5">
              <div className="[animation:hb-rise_220ms_ease-out]">
                <p className="legend text-ok!">Recorded</p>
                <h2 id="published-head" className="data mt-1.5 break-all text-[17px] font-semibold text-fg">
                  {ordered[0]?.reference ?? trimmed}
                </h2>
                <p className="mt-1.5 max-w-[64ch] text-ui text-fg-2">
                  This reference is on record. Compare the digest below with the SHA-256 of the PDF you hold, here or
                  by hand.
                </p>
              </div>

              <ol className="hb-stagger flex flex-col gap-6">
                {ordered.map((p, i) => (
                  <li key={`${p.sha256}-${i}`} style={{ "--i": i } as React.CSSProperties} className={p.superseded ? "opacity-75" : undefined}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2 pb-2">
                      <span className="text-ui font-semibold text-fg">
                        {p.kind === "monthly_report" ? "Monthly report" : "Compliance pack"} · version {p.documentVersion}
                      </span>
                      <span className={p.superseded ? "text-meta font-semibold text-fg-3" : "text-meta font-semibold text-ok"}>
                        {p.superseded ? "Superseded by a newer document" : "Current"}
                      </span>
                    </div>
                    <div data-copy-scope className="flex items-start gap-2 rounded-ctl border border-rule-2 bg-paper-2 px-3 py-2.5">
                      <p data-copy-value className="data min-w-0 flex-1 break-all text-ui text-fg" aria-label="SHA-256 digest of the issued document">
                        <span className="text-fg-3">sha256 </span>
                        {p.sha256}
                      </p>
                      <CopyButton value={p.sha256} label="Copy the SHA-256 digest" />
                    </div>
                    <KeyValue
                      className="mt-3"
                      labelWidth={120}
                      rows={[
                        ["Kind", p.kind === "monthly_report" ? "Monthly report" : "Compliance pack"],
                        ["Period", periodLabel(p.period)],
                        ["Issued", dateLabel(p.issuedAt)],
                        ["Data as of", dateLabel(p.dataAsOf)],
                        ["Pages", <span key="p" className="tnum">{p.pageCount}</span>],
                        ["Size", <span key="s" className="tnum">{bytesLabel(p.byteSize)}</span>],
                      ]}
                    />
                  </li>
                ))}
              </ol>

              <FileCheck
                published={ordered.map((p) => ({ sha256: p.sha256, documentVersion: p.documentVersion, superseded: p.superseded }))}
              />
            </section>
          ) : null}
        </div>

        <aside className="flex flex-col gap-6 self-start border-t border-rule pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          <div>
            <p className="legend pb-2">How the check works</p>
            <ol className="flex flex-col gap-3 text-ui">
              {[
                ["Look up the reference", "From the document's cover page. The record answers with the digest it was issued with."],
                ["Hash the file you hold", "Here, in the browser, or by hand with the command below."],
                ["Compare", "Identical digests mean identical bytes: the file has not changed since it was issued."],
              ].map(([k, v], i) => (
                <li key={k} className="grid grid-cols-[22px_minmax(0,1fr)] gap-2">
                  <span className="tnum font-bold text-fg-3">{i + 1}</span>
                  <span>
                    <span className="block font-semibold text-fg">{k}</span>
                    <span className="text-fg-2">{v}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <p className="legend pb-2">By hand</p>
            <CopyValue value="sha256sum your-report.pdf" label="Copy the command" />
            <p className="mt-1.5 text-meta text-fg-3">
              On Windows: <code className="data text-fg-2">certutil -hashfile file.pdf SHA256</code>. On macOS:{" "}
              <code className="data text-fg-2">shasum -a 256 file.pdf</code>.
            </p>
          </div>
          <div className="border-t border-rule pt-4">
            <p className="legend pb-1.5">What a match proves</p>
            <p className="text-meta text-fg-2">
              That the document is unaltered since it was issued. It is a self attestation by the issuer, not a third
              party audit, and it says nothing about the issuer beyond that. This page never serves the document and
              never names a client.
            </p>
          </div>
        </aside>
      </div>
    </ArtefactFrame>
  );
}
