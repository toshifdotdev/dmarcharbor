"use client";

/**
 * record-reading.tsx — the landing page's centrepiece: a DMARC record, read
 * aloud, tag by tag.
 *
 * Every other product puts a domain-check box in a card beside its headline.
 * This one makes the record itself the hero: the query line is a real lookup
 * (`_dmarc.` + whatever you type), the answer is set large in the data face,
 * and every tag that matters is annotated underneath with what it makes a
 * receiving mail server do. Tags that are ABSENT are annotated too, with the
 * default the standard applies (RFC 7489), because the most important finding
 * on most domains is a tag that is not there: no rua, nobody reads the reports.
 *
 * Truth rules:
 * - Everything shown after a lookup is what POST /api/scan returned: the record
 *   as published, its parsed tags, SPF/DKIM/MX states and the scanner's own
 *   findings. No score: one lookup has not earned a verdict number.
 * - At rest it shows example.com (RFC 2606 reserved), labelled as the example.
 *   example.com really publishes exactly this record (checked against DNS).
 * - A 429 is a pause, not a failure: the lookup is shared and rate limited.
 *
 * Layout is fixed-height: the example and any real result occupy the same
 * rows, so the hero never reflows on interaction (the clickthrough suite
 * measures it). Test ids are the ones that suite reads.
 */

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { clsx } from "clsx";
import { Button } from "@/components/ui/button";

type Lookup = "found" | "missing" | "error";
interface ScanIssue {
  severity: "info" | "warning" | "error";
  code: string;
  title: string;
}
interface ScanResult {
  domain: string;
  status: "healthy" | "needs_attention" | "missing" | "error";
  dmarc: {
    status: Lookup;
    record?: string;
    policy: "none" | "quarantine" | "reject" | "unknown";
    tags?: Record<string, string>;
  };
  spf: { status: Lookup; record?: string; valid?: boolean; lookupCount?: number };
  dkim: { status: Lookup; selectors?: string[]; checkedSelectors?: string[] };
  mx?: { status: Lookup; records?: Array<{ exchange: string; priority: number }> };
  issues: ScanIssue[];
}

type Tone = "ok" | "warn" | "fail" | "void" | "plain";

interface Reading {
  domain: string;
  example: boolean;
  status: Lookup;
  record: string | null;
  tags: Record<string, string>;
  spf: { state: Lookup; text: string; tone: Tone };
  dkim: { state: Lookup; text: string; tone: Tone };
  mx: { state: Lookup; text: string; tone: Tone };
  verdict: { text: string; tone: Tone };
  findings: ScanIssue[];
}

