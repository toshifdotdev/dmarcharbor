import type { Metadata } from "next";
import { verifyCompliancePack, PublicError } from "@/lib/api-public";
import { getCapabilities } from "@/lib/api-ops";
import { requestOrigin } from "@/lib/metadata-origin";
import { publicMetadata } from "@/lib/seo";
import type { CompliancePackRecord } from "@/lib/types";
import { ArtefactFrame } from "@/components/harbor/artefact-frame";
import { Digest, FileCheck, ReferenceForm } from "@/components/harbor/pack-verifier";
import v from "@/components/harbor/verify.module.css";
import { PostureMark } from "@/components/ui/badge";
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
      <div className="grid gap-x-16 gap-y-14 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-10">
          <header className="max-w-[40rem]">
            <h1 className="text-[36px] font-[760] leading-[0.98] tracking-[-0.035em] text-fg [text-wrap:balance] sm:text-[48px]">
              Is this the document that was issued?
            </h1>
            <p className="mt-5 text-[17px] leading-[1.5] text-fg-2 sm:text-[19px]">
              Every compliance pack and monthly report is published as a SHA-256 digest of its exact bytes, under the
              reference printed on its cover. A copy is genuine when its digest matches the one recorded here.
            </p>
          </header>

          <ReferenceForm initialReference={trimmed} example={example} />

          {outcome === "missing" ? (
            <section role="status" data-verify-result="missing" className="border-t border-fg pt-6">
              <p className="flex items-center gap-2.5 text-[17px] font-bold text-fail">
                {/* The refused terminus: a short red bar. */}
                <span aria-hidden className="block h-[18px] w-[5px] rounded-[1.5px] bg-fail" />
                No document under this reference
              </p>
              <p className="data mt-2 break-all text-[14px] text-fg-3">{trimmed}</p>
              <p className="mt-3 max-w-[64ch] text-[15px] leading-[1.55] text-fg-2">
                No issued document carries this reference. Check it against the cover page, character by character. A
                document whose link was withdrawn answers the same way, by design, so this page cannot confirm that it
                ever existed.
              </p>
            </section>
          ) : null}

          {outcome === "failed" ? (
            <section role="alert" data-verify-result="failed" className="border-t border-fg pt-6">
              <p className="flex items-center gap-2.5 text-[17px] font-bold text-warn">
                <PostureMark posture="unverified" size={12} />
                The lookup did not run
              </p>
              <p className="mt-3 max-w-[64ch] text-[15px] leading-[1.55] text-fg-2">
                The record could not be reached just now. This is not a &ldquo;no match&rdquo;: try again in a moment.
              </p>
            </section>
          ) : null}

          {outcome === "found" ? (
            <section data-verify-result="found" aria-labelledby="published-head" className="flex flex-col gap-8 border-t border-fg pt-6">
              <div>
                <p className="flex items-center gap-2.5 text-[17px] font-bold text-ok">
                  <PostureMark posture="pass" size={11} />
                  On record
                </p>
                <h2 id="published-head" className="data mt-2 break-all text-[17px] font-semibold text-fg">
                  {ordered[0]?.reference ?? trimmed}
                </h2>
                <p className="mt-2 max-w-[64ch] text-[15px] leading-[1.55] text-fg-2">
                  This reference is on record. Compare the digest below with the SHA-256 of the PDF you hold, here or
                  by hand.
                </p>
              </div>

              <ol className="flex flex-col gap-8">
                {ordered.map((p, i) => (
                  <li key={`${p.sha256}-${i}`}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pb-3">
                      <span className="text-[16px] font-bold text-fg">
                        {p.kind === "monthly_report" ? "Monthly report" : "Compliance pack"}{" "}
                        <span className="font-normal text-fg-4">version {p.documentVersion}</span>
                      </span>
                      <span
                        className={
                          p.superseded
                            ? "inline-flex items-center gap-1.5 text-[14px] font-semibold text-void"
                            : "inline-flex items-center gap-1.5 text-[14px] font-semibold text-ok"
                        }
                      >
                        <PostureMark posture={p.superseded ? "stale" : "pass"} size={10} />
                        {p.superseded ? "Superseded by a newer document" : "Current"}
                      </span>
                    </div>
                    <div data-copy-scope className="flex items-start gap-3 rounded-[10px] bg-paper-3 px-4 py-3.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-semibold text-fg-3">SHA-256 as issued</p>
                        <p
                          data-copy-value
                          className="mt-1 break-all text-[15px] text-fg"
                          aria-label="SHA-256 digest of the issued document"
                        >
                          <Digest value={p.sha256} />
                        </p>
                      </div>
                      <CopyButton value={p.sha256} label="Copy the SHA-256 digest" />
                    </div>
                    <KeyValue
                      className="mt-4"
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

        <aside className="flex flex-col gap-10 self-start border-t border-rule pt-8 lg:border-t-0 lg:pt-1">
          <figure className="m-0">
            <figcaption className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule pb-3">
              <span className="text-[16px] font-bold text-fg">How the check works</span>
              <span className="text-[14px] text-fg-4">three stops</span>
            </figcaption>
            <CheckRoute />
            <ol className="sr-only">
              <li>Look up the reference from the document&rsquo;s cover page. The record answers with the digest it was issued with.</li>
              <li>Hash the file you hold, here in the browser or by hand with the command below.</li>
              <li>Compare. Identical digests mean identical bytes: the file has not changed since it was issued.</li>
            </ol>
            <p className="mt-4 text-[14px] leading-[1.5] text-fg-2">
              Identical digests mean identical bytes: the file has not changed since it was issued. One changed byte
              gives a different digest.
            </p>
          </figure>
          <div>
            <p className="pb-2.5 text-[16px] font-bold text-fg">By hand</p>
            <CopyValue value="sha256sum your-report.pdf" label="Copy the command" />
            <p className="mt-2 text-[13.5px] leading-[1.6] text-fg-4">
              On Windows: <code className="data text-fg-2">certutil -hashfile file.pdf SHA256</code>. On macOS:{" "}
              <code className="data text-fg-2">shasum -a 256 file.pdf</code>.
            </p>
          </div>
          <div className="border-t border-rule pt-5">
            <p className="pb-2 text-[16px] font-bold text-fg">What a match proves</p>
            <p className="text-[14px] leading-[1.55] text-fg-2">
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

/**
 * The check as a short route. The reference is the origin, the file's SHA-256
 * the station, and a copy whose bytes match reaches the terminus. A changed
 * copy is turned away on a dashed red line, the way the home page's map turns
 * away a forged sender. Fixed geometry, so the server draws the final picture.
 */
function CheckRoute() {
  return (
    <svg viewBox="0 0 300 300" className={v.map} role="img" aria-label="Reference, then SHA-256 of the file, then match; a changed file is turned away">
      {/* The changed copy, turned away after the station. */}
      <path d="M20 144 L20 152 Q20 160 26 166 L74 214 Q80 220 80 228 L80 232" className={v.branch} />
      {/* The line every genuine copy travels. */}
      <path d="M20 22 L20 268" className={v.line} />
      <circle cx="20" cy="22" r="8" className={v.origin} />
      <rect x="4" y="122" width="32" height="24" rx="12" className={v.station} />
      <rect x="0" y="256" width="40" height="30" rx="15" className={v.station} />
      <rect x="67" y="232" width="26" height="5" rx="1.5" className={v.bar} />

      <text x="46" y="20" className={v.lbl}>
        <tspan className={v.name}>Reference</tspan>
        <tspan x="46" dy="18" className={v.kind}>
          from the cover page
        </tspan>
      </text>
      <text x="50" y="132" className={v.lbl}>
        <tspan className={v.name}>SHA-256</tspan>
        <tspan x="50" dy="18" className={v.kind}>
          of the file you hold
        </tspan>
      </text>
      <text x="104" y="232" className={v.lbl} data-fail="">
        <tspan className={v.name}>No match</tspan>
        <tspan x="104" dy="18" className={v.kind}>
          changed, or another file
        </tspan>
      </text>
      <text x="54" y="268" className={v.lbl}>
        <tspan className={v.name}>Match</tspan>
        <tspan x="54" dy="18" className={v.kind}>
          the bytes that were issued
        </tspan>
      </text>
    </svg>
  );
}
