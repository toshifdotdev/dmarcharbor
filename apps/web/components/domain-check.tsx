"use client";

/**
 * domain-check.tsx — the homepage's anonymous domain check.
 *
 * POST /api/scan is public and rate limited, so there is nothing to gate: the
 * result is never hidden behind a sign-up (that was considered and rejected:
 * a free check that demands an account is not free).
 *
 * The panel is a VERDICT BOX and it is fixed height by construction: the
 * domain, the status, and the three record states (DMARC, SPF, DKIM) are all
 * it shows, and the idle state renders the same three record labels with an
 * empty state cell. Idle and loaded occupy the same pixels, so the hero never
 * reflows on interaction. The explanations of what each row means live with
 * the product prose in "One lookup, end to end", not inside the output the
 * moment it appears.
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

const STATUS_LABEL: Record<ScanResult["status"], string> = {
  healthy: "looks good",
  needs_attention: "needs attention",
  missing: "no DMARC record",
  error: "lookup failed",
};

/** One record state row: the label is static (idle and loaded identical) and
 *  the state word is the whole verdict of the row. Unknown is never a pass:
 *  found = green, missing = amber, and no measurement renders an empty cell
 *  rather than borrowing either colour. */
function RecordRow({ label, found }: { label: string; found: boolean | null }) {
  return (
    <div
      className="flex min-h-[34px] items-center gap-x-3 border-b"
      style={{ borderColor: "var(--color-line)" }}
    >
      <span className="num w-[64px] text-[11px] uppercase tracking-[0.12em]" style={{ color: "var(--color-ink-3)" }}>
        {label}
      </span>
      <span
        className="num text-[11px] uppercase tracking-[0.12em]"
        style={{
          color: found === true ? "var(--color-pass)" : found === false ? "var(--color-unverified)" : "var(--color-unmeasured)",
        }}
      >
        {found === true ? "published" : found === false ? "missing" : ""}
      </span>
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

  return (
    <section className="w-full" data-testid="domain-check">
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
            appears must not push the verdict box down the page. */}
        <div className="mt-3 min-h-[18px]" data-testid="domain-check-message">
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

        {/* The verdict box. The header line and the three record rows render
            in both states; only their contents differ, so the height is the
            same before and after a scan. */}
        <div className="mt-2 border-t pt-3" style={{ borderColor: "var(--color-line)" }}>
          <div className="flex min-h-[22px] items-baseline gap-x-4">
            {result ? (
              <>
                <span className="num text-[13px]" style={{ color: "var(--color-ink)" }}>
                  {result.domain}
                </span>
                <span
                  className="num text-[11px] uppercase tracking-[0.12em]"
                  style={{
                    color:
                      result.status === "healthy"
                        ? "var(--color-pass)"
                        : result.status === "needs_attention"
                          ? "var(--color-unverified)"
                          : "var(--color-block)",
                  }}
                >
                  {STATUS_LABEL[result.status]}
                </span>
              </>
            ) : null}
          </div>
          <RecordRow
            label="DMARC"
            found={result ? (result.dmarc.status === "found" ? true : result.dmarc.status === "missing" ? false : null) : null}
          />
          <RecordRow
            label="SPF"
            found={result ? (result.spf.status === "found" ? true : result.spf.status === "missing" ? false : null) : null}
          />
          <RecordRow
            label="DKIM"
            found={result ? (result.dkim.status === "found" ? true : result.dkim.status === "missing" ? false : null) : null}
          />
        </div>
      </div>
    </section>
  );
}