function parseTags(record: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (record ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** example.com, as it really publishes (IANA reserved; it sends no mail). */
const EXAMPLE: Reading = {
  domain: "example.com",
  example: true,
  status: "found",
  record: "v=DMARC1;p=reject;sp=reject;adkim=s;aspf=s",
  tags: parseTags("v=DMARC1;p=reject;sp=reject;adkim=s;aspf=s"),
  spf: { state: "found", text: "published · v=spf1 -all · sends from nowhere", tone: "ok" },
  dkim: { state: "missing", text: "missing · no selector answered", tone: "void" },
  mx: { state: "found", text: "null MX · accepts no mail", tone: "plain" },
  verdict: { text: "Enforcing, but blind: nobody receives this domain's reports.", tone: "warn" },
  findings: [],
};

function read(r: ScanResult): Reading {
  const tags = r.dmarc.tags && Object.keys(r.dmarc.tags).length ? lower(r.dmarc.tags) : parseTags(r.dmarc.record);
  const selectors = r.dkim.selectors ?? [];
  const mx = r.mx?.records ?? [];
  const word = (s: Lookup) => (s === "found" ? "published" : s === "missing" ? "missing" : "not measured");
  return {
    domain: r.domain,
    example: false,
    status: r.dmarc.status,
    record: r.dmarc.record ?? null,
    tags,
    spf:
      r.spf.status === "found"
        ? {
            state: "found",
            text: `${word("found")} · ${r.spf.valid ? "valid" : "invalid"}${typeof r.spf.lookupCount === "number" ? ` · ${r.spf.lookupCount} of 10 DNS lookups` : ""}`,
            tone: r.spf.valid ? "ok" : "fail",
          }
        : { state: r.spf.status, text: word(r.spf.status), tone: r.spf.status === "missing" ? "warn" : "void" },
    dkim:
      selectors.length > 0
        ? { state: "found", text: `${word("found")} · ${selectors.join(", ")}`, tone: "ok" }
        : {
            state: r.dkim.status === "error" ? "error" : "missing",
            text: `${word(r.dkim.status === "error" ? "error" : "missing")} · none answered of ${r.dkim.checkedSelectors?.length ?? "the"} common selectors`,
            tone: "void",
          },
    mx:
      mx.length > 0
        ? {
            state: "found",
            text: mx
              .slice()
              .sort((a, b) => a.priority - b.priority)
              .slice(0, 2)
              .map((m) => (m.exchange === "." || m.exchange === "" ? "null MX" : m.exchange))
              .join(", ") + (mx.length > 2 ? ` +${mx.length - 2}` : ""),
            tone: "plain",
          }
        : { state: r.mx?.status ?? "missing", text: word(r.mx?.status ?? "missing"), tone: "void" },
    verdict:
      r.status === "healthy"
        ? { text: "The published records hold up.", tone: "ok" }
        : r.status === "missing"
          ? { text: "No DMARC record: receivers apply no policy and send no reports.", tone: "fail" }
          : r.status === "error"
            ? { text: "The lookup could not read the records. Nothing was measured.", tone: "void" }
            : { text: r.issues[0] ? `Needs attention: ${r.issues[0].title}.` : "Needs attention.", tone: "warn" },
    findings: r.issues.filter((i) => i.severity !== "info").slice(0, 3),
  };
}

function lower(tags: Record<string, string>) {
  return Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]));
}

/**
 * What each tag makes a receiver do, and what it means when the tag is absent
 * (the RFC 7489 default). Order is the order an operator reads a record in.
 */
const TAGS: Array<{ tag: string; label: string; present: (v: string) => [string, Tone]; absent: [string, Tone] }> = [
  {
    tag: "p",
    label: "Policy",
    present: (v) =>
      v === "reject"
        ? ["Mail that fails is refused at the door.", "ok"]
        : v === "quarantine"
          ? ["Mail that fails goes to spam.", "ok"]
          : v === "none"
            ? ["Watch only: failing mail is delivered as usual.", "warn"]
            : [`Unrecognised value: receivers may ignore the record.`, "fail"],
    absent: ["Required. Without it the record is invalid.", "fail"],
  },
  {
    tag: "rua",
    label: "Reports",
    present: (v) => [`Receivers send aggregate reports to ${v.split(",").length} address${v.split(",").length === 1 ? "" : "es"}.`, "ok"],
    absent: ["Not set: nobody receives this domain's reports.", "warn"],
  },
  {
    tag: "sp",
    label: "Subdomains",
    present: (v) => [`Subdomains use p=${v}.`, "plain"],
    absent: ["Not set: subdomains inherit p.", "plain"],
  },
  {
    tag: "pct",
    label: "Coverage",
    present: (v) => [v === "100" ? "Applies to all failing mail." : `Applies to ${v}% of failing mail; the rest is treated one step softer.`, v === "100" ? "plain" : "warn"],
    absent: ["Not set: applies to 100% of failing mail.", "plain"],
  },
  {
    tag: "adkim",
    label: "DKIM align",
    present: (v) => [v === "s" ? "Strict: the signing domain must match exactly." : "Relaxed: a subdomain may sign.", "plain"],
    absent: ["Not set: relaxed, a subdomain may sign.", "plain"],
  },
  {
    tag: "aspf",
    label: "SPF align",
    present: (v) => [v === "s" ? "Strict: the envelope domain must match exactly." : "Relaxed: a subdomain may send.", "plain"],
    absent: ["Not set: relaxed, a subdomain may send.", "plain"],
  },
  {
    tag: "ruf",
    label: "Samples",
    present: () => ["Per-message failure samples are requested.", "plain"],
    absent: ["Not set: no failure samples. Many receivers send none anyway.", "plain"],
  },
  {
    tag: "fo",
    label: "Sample rule",
    present: (v) => [`Failure samples on: ${v === "1" ? "any check failing" : v === "0" ? "all checks failing" : v}.`, "plain"],
    absent: ["Not set: samples only when every check fails.", "plain"],
  },
];

