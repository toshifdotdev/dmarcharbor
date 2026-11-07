"use client";

/**
 * dkim-tool.tsx — /tools/dkim: a DKIM selector's public key.
 *
 * DKIM keys live at <selector>._domainkey.<domain> and nothing in DNS lists
 * the selectors, so the tool asks for one (the s= tag of a message's
 * DKIM-Signature header) and probes it first. Without one, the scanner tries
 * the selectors the domain's SPF includes point to and the common names, and
 * says exactly which it tried: "none of these answered" is a different claim
 * from "this domain has no DKIM".
 *
 * Each key found is a station: green when it is a working key, closed with a
 * note when it is revoked (an empty p=, RFC 6376 section 3.6.1). The size is
 * estimated from the published key's length, and called out below 2048 bits.
 *
 * Test hooks: tool-dkim-input, tool-dkim-submit, tool-dkim-selector,
 * tool-dkim (data-state), tool-dkim-answer (data-answer), tool-dkim-keys.
 */

import { useState } from "react";
import { clsx } from "clsx";
import { CopyButton } from "@/components/ui/copy";
import { Input } from "@/components/ui/field";
import { StateWord } from "../ops-parts";
import { Findings, StationList, issuesFor, type StationItem } from "./figures";
import { FigureHead, LookupLine, LookupStatus } from "./lookup-line";
import { SELECTOR, lookupDomain, useScan, type ToolScan } from "./scan";

function tagsOf(record: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of record.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).replace(/\s+/g, "").trim();
  }
  return out;
}

/** The key type and an estimate of its size, from the published key's length. */
export function keyFacts(record: string): { type: string; bits: number | null; weak: boolean; testing: boolean } {
  const tags = tagsOf(record);
  const type = (tags.k ?? "rsa").toLowerCase();
  const testing = (tags.t ?? "").split(":").includes("y");
  if (type === "ed25519") return { type: "Ed25519", bits: null, weak: false, testing };
  const p = tags.p ?? "";
  const bytes = Math.floor((p.replace(/=+$/, "").length * 3) / 4);
  // An RSA key published as SubjectPublicKeyInfo or as a bare RSAPublicKey:
  // 1024-bit is 140 to 162 bytes, 2048-bit 270 to 294, 3072-bit 398 to 422,
  // 4096-bit 526 to 550.
  const bits = bytes === 0 ? null : bytes <= 110 ? 512 : bytes <= 170 ? 1024 : bytes <= 310 ? 2048 : bytes <= 430 ? 3072 : 4096;
  return { type: "RSA", bits, weak: bits !== null && bits < 2048, testing };
}

function via(source: string | undefined): string {
  if (!source) return "";
  if (source === "requested") return "the selector you entered";
  if (source === "convention") return "a common selector name";
  if (source === "previously found") return "found by an earlier check";
  if (source.startsWith("spf:")) return `named by the SPF include ${source.slice(4)}`;
  return source;
}

/** A sample: a domain on Google Workspace, signing with the selector "google". A real 2048-bit key made for this page; no domain publishes it. */
const SAMPLE_KEY =
  "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAn86Bu9YMekHTznh3nqmo/wppTBrz73d10YOMNf4Si7BZSKla8VBz9RM7TYzcXhlbakE0s9VeZSmEh/m5e1anMz9ks3VmaAvdu8JqrMmDnGfnlMjQuAUSpNJ9L8mqaD9KLvR/YzSPSnm1YXvcPaY73gRLCQqJLTTzbgzzrXqAg9jNqVf6RPKPSFXA1W9tjKfj/nD3dDTFjg6Si1UuKA8tAcEyl+F+I9ei6TF4hcwQ8VNBlcowkVLr0lnlzK6UDN4lhWxFsOU6ceoINBVXHl18DdPYRhaV+R5Eci3X4ZrwfTQEkyNoToCi3X1iMCtijY1TrVG2mODSF1mJ6H+qRDj34wIDAQAB";

