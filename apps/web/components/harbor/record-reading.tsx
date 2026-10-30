"use client";

/**
 * record-reading.tsx — the home page's domain check: a DMARC record, read
 * aloud, tag by tag.
 *
 * The query line is a real lookup (`_dmarc.` + whatever you type), the answer
 * is set large in the data face, and every tag that matters is annotated
 * underneath with what it makes a receiving mail server do. Tags that are
 * ABSENT are annotated too, with the default the standard applies (RFC 9989),
 * because the most important finding on most domains is a tag that is not
 * there: no rua, nobody reads the reports.
 *
 * Drawn in the Routes language (record-reading.module.css): each row of tags
 * is a line and each tag a station on it, open when the record sets the tag
 * and closed when it does not.
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
 * rows, so the page never reflows on interaction (the clickthrough suite
 * measures it). Test ids are the ones that suite reads.
 */

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import s from "./record-reading.module.css";

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
 * (the RFC 9989 default). Order is the order an operator reads a record in.
 */
const TAGS: Array<{
  tag: string;
  label: string;
  present: (v: string) => [string, Tone];
  absent: [string, Tone] | ((tags: Record<string, string>) => [string, Tone]);
}> = [
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
    // RFC 9989 replaced pct with t. pct is retired: newer receivers ignore it
    // and apply p in full, so a pct below 100 is called out where t would be.
    tag: "t",
    label: "Testing",
    present: (v) =>
      v.toLowerCase() === "y"
        ? ["Testing: failing mail is treated one step softer than p.", "warn"]
        : v.toLowerCase() === "n"
          ? ["Not testing: p applies as written.", "plain"]
          : [`Unrecognised value: receivers apply p as written.`, "warn"],
    absent: (tags) => {
      const pct = tags.pct;
      if (pct !== undefined && pct !== "" && pct !== "100") {
        return [`pct=${pct} is retired (RFC 9989): newer receivers ignore it and apply p to all failing mail.`, "warn"];
      }
      return ["Not set: p applies as written.", "plain"];
    },
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
  const recordSize = recordLen > 90 ? "s" : recordLen > 55 ? "m" : "l";

  return (
    <section data-testid="domain-check" data-state={state} aria-labelledby="reading-head" className={s.check}>
      <h3 id="reading-head" className="sr-only">
        Read any domain&rsquo;s DMARC record
      </h3>

      {/* The query line: a real lookup, typed into the record name itself. */}
      <form onSubmit={run} className={s.form}>
        <label htmlFor="reading-domain" className={s.field} onClick={() => input.current?.focus()}>
          <span className={s.prefix} aria-hidden>
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
            placeholder="yourclient.example"
            data-testid="domain-check-input"
            className={s.input}
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
          className={s.submit}
        >
          Read the record
        </Button>
      </form>

      <div className={s.message} data-testid="domain-check-message" aria-live="polite">
        {paused ? (
          <p role="status" className={s.note} data-tone="warn">
            Too many lookups just now. Try again in a minute: the lookup is shared, which is why it stays free.
          </p>
        ) : error ? (
          <p role="alert" className={s.note} data-tone="fail">
            {error}
          </p>
        ) : (
          <p className={s.note}>
            {result ? (
              <>
                Read <span className={s.mono}>_dmarc.{result.domain}</span> from public DNS just now. No account, nothing
                stored about the domain.{" "}
                <button type="button" className={s.back} onClick={() => { setResult(null); setDomain(""); input.current?.focus(); }}>
                  Back to the example
                </button>
              </>
            ) : (
              <>
                Showing the record <span className={s.mono}>example.com</span> really publishes. Type any domain to read
                its own.
              </>
            )}
          </p>
        )}
      </div>

      <div className={s.readout} data-busy={busy ? "" : undefined} aria-busy={busy || undefined}>
        {/* The answer, set large. Fixed height: two lines at most. */}
        <div className={s.answer}>
          <span className={s.answerLabel}>{shown.example ? "Example" : "Answer"}</span>
          <p className={s.record} data-size={recordSize} data-missing={shown.record ? undefined : ""}>
            {shown.record ?? (shown.status === "missing" ? `no record at _dmarc.${shown.domain}` : "the lookup could not read the record")}
          </p>
        </div>

        {/* Tag by tag: what the record makes a receiver do. */}
        <ol className={s.tags} aria-label={`What ${shown.domain}'s record makes receivers do`}>
          {TAGS.map(({ tag, label, present, absent }) => {
            const value = shown.tags[tag];
            const has = value !== undefined && value !== "";
            const [meaning, tone] = !shown.record
              ? (["No record, so nothing applies.", "void"] as [string, Tone])
              : has
                ? present(value)
                : typeof absent === "function"
                  ? absent(shown.tags)
                  : absent;
            return (
              <li key={tag} className={s.tag} data-has={has ? "" : undefined}>
                <span className={s.tagStop} aria-hidden />
                <p className={s.tagHead}>
                  <span className={s.tagName}>{label}</span>
                  <span title={has ? `${tag}=${value}` : undefined} className={s.tagValue}>
                    {has ? `${tag}=${value}` : `${tag}= —`}
                  </span>
                </p>
                <p className={s.tagMeaning} data-tone={tone}>
                  {meaning}
                </p>
              </li>
            );
          })}
        </ol>

        {/* The other records the same lookup read, and the reading. */}
        <dl className={s.strips}>
          <Strip k="SPF" line={shown.spf} />
          <Strip k="DKIM" line={shown.dkim} />
          <Strip k="MX" line={shown.mx} mono />
        </dl>
        <div className={s.verdict}>
          <span className={s.verdictLabel}>Reading</span>
          <div className={s.verdictBody}>
            <p className={s.verdictText} data-tone={shown.verdict.tone}>
              {shown.verdict.text}
            </p>
            <p className={s.findings}>
              {shown.findings.length > 0
                ? shown.findings.map((f) => f.title).join(" · ")
                : shown.example
                  ? "The scanner's own findings appear here for a real domain."
                  : "The scanner raised no warnings."}
            </p>
          </div>
        </div>
      </div>

      <p data-testid="domain-check-boundary" className={s.boundary}>
        One lookup is one moment. Monitoring reads every report receivers send about the domain, every day, and keeps
        the evidence.
      </p>
    </section>
  );
}

function Strip({ k, line, mono }: { k: string; line: { text: string; tone: Tone }; mono?: boolean }): ReactNode {
  return (
    <div className={s.stripRow}>
      <dt className={s.stripKey}>{k}</dt>
      <dd className={s.stripVal} data-tone={line.tone} data-mono={mono ? "" : undefined}>
        {line.text}
      </dd>
    </div>
  );
}