const TONE: Record<Tone, string> = { ok: "text-ok", warn: "text-warn", fail: "text-fail", void: "text-void", plain: "text-fg" };

export function RecordReading() {
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Reading | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);

  async function run(e: FormEvent) {
    e.preventDefault();
    const wanted = domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^_dmarc\./, "")
      .replace(/[/?#].*$/, "")
      .replace(/^.*@/, "");
    if (!wanted) return;
    setDomain(wanted);
    setBusy(true);
    setError(null);
    setPaused(false);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: wanted }),
      });
      if (res.status === 429) {
        setPaused(true);
        return;
      }
      const body = (await res.json().catch(() => null)) as ScanResult | { error?: { message?: string } } | null;
      if (!res.ok || !body || !("dmarc" in body)) {
        setError((body && "error" in body ? body.error?.message : null) ?? "That lookup could not run. Check the domain and try again.");
        return;
      }
      setResult(read(body));
    } catch {
      setError("That lookup could not run. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const shown = result ?? EXAMPLE;
  const state = result ? "result" : error ? "error" : paused ? "paused" : busy ? "busy" : "idle";
  const recordLen = shown.record?.length ?? 0;

  return (
    <section data-testid="domain-check" data-state={state} aria-labelledby="reading-head" className="flex flex-col">
      <h2 id="reading-head" className="sr-only">
        Read any domain&rsquo;s DMARC record
      </h2>

      {/* The query line: a real lookup, typed into the record name itself. */}
      <form onSubmit={run} className="flex flex-wrap items-stretch gap-x-3 gap-y-2">
        <label
          htmlFor="reading-domain"
          className="group flex min-w-0 flex-1 basis-full cursor-text items-center sm:basis-auto rounded-ctl border border-rule-2 bg-paper-2 pl-3 focus-within:border-act focus-within:ring-2 focus-within:ring-act-line"
          onClick={() => input.current?.focus()}
        >
          <span className="data shrink-0 text-body text-fg-3 sm:text-lead" aria-hidden>
            TXT&nbsp;_dmarc.
          </span>
          <span className="sr-only">Domain to read</span>
          <input
            ref={input}
            id="reading-domain"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="yourclient.com"
            data-testid="domain-check-input"
            className="data h-12 min-w-0 flex-1 bg-transparent pr-3 text-body text-fg outline-none placeholder:text-fg-4 sm:text-lead"
          />
        </label>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          busy={busy}
          busyLabel="Reading DNS"
          disabled={!domain.trim()}
          data-testid="domain-check-submit"
          className="h-12 w-full px-6 sm:w-auto"
        >
          Read the record
        </Button>
      </form>

      <div className="h-6 pt-1.5" data-testid="domain-check-message" aria-live="polite">
        {paused ? (
          <p role="status" className="text-meta font-semibold text-warn">
            Too many lookups just now. Try again in a minute: the lookup is shared, which is why it stays free.
          </p>
        ) : error ? (
          <p role="alert" className="text-meta font-semibold text-fail">
            {error}
          </p>
        ) : (
          <p className="text-meta text-fg-3">
            {result ? (
              <>
                Read from public DNS just now. No account, nothing stored about the domain.{" "}
                <button type="button" className="link" onClick={() => { setResult(null); setDomain(""); input.current?.focus(); }}>
                  Back to the example
                </button>
              </>
            ) : (
              <>
                Showing the record <span className="data text-fg-2">example.com</span> really publishes. Type any domain
                to read its own.
              </>
            )}
          </p>
        )}
      </div>

      <div className={clsx("transition-opacity duration-150", busy && "opacity-35")} aria-busy={busy || undefined}>
        {/* The answer, set large. Fixed height: two lines at most. */}
        <div className="mt-4 flex h-[92px] items-start gap-4 border-t border-fg pt-4 sm:h-[104px]">
          <span className="legend w-[64px] shrink-0 pt-1.5">{shown.example ? "Example" : "Answer"}</span>
          <p
            className={clsx(
              "data line-clamp-2 min-w-0 flex-1 break-all font-semibold tracking-[-0.02em]",
              shown.record ? "text-fg" : "text-fail",
              recordLen > 90 ? "text-lead sm:text-h3" : recordLen > 55 ? "text-h3 sm:text-h2" : "text-h2 sm:text-[30px] sm:leading-[38px]",
            )}
          >
            {shown.record ?? (shown.status === "missing" ? `no record at _dmarc.${shown.domain}` : "the lookup could not read the record")}
          </p>
        </div>

        {/* Tag by tag: what the record makes a receiver do. */}
        <ol className="grid grid-cols-2 border-t border-rule sm:grid-cols-4" aria-label={`What ${shown.domain}'s record makes receivers do`}>
          {TAGS.map(({ tag, label, present, absent }) => {
            const value = shown.tags[tag];
            const has = value !== undefined && value !== "";
            const [meaning, tone] = !shown.record ? (["No record, so nothing applies.", "void"] as [string, Tone]) : has ? present(value) : absent;
            return (
              <li key={tag} className="h-[104px] border-b border-r border-rule px-3 py-2.5 even:border-r-0 sm:even:border-r sm:[&:nth-child(4n)]:border-r-0">
                <p className="flex items-baseline justify-between gap-2">
                  <span className="legend shrink-0">{label}</span>
                  <span title={has ? `${tag}=${value}` : undefined} className={clsx("data min-w-0 truncate text-meta font-semibold", has ? "text-fg" : "text-fg-4")}>
                    {has ? `${tag}=${value}` : `${tag}= —`}
                  </span>
                </p>
                <p className={clsx("mt-1.5 line-clamp-3 text-ui", TONE[tone], tone === "plain" && "text-fg-2")}>{meaning}</p>
              </li>
            );
          })}
        </ol>

        {/* The other records the same lookup read, and the reading. */}
        <dl className="grid border-b border-rule sm:grid-cols-3">
          <Strip k="SPF" line={shown.spf} />
          <Strip k="DKIM" line={shown.dkim} />
          <Strip k="MX" line={shown.mx} mono />
        </dl>
        <div className="flex h-[88px] items-start gap-4 border-b border-fg py-3 sm:h-[64px]">
          <span className="legend w-[64px] shrink-0 pt-0.5">Reading</span>
          <div className="min-w-0 flex-1">
            <p className={clsx("line-clamp-2 text-body font-bold sm:truncate", TONE[shown.verdict.tone])}>{shown.verdict.text}</p>
            <p className="truncate text-meta text-fg-3">
              {shown.findings.length > 0
                ? shown.findings.map((f) => f.title).join(" · ")
                : shown.example
                  ? "The scanner's own findings appear here for a real domain."
                  : "The scanner raised no warnings."}
            </p>
          </div>
        </div>
      </div>

      <p data-testid="domain-check-boundary" className="pt-2.5 text-meta text-fg-3">
        One lookup is one moment. Monitoring reads every report receivers send about the domain, every day, and keeps
        the evidence.
      </p>
    </section>
  );
}

function Strip({ k, line, mono }: { k: string; line: { text: string; tone: Tone }; mono?: boolean }): ReactNode {
  return (
    <div className="flex h-[40px] items-baseline gap-3 border-rule px-0 py-2.5 sm:border-r sm:px-3 sm:first:pl-0 sm:last:border-r-0">
      <dt className="legend w-[40px] shrink-0">{k}</dt>
      <dd className={clsx("min-w-0 truncate text-ui", TONE[line.tone], line.tone === "plain" && "text-fg-2", mono && "data text-meta")}>
        {line.text}
      </dd>
    </div>
  );
}
