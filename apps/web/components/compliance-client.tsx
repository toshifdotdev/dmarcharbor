"use client";

/**
 * compliance-client.tsx — compliance pack issuance, per client.
 *
 * The SHA-256 fingerprint is the artefact: it is the claim an MSP emails, so
 * it is presented as the primary object on the page and made copyable in one
 * click. The PDF is what it fingerprints — a download, secondary to the
 * digest itself.
 *
 * Honest reassurance, kept honest: /verify answers ONLY about the published
 * fingerprint. It is never rendered as a general compliance statement — a
 * match proves the bytes are what we issued, nothing more.
 */

import { ActionButton } from "@/components/action-button";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { issueCompliancePack } from "@/lib/ops-client";
import type { ApiErrorBody, CompliancePackRow } from "@/lib/types";

export function CompliancePackPanel({
  organizationId,
  clientId,
  clientName,
  packs,
}: {
  organizationId: string;
  clientId: string;
  clientName: string;
  packs: CompliancePackRow[];
}) {
  const router = useRouter();
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ reference: string; sha256: string; filename: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function issue() {
    setBusy(true);
    setError(null);
    setIssued(null);
    const res = await issueCompliancePack(organizationId, clientId);
    if (!res.ok) {
      setError(res.error);
    } else {
      const pack = res.data;
      // Hand the PDF to the browser as a download, and keep the fingerprint:
      // the claim: in the page where it can be copied into an email.
      const url = URL.createObjectURL(pack.bytes);
      const a = document.createElement("a");
      a.href = url;
      a.download = pack.filename;
      a.click();
      setIssued({ reference: pack.reference, sha256: pack.sha256, filename: pack.filename, url });
    }
    setBusy(false);
    router.refresh();
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {issued ? (
        <div
          role="status"
          data-testid="pack-issued"
          className="rounded-[2px] border px-5 py-5"
          style={{ borderColor: "var(--color-accent)", background: "var(--color-accent-soft)" }}
        >
          <p
            className="num text-[11px] font-semibold tracking-[0.12em] uppercase"
            style={{ color: "var(--color-ink)" }}
          >
            Pack issued: the fingerprint is the claim
          </p>
          <p className="mt-2 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
            The PDF downloads automatically. Send this fingerprint with it:
            a recipient proves their copy is genuine by hashing the file and
            comparing, at{" "}
            <a href="/verify" className="underline" style={{ color: "var(--color-ink)" }}>
              the public verifier
            </a>
            . Verification answers only about the fingerprint: it confirms the
            bytes are exactly what was issued, nothing more.
          </p>
          <div
            className="num mt-3 flex items-center gap-3 rounded-[2px] border px-3 py-2.5 text-[12px] break-all"
            style={{
              background: "var(--color-elevate)",
              borderColor: "var(--color-line-strong)",
              color: "var(--color-ink)",
            }}
          >
            <span className="flex-1" data-testid="pack-fingerprint">
              {issued.sha256}
            </span>
            <ActionButton
              label={copied ? "copied" : "copy SHA-256"}
              loadingLabel="Copying…"
              busy={false}
              onClick={() => copy(issued.sha256)}
              variant="ghost"
              testId="pack-copy"
            />
          </div>
        </div>
      ) : null}

      <section
        className="lift rounded-[2px] border p-5"
        style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      >
        <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">
          Compliance packs{clientName ? `: ${clientName}` : ""}
        </h2>
        <p className="mt-2 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
          The PDF is generated from measured report data as of today. Its
          SHA-256 fingerprint is published with it: the file is the record,
          the fingerprint is the claim you can stand behind.
        </p>

        {error ? (
          <p role="alert" className="mt-3 text-[14px]" style={{ color: "var(--color-block)" }}>
            {error.message}
          </p>
        ) : null}

        <ActionButton
          label="Issue compliance pack"
          loadingLabel="Issuing pack…"
          busy={busy}
          onClick={issue}
          testId="pack-issue"
          style={{ marginTop: 16, alignSelf: "flex-start" }}
        />

        {packs.length > 0 ? (
          <ul className="mt-5 border-t pt-3" style={{ borderColor: "var(--color-line)" }}>
            {packs.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b py-3"
                style={{
                  borderColor: "rgba(255,255,255,0.055)",
                  opacity: p.superseded ? 0.6 : 1,
                }}
              >
                <div className="min-w-0 flex-1">
                  <div className="num text-[11.5px] break-all" style={{ color: "var(--color-ink)" }}>
                    {p.hash.slice(0, 24)}…
                  </div>
                  <div className="num text-[11px]" style={{ color: "var(--color-ink-3)" }}>
                    {p.documentVersion} · issued{" "}
                    {new Date(p.issuedAt).toLocaleDateString("en-GB")} · as of{" "}
                    {new Date(p.asOf).toLocaleDateString("en-GB")}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => copy(p.hash)}
                  data-testid="pack-copy-row"
                  className="rounded-[2px] border px-3 py-1.5 text-[11px]"
                  style={{ borderColor: "var(--color-line-strong)", color: "var(--color-ink-2)" }}
                >
                  copy SHA-256
                </button>
                <a
                  href={`/verify?reference=${encodeURIComponent(p.id)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] underline"
                  style={{ color: "var(--color-ink-2)" }}
                >
                  verify link
                </a>
                <span
                  className="num text-[10px] tracking-[0.12em] uppercase"
                  style={{
                    color: p.superseded ? "var(--color-unmeasured)" : "var(--color-pass)",
                  }}
                >
                  {p.superseded ? "superseded" : "current"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-5 text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
            No packs issued yet.
          </p>
        )}
      </section>
    </div>
  );
}
