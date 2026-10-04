"use client";

/**
 * domain-check.tsx — the homepage's anonymous domain check.
 *
 * POST /api/scan is public and rate limited, so there is nothing to gate: the
 * result is never hidden behind a sign-up (that was considered and rejected:
 * a free check that demands an account is not free).
 *
 * The hero box is a FIXED RECTANGLE that demonstrates the product before it
 * asks for anything. At rest it shows a worked example on example.com (RFC
 * 2606 reserved) in the same shape as "One lookup, end to end": query,
 * response, parsed, verdict. When a real domain is checked, that example is
 * REPLACED by the domain's own result in the same shape: its raw record as
 * published, its three record states, and a one-line verdict. Idle and loaded
 * occupy the same pixels, so the hero never reflows on interaction. The
 * explanations of what the rows mean live in the section below, not inside the
 * output at the moment it appears.
 *
 * The 429 is not an error: the endpoint is rate limited on purpose. It reads
 * as "too many lookups, try again shortly", never as a failure.
 *
 * Anything the API did not report is shown as unknown, never as a pass.
 */

import { useState } from "react";

interface ScanIssue {
  severity: "info" | "warning" | "error";
  code: string;
  title: string;
  message: string;
  recommendation?: string;
}

interface ScanResult {
  domain: string;
  scannedAt: string;
  status: "healthy" | "needs_attention" | "missing" | "error";
  score: number;
  dmarc: {
    status: "found" | "missing" | "error";
    record?: string;
    policy: "none" | "quarantine" | "reject" | "unknown";
  };
  spf: { status: "found" | "missing" | "error"; valid?: boolean };
  dkim: { status: "found" | "missing" | "error" };
  issues: ScanIssue[];
  recommendations: string[];
}

type RecordState = "published" | "missing" | "not measured";

/** The four rows the box always shows, in the shape the product's own lookup
 *  section uses. Both states are this shape: the worked example and a real
 *  result differ in their contents, never in their structure. */
interface BoxShape {
  query: string;
  response: string;
  records: Array<[string, RecordState]>;
  verdict: string;
  verdictColor: string;
}

function stateWord(status: "found" | "missing" | "error"): RecordState {
  return status === "found" ? "published" : status === "missing" ? "missing" : "not measured";
}

/** The worked example: the real shape of a lookup of example.com, shown before
 *  anyone types. A stranger sees the product already working rather than a
 *  description of it, and example.com can never resolve to a real company. */
const WORKED_EXAMPLE: BoxShape = {
  query: "dig TXT _dmarc.example.com",
  response: "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s",
  records: [
    ["DMARC", "published"],
    ["SPF", "published"],
    ["DKIM", "missing"],
  ],
  verdict: "needs attention: aggregate reporting is not configured.",
  verdictColor: "var(--color-unverified)",
};

/** One line, derived from the API's own data: the status word plus the first
 *  thing worth doing about it. Never a score, never an invented severity. */
function verdictFor(result: ScanResult): { line: string; color: string } {
  if (result.status === "healthy") {
    return { line: "looks good: the published records hold up.", color: "var(--color-pass)" };
  }
  if (result.status === "missing") {
    return {
      line: "no DMARC record is published: receivers decide on their own.",
      color: "var(--color-block)",
    };
  }
  if (result.status === "error") {
    return { line: "the lookup could not read the records.", color: "var(--color-block)" };
  }
  const first = result.issues[0]?.title;
  const tail = first ? `: ${first.charAt(0).toLowerCase()}${first.slice(1)}.` : ".";
  return { line: `needs attention${tail}`, color: "var(--color-unverified)" };
}

function shapeFor(result: ScanResult): BoxShape {
  const verdict = verdictFor(result);
  return {
    query: `dig TXT _dmarc.${result.domain}`,
    response:
      result.dmarc.record ??
      (result.dmarc.status === "missing"
        ? "no record published"
        : "the lookup could not read the record."),
    records: [
      ["DMARC", stateWord(result.dmarc.status)],
      ["SPF", stateWord(result.spf.status)],
      ["DKIM", stateWord(result.dkim.status)],
    ],
    verdict: verdict.line,
    verdictColor: verdict.color,
  };
}

const STATE_COLOR: Record<RecordState, string> = {
  published: "var(--color-pass)",
  missing: "var(--color-unverified)",
  "not measured": "var(--color-unmeasured)",
};

/** One labelled row of the box. Row heights are fixed so idle and loaded
 *  occupy the same rectangle whatever the contents say. */
