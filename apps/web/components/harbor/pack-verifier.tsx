"use client";

/**
 * pack-verifier.tsx — the two inputs of the public document check.
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
 *   Digest         a SHA-256 set in groups of eight, so the auditor can compare
 *                  the published digest with the one their own tool printed.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useId, useRef, useState, type DragEvent, type FormEvent } from "react";
import { clsx } from "clsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { PostureMark } from "@/components/ui/badge";
import { TideMark } from "@/components/ui/tide";
import s from "./verify.module.css";

/** A digest in groups of eight. The groups are spaced by margin, so the text
 *  a reader copies or searches for is the digest exactly. */
export function Digest({ value, className }: { value: string; className?: string }) {
  const groups = value.match(/.{1,8}/g) ?? [value];
  return (
    <span className={clsx("data", s.digest, className)}>
      {groups.map((g, i) => (
        <span key={i}>{g}</span>
      ))}
    </span>
  );
}

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
    <form onSubmit={submit} className="flex flex-col gap-2.5">
      <label htmlFor="pack-reference" className="text-[15px] font-semibold text-fg">
        Document reference
      </label>
      <div className="flex flex-col gap-2.5 sm:flex-row">
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
      <p className="max-w-[64ch] text-[14px] leading-[1.5] text-fg-4">
        Printed on the document&rsquo;s cover page and in the email that said it was ready. Paste all of it, hyphens included.
        {example ? (
          <>
            {" "}
            It looks like <code className="data break-all text-fg-2">{example}</code> (an example that matches no document).
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
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={clsx(
          "flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-sheet border px-5 py-5 transition-colors duration-150",
          over ? "border-fg bg-paper-3" : "border-rule-2 bg-paper",
        )}
      >
        <div className="min-w-0">
          <p className="text-[16px] font-bold text-fg">Check the PDF you hold</p>
          <p className="mt-1 text-[14px] leading-[1.5] text-fg-4">
            Drop it here or choose it. It is hashed in this browser and never uploaded.
          </p>
        </div>
        <input
          ref={input}
          id={`${id}-file`}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          onChange={(e) => void check(e.target.files?.[0])}
        />
        <Button onClick={() => input.current?.click()} busy={outcome.kind === "hashing"} busyLabel="Hashing">
          Choose the PDF
        </Button>
      </div>

      <div aria-live="polite">
        {outcome.kind === "hashing" ? (
          <div className="flex items-center gap-4">
            <TideMark size={22} />
            <p className="text-[14px] text-fg-4">Computing SHA-256 of {outcome.name}</p>
          </div>
        ) : null}
        {outcome.kind === "error" ? (
          <p role="alert" className="text-[15px] font-semibold text-fail">
            {outcome.message}
          </p>
        ) : null}
        {outcome.kind === "done" ? (
          <div
            key={outcome.digest}
            data-file-check={outcome.match ? (outcome.match.superseded ? "superseded" : "match") : "mismatch"}
            className={clsx(
              "flex flex-col gap-3 rounded-sheet border px-5 py-4",
              outcome.match ? "border-ok/35 bg-ok-wash" : "border-fail/35 bg-fail-wash",
            )}
          >
            <p className="flex items-start gap-3 text-[15px] leading-[1.5]">
              <span aria-hidden className="mt-[6px] shrink-0">
                <PostureMark posture={outcome.match ? "pass" : "block"} size={11} />
              </span>
              <span className="text-fg-2">
                {outcome.match ? (
                  <>
                    <span className="font-bold text-ok">Match.</span> {outcome.name} is byte for byte the{" "}
                    {outcome.match.superseded ? "superseded" : "current"} document issued under this reference (
                    {outcome.match.documentVersion}).
                    {outcome.match.superseded ? " A newer document exists; ask the sender for it if you need the latest." : ""}
                  </>
                ) : (
                  <>
                    <span className="font-bold text-fail">No match.</span> {outcome.name} differs from every document
                    issued under this reference. It may be a different document, or it was changed after it was issued.
                  </>
                )}
              </span>
            </p>
            <div className="pl-[26px]">
              <p className="text-[13px] font-semibold text-fg-3">SHA-256 of your file</p>
              <Digest value={outcome.digest} className="mt-1 text-[14px] text-fg" />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
