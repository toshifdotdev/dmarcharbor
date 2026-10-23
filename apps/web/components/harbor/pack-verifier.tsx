"use client";

/**
 * pack-verifier.tsx — the two inputs of the public compliance pack check.
 *
 *   ReferenceForm  the document reference printed on the pack's cover. It
 *                  navigates (?reference=…), so a result is a URL an auditor
 *                  can keep or send on.
 *   FileCheck      the PDF they hold, hashed IN THIS BROWSER with
 *                  crypto.subtle (SHA-256) and compared against the digests
 *                  published for that reference. The file never leaves the
 *                  machine: nothing is uploaded, and the page says so. The
 *                  same test by hand is `sha256sum file.pdf`, and that stays
 *                  on the page too, because a verifier that only works in our
 *                  own UI is a weaker claim.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useId, useRef, useState, type DragEvent, type FormEvent } from "react";
import { clsx } from "clsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";

export function ReferenceForm({ initialReference, example }: { initialReference: string; example: string | null }) {
  const router = useRouter();
  const params = useSearchParams();
  const [reference, setReference] = useState(initialReference);
  const current = params.get("reference") ?? "";
  const trimmed = reference.trim();

  function submit(e: FormEvent) {
    e.preventDefault();
    router.push(trimmed ? `/verify?reference=${encodeURIComponent(trimmed)}` : "/verify");
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <label htmlFor="pack-reference" className="text-meta font-semibold text-fg-2">
        Document reference
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="pack-reference"
          size="lg"
          mono
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder={example ?? "DMARC-…"}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="characters"
          className="min-w-0 sm:flex-1"
        />
        <Button type="submit" variant="primary" size="lg" disabled={!trimmed || trimmed === current}>
          Look up
        </Button>
      </div>
      <p className="text-meta text-fg-3">
        Printed on the cover page and in the email that said the pack was ready. Paste all of it, hyphens included.
        {example ? (
          <>
            {" "}
            It looks like <code className="data break-all text-fg-2">{example}</code> (an example that matches no pack).
          </>
        ) : null}
      </p>
    </form>
  );
}

interface Published {
  sha256: string;
  documentVersion: string;
  superseded: boolean;
}

type Outcome =
  | { kind: "idle" }
  | { kind: "hashing"; name: string }
  | { kind: "done"; name: string; size: number; digest: string; match: Published | null }
  | { kind: "error"; message: string };

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function FileCheck({ published }: { published: Published[] }) {
  const id = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });

  async function check(file: File | undefined) {
    if (!file) return;
    if (!globalThis.crypto?.subtle) {
      setOutcome({ kind: "error", message: "This browser cannot compute SHA-256 here. Use sha256sum on the file instead." });
      return;
    }
    setOutcome({ kind: "hashing", name: file.name });
    try {
      const digest = hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
      const match = published.find((p) => p.sha256.toLowerCase() === digest) ?? null;
      setOutcome({ kind: "done", name: file.name, size: file.size, digest, match });
    } catch {
      setOutcome({ kind: "error", message: "The file could not be read. Try choosing it again." });
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    void check(e.dataTransfer.files[0]);
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={clsx(
          "flex flex-col items-start gap-2 rounded-ctl border px-4 py-4 transition-colors duration-100",
          over ? "border-act bg-act/5" : "border-rule-2 bg-paper-2",
        )}
      >
        <p className="text-ui font-semibold text-fg">Check the PDF you hold</p>
        <p className="text-meta text-fg-3">
          Drop it here or choose it. It is hashed in this browser and never uploaded.
        </p>
        <input
          ref={input}
          id={`${id}-file`}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          onChange={(e) => void check(e.target.files?.[0])}
        />
        <Button size="sm" onClick={() => input.current?.click()} busy={outcome.kind === "hashing"} busyLabel="Hashing">
          Choose the PDF
        </Button>
      </div>

      <div aria-live="polite">
        {outcome.kind === "hashing" ? (
          <div className="flex flex-col gap-2">
            <p className="text-meta text-fg-3">Computing SHA-256 of {outcome.name}…</p>
            <div className="hb-scan w-full" aria-hidden />
          </div>
        ) : null}
        {outcome.kind === "error" ? (
          <p role="alert" className="text-ui font-semibold text-fail">
            {outcome.message}
          </p>
        ) : null}
        {outcome.kind === "done" ? (
          <div
            key={outcome.digest}
            data-file-check={outcome.match ? (outcome.match.superseded ? "superseded" : "match") : "mismatch"}
            className={clsx(
              "flex flex-col gap-2 rounded-ctl border px-4 py-3 [animation:hb-rise_220ms_ease-out]",
              outcome.match ? "border-ok/35 bg-ok-wash/70" : "border-fail/35 bg-fail-wash/70",
            )}
          >
            <p className="flex items-start gap-2.5 text-ui">
              <span aria-hidden className="mt-[3px] grid size-3.5 shrink-0 place-items-center">
                {outcome.match ? (
                  <svg viewBox="0 0 16 16" className="hb-draw-check size-3.5 text-ok">
                    <path d="M2.5 8.5 6.5 12.5 13.5 3.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
                  </svg>
                ) : (
                  <span className="block size-2 rotate-45 bg-fail" />
                )}
              </span>
              <span className="text-fg-2">
                {outcome.match ? (
                  <>
                    <span className="font-bold text-ok">Match.</span> {outcome.name} is byte for byte the{" "}
                    {outcome.match.superseded ? "superseded" : "current"} pack issued under this reference (
                    {outcome.match.documentVersion}).
                    {outcome.match.superseded ? " A newer pack exists; ask the sender for it if you need the latest." : ""}
                  </>
                ) : (
                  <>
                    <span className="font-bold text-fail">No match.</span> {outcome.name} differs from every pack issued
                    under this reference. It may be a different pack, or it was changed after it was issued.
                  </>
                )}
              </span>
            </p>
            <p className="data break-all text-meta text-fg-2">
              <span className="text-fg-3">sha256 of your file </span>
              {outcome.digest}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
