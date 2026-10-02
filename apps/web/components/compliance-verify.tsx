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
      <div className="flex gap-2">
        <input
          id="pack-reference"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="printed on the pack's cover page"
          spellCheck={false}
          autoComplete="off"
          className="flex-1 border px-3 py-2.5 text-[14px] outline-none"
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