export function DkimTool() {
  const [domain, setDomain] = useState("");
  const [selector, setSelector] = useState("");
  const { state, run, reset } = useScan();
  const busy = state.phase === "busy";
  const wanted = selector.trim().toLowerCase();
  const selectorOk = wanted === "" || SELECTOR.test(wanted);

  function submit() {
    const name = lookupDomain(domain);
    if (!name || !selectorOk) return;
    setDomain(name);
    void run(name, wanted || null);
  }

  const done = state.phase === "done" ? state : null;
  const scan: ToolScan | null = done?.result ?? null;
  const asked = done?.selector ?? null;
  const domainShown = scan?.domain ?? "pellowyn-dental.example";
  const records = scan ? scan.dkim.records : { google: SAMPLE_KEY };
  const revoked = scan?.dkim.revokedSelectors ?? [];
  const checked = scan?.dkim.checkedSelectors ?? ["google"];
  const silent = checked.filter((s) => !(s in records) && !revoked.includes(s));
  const answer: "key" | "revoked" | "silent" | null = asked ? (asked in records ? "key" : revoked.includes(asked) ? "revoked" : "silent") : null;

  const items: StationItem[] = [
    ...Object.entries(records).map(([name, record]): StationItem => {
      const facts = keyFacts(record);
      return {
        key: name,
        state: "passed",
        name: <span className="data">{name}</span>,
        meta: scan ? via(scan.dkim.discoveredVia?.[name]) : "sample",
        children: (
          <div className="flex flex-col gap-2">
            <p>
              <span className="font-semibold text-ok">Working key</span>
              <span className="text-fg-2">
                {" "}
                · {facts.type}
                {facts.bits ? `, about ${facts.bits}-bit` : ""}
                {facts.testing ? " · testing mode (t=y): receivers may treat failures as unsigned" : ""}
              </span>
            </p>
            {facts.weak ? (
              <p className="font-semibold text-warn">
                Under 2048 bits. Rotate to a 2048-bit key: shorter keys can be broken and some receivers ignore them.
              </p>
            ) : null}
            <div className="flex items-start gap-2 rounded-[10px] bg-paper-3 py-2 pl-3 pr-1.5">
              <code className="data line-clamp-3 min-w-0 flex-1 break-all text-[13px] leading-[1.5] text-fg">{record}</code>
              <CopyButton value={record} label={`Copy the ${name} key record`} />
            </div>
          </div>
        ),
      };
    }),
    ...revoked.map(
      (name): StationItem => ({
        key: name,
        state: "closed",
        name: <span className="data">{name}</span>,
        meta: scan ? via(scan.dkim.discoveredVia?.[name]) : undefined,
        children: (
          <span>
            <span className="font-semibold text-fg">Revoked</span>: the record publishes an empty p=, so signatures made with
            this selector fail on purpose. Normal after a key rotation.
          </span>
        ),
      }),
    ),
  ];

  return (
    <section data-testid="tool-dkim" data-state={state.phase} aria-label="DKIM record lookup">
      <div className="mb-4 flex flex-wrap items-end gap-x-6 gap-y-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[14px] font-semibold text-fg">
            Selector <span className="font-normal text-fg-4">optional</span>
          </span>
          <Input
            mono
            size="lg"
            value={selector}
            onChange={(e) => setSelector(e.target.value)}
            placeholder="selector1"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="none"
            aria-invalid={!selectorOk || undefined}
            data-testid="tool-dkim-selector"
            className="w-[240px] max-w-full"
          />
        </label>
        <p className={clsx("max-w-[34rem] pb-2.5 text-[14px] leading-[1.45]", selectorOk ? "text-fg-4" : "font-semibold text-fail")}>
          {selectorOk
            ? "The s= value in a message's DKIM-Signature header. Leave it empty and the scanner tries the selectors the domain's services use."
            : "A selector is one DNS label: letters, digits and hyphens, such as selector1 or google."}
        </p>
      </div>
      <LookupLine
        id="tool-dkim"
        prefix={
          <>
            <span className="max-sm:hidden">TXT&nbsp;{wanted && selectorOk ? wanted : "…"}._domainkey.</span>
            <span className="sm:hidden">…_domainkey.</span>
          </>
        }
        value={domain}
        onChange={setDomain}
        onSubmit={submit}
        busy={busy}
        disabled={!selectorOk}
        submitLabel={wanted ? "Look up the key" : "Find the keys"}
        busyLabel="Reading DNS"
      />
      <LookupStatus
        state={state}
        idle="Showing a sample key. Type a domain, and a selector if you have one, to read its own."
        read={
          <>
            Read from public DNS just now. Nothing is stored about the domain.{" "}
            <button
              type="button"
              className="font-semibold text-fg underline decoration-rule-2 underline-offset-[3px] hover:decoration-fg"
              onClick={() => {
                reset();
                setDomain("");
                setSelector("");
              }}
            >
              Back to the sample
            </button>
          </>
        }
      />

      <div
        aria-busy={busy || undefined}
        className={clsx(
          "mt-6 grid gap-x-16 gap-y-14 transition-opacity duration-150 min-[68.75rem]:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]",
          busy && "opacity-35",
        )}
      >
        <div className="flex min-w-0 flex-col gap-12">
          {answer && asked ? (
            <div data-testid="tool-dkim-answer" data-answer={answer}>
              <FigureHead name="Your selector" meta={<span className="data break-all">{asked}._domainkey.{domainShown}</span>} className="mb-4" />
              {answer === "key" ? (
                <StateWord shape="square" tone="ok" className="text-[16px]! whitespace-normal">
                  It answers with a working key
                </StateWord>
              ) : answer === "revoked" ? (
                <StateWord shape="half" tone="void" className="text-[16px]! whitespace-normal">
                  It publishes a revoked key
                </StateWord>
              ) : (
                <div className="flex flex-col gap-2">
                  <StateWord shape="ring" tone="void" className="text-[16px]! whitespace-normal">
                    No key at this selector
                  </StateWord>
                  <p className="max-w-[60ch] text-[14.5px] leading-[1.5] text-fg-2">
                    Check the spelling against the s= tag of a recent message&rsquo;s DKIM-Signature header, and the d= tag:
                    the key lives under that domain, which may not be the one in the From address.
                  </p>
                </div>
              )}
            </div>
          ) : null}

          <div data-testid="tool-dkim-keys">
            <FigureHead
              name={scan ? "Keys found" : "Sample key"}
              meta={scan ? <span className="data">{domainShown}</span> : "sample data: google._domainkey.pellowyn-dental.example"}
              className="mb-6"
            />
            {items.length > 0 ? (
              <StationList label="DKIM selectors that answered" items={items} />
            ) : (
              <div className="flex flex-col gap-2">
                <StateWord shape="ring" tone="void" className="text-[15px]! whitespace-normal">
                  {scan?.dkim.status === "error" ? "The lookups failed: nothing was measured" : "None of the selectors tried answered"}
                </StateWord>
                <p className="max-w-[60ch] text-[14.5px] leading-[1.5] text-fg-2">
                  That is not proof the domain has no DKIM: selectors cannot be listed, only guessed. Enter the selector from
                  a message&rsquo;s DKIM-Signature header to check it directly.
                </p>
              </div>
            )}
          </div>

          {scan ? (
            <div>
              <FigureHead name="Findings" meta="from the scanner" className="mb-4" />
              <Findings issues={issuesFor("dkim_", scan.issues)} none="The scanner raised nothing about DKIM." />
            </div>
          ) : null}
        </div>

        <div className="min-w-0">
          <FigureHead name="Selectors tried" meta={`${checked.length} name${checked.length === 1 ? "" : "s"} looked up`} className="mb-4" />
          {silent.length > 0 ? (
            <>
              <p className="pb-2 text-[14.5px] text-fg-2">These answered with nothing:</p>
              <p className="data text-[13.5px] leading-[1.7] text-fg-4">{silent.join(", ")}</p>
            </>
          ) : (
            <p className="text-[14.5px] text-fg-2">Every selector tried answered.</p>
          )}
          {scan?.dkim.skippedSelectors?.length ? (
            <p className="mt-4 text-[14px] leading-[1.5] text-fg-4">
              Not tried, to keep one lookup within its budget: <span className="data">{scan.dkim.skippedSelectors.join(", ")}</span>
            </p>
          ) : null}
          <p className="mt-6 max-w-[40ch] text-[14px] leading-[1.5] text-fg-4">
            DNS cannot list a domain&rsquo;s selectors. Monitoring finds them from the DMARC reports receivers send, which
            name the selector each message was signed with.
          </p>
        </div>
      </div>
    </section>
  );
}
