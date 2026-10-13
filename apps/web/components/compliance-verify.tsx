"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * compliance-verify.tsx — the reference form for the public verifier.
 *
 * A GET form would work, but navigating in-app keeps the reader on the
 * artefact typography and lets the result render without a page of chrome.
 * The reference is a document identifier, not a secret: it appears on the
 * pack's cover page.
 *
 * The form says what the reference IS and where to find it, rather than only
 * showing a placeholder. An auditor arriving from an email link has a PDF in hand
 * and no idea what this box wants: the first version asked them to paste
 * something "printed on the cover page" without saying what that thing looked
 * like, so a real reference and a typo were indistinguishable.
 */
export function ComplianceVerifyForm({
  initialReference,
}: {
  initialReference: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [reference, setReference] = useState(initialReference);

  const current = searchParams.get("reference") ?? "";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = reference.trim();
    router.push(trimmed ? `/verify?reference=${encodeURIComponent(trimmed)}` : "/verify");
  }

  return (
    <form onSubmit={submit} className="mt-8 flex flex-col gap-2">
      <label
        className="num text-[10.5px] tracking-[0.14em] uppercase"
        htmlFor="pack-reference"
        style={{ color: "var(--ink-3)" }}
      >
        Document reference
      </label>

      {/* What the thing is, what it looks like, and where to find it. A real
          reference is a dated hyphenated identifier; saying so turns "is this
          right?" into something the reader can answer without guessing. */}
      <div className="mt-1 text-[13px] leading-[1.7]" style={{ color: "var(--ink-2)" }}>
        <p>
          Every pack carries a reference shaped like{" "}
          <code
            className="num px-1 py-0.5 text-[12px]"
            style={{ background: "var(--elevate)", borderRadius: 2 }}
          >
            DMARC-20261013-ACME-FREIGHT-7C1A9F4B2D
          </code>
          . It is printed on the cover page and in the email that said the pack was
          ready: paste the whole thing, hyphens included.
        </p>
      </div>

      <div className="mt-1 flex gap-2">
        <input
          id="pack-reference"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="DMARC-20261013-ACME-FREIGHT-7C1A9F4B2D"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 border px-3 py-2.5 text-[14px] outline-none"
          style={{
            background: "var(--surface)",
            borderColor: "var(--line-strong)",
            color: "var(--ink)",
            borderRadius: 2,
          }}
        />
        <button
          type="submit"
          disabled={!reference.trim() || reference.trim() === current}
          className="px-5 py-2.5 text-[13.5px] font-semibold"
          style={{
            background: "var(--accent)",
            color: "var(--accent-ink)",
            borderRadius: 2,
            opacity: !reference.trim() || reference.trim() === current ? 0.5 : 1,
          }}
        >
          Verify
        </button>
      </div>
    </form>
  );
}