function Row({
  label,
  height,
  children,
}: {
  label: string;
  height: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-x-3 border-b" style={{ borderColor: "var(--color-line)", minHeight: height }}>
      <span className="num w-[68px] shrink-0 pt-[3px] text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--color-ink-3)" }}>
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function DomainCheck() {
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    const wanted = domain.trim().toLowerCase();
    if (!wanted) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setRateLimited(false);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: wanted }),
      });
      if (res.status === 429) {
        // The endpoint is rate limited on purpose: this is a pause, not a
        // failure, and must never read as one.
        setRateLimited(true);
        return;
      }
      const body = (await res.json().catch(() => null)) as
        | ScanResult
        | { error?: { message?: string } }
        | null;
      if (!res.ok) {
        setError(
          (body && "error" in body ? body.error?.message : null) ??
            "That lookup could not run. Check the domain and try again.",
        );
        return;
      }
      setResult(body as ScanResult);
    } catch {
      setError("That lookup could not run. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  // The rectangle shows the worked example until a real lookup replaces it. A
  // failed or rate-limited lookup leaves the example in place and says what
  // happened in the message slot: nothing was measured, so nothing is shown as
  // if it had been.
  const shape = result ? shapeFor(result) : WORKED_EXAMPLE;
  const state = result ? "result" : error ? "error" : rateLimited ? "paused" : busy ? "busy" : "idle";

  return (
    <section className="w-full" data-testid="domain-check" data-state={state}>
      <div
        className="rounded-[2px] border px-6 py-5"
        style={{ borderColor: "var(--color-line-strong)", background: "var(--color-surface)" }}
      >
        <p className="max-w-[62ch] text-[13.5px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
          No account, no email, no card. We look up the published records and
          tell you what the world's mail servers see.
        </p>

        <form onSubmit={run} className="mt-4 flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="example.com"
            aria-label="Domain to check"
            data-testid="domain-check-input"
            className="min-w-[260px] flex-1 rounded-[2px] border px-3 py-2.5 text-[14px]"
            style={{
              background: "var(--color-elevate)",
              borderColor: "var(--color-line-strong)",
              color: "var(--color-ink)",
            }}
          />
          <button
            type="submit"
            disabled={busy || !domain.trim()}
            data-testid="domain-check-submit"
            className="rounded-[2px] px-5 py-2.5 text-[13.5px] font-semibold disabled:cursor-not-allowed"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-ink)",
              opacity: busy || !domain.trim() ? 0.6 : 1,
            }}
          >
            {busy ? "Looking up…" : "Check the domain"}
          </button>
        </form>

        {/* One fixed slot for the pause and failure messages: a message that
            appears must not push the rectangle down the page. */}
        <div className="mt-3 min-h-[36px]" data-testid="domain-check-message">
          {rateLimited ? (
            <p role="status" className="text-[13px]" style={{ color: "var(--color-unverified)" }}>
              Too many lookups: try again shortly. The lookup service is shared
              and rate limited, which is why this check stays free.
            </p>
          ) : error ? (
            <p role="alert" className="text-[13px]" style={{ color: "var(--color-block)" }}>
              {error}
            </p>
          ) : null}
        </div>

        {/* The rectangle: query, response, parsed, verdict. The worked example
            at rest, the domain's own result after a lookup. Same rows, same
            heights, either way. */}
        <div className="mt-1 border-t pt-2" style={{ borderColor: "var(--color-line)" }}>
          <Row label="query" height="30px">
            <span className="num text-[12px]" style={{ color: "var(--color-ink-2)" }}>
              {shape.query}
            </span>
          </Row>
          <Row label="response" height="42px">
            <span
              className="num text-[11.5px] leading-[1.55]"
              style={{ color: "var(--color-ink)", wordBreak: "break-all" }}
            >
              {shape.response}
            </span>
          </Row>
          <Row label="parsed" height="76px">
            <div className="flex flex-col gap-[2px]">
              {shape.records.map(([name, state]) => (
                <div key={name} className="flex items-baseline gap-x-3">
                  <span className="num w-[52px] text-[10.5px] uppercase tracking-[0.12em]" style={{ color: "var(--color-ink-3)" }}>
                    {name}
                  </span>
                  <span
                    className="num text-[10.5px] uppercase tracking-[0.12em]"
                    style={{ color: STATE_COLOR[state] }}
                  >
                    {state}
                  </span>
                </div>
              ))}
            </div>
          </Row>
          <Row label="verdict" height="38px">
            <span className="num text-[11.5px] font-semibold" style={{ color: shape.verdictColor }}>
              {shape.verdict}
            </span>
          </Row>
        </div>
      </div>
    </section>
  );
}
