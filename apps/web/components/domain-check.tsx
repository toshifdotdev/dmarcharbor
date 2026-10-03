"use client";

/**
 * domain-check.tsx — the homepage's anonymous domain check.
 *
 * POST /api/scan is public and rate limited, so there is nothing to gate: the
 * result is never hidden behind a sign-up (that was considered and rejected —
 * a free check that demands an account is not free). The box shows the record
 * and what it means, and it is honest about what the free check is not: one
 * lookup is a moment in time, while the product is continuous measurement
 * across a book of client domains.
 *
 * The 429 is not an error — the endpoint is rate limited on purpose. It reads
 * as "too many lookups, try again shortly", never as a failure.
 *
 * Anything the API did not report is shown as unknown, never as a pass.
 */

import { useState } from "react";
import Link from "next/link";

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

const POLICY_MEANING: Record<ScanResult["dmarc"]["policy"], string> = {
  reject: "Mail that fails alignment is refused by receivers: the strongest policy.",
  quarantine: "Mail that fails alignment is filtered to spam or held: enforcement without rejection.",
  none: "Mail that fails alignment is only reported. Nothing is enforced yet: this is monitoring, not protection.",
  unknown: "No policy is published, so receivers decide on their own.",
};

function RecordRow({ label, found, detail }: { label: string; found: boolean | null; detail: string }) {
  return (
    <div
      className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b py-2"
      style={{ borderColor: "var(--color-line)" }}
    >
      <span className="num w-[64px] text-[11px] uppercase tracking-[0.12em]" style={{ color: "var(--color-ink-3)" }}>
        {label}
      </span>
      <span
        className="num text-[11px] uppercase tracking-[0.12em]"
        style={{
          // Unknown is never a pass: found = green, missing = amber, null =
          // not measured at all.
          color: found === true ? "var(--color-pass)" : found === false ? "var(--color-unverified)" : "var(--color-unmeasured)",
        }}
      >
        {found === true ? "published" : found === false ? "missing" : "not measured"}
      </span>
      <span className="flex-1 text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
        {detail}
      </span>
    </div>
  );
}

export function DomainCheck({ compact = false }: { compact?: boolean } = {}) {
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
    <section className={compact ? "w-full" : "mt-14 w-full"} data-testid="domain-check">
      <div
        className="rounded-[2px] border px-6 py-6"
        style={{ borderColor: "var(--color-line-strong)", background: "var(--color-surface)" }}
      >
        {!compact ? (
          <>
            <h2 className="text-[19px] font-semibold tracking-[-0.02em]" style={{ fontFamily: "var(--font-display)" }}>
              Check one domain, now
            </h2>
            <p className="mt-2 max-w-[62ch] text-[13.5px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
              No account, no email, no card. We look up the published records and
              tell you what the world's mail servers see: the same reading the
              product starts from.
            </p>
          </>
        ) : (
          <p className="max-w-[62ch] text-[13.5px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
            No account, no email, no card. We look up the published records and
            tell you what the world's mail servers see.
          </p>
        )}

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

        {rateLimited ? (
          <p role="status" className="mt-3 text-[13px]" style={{ color: "var(--color-unverified)" }}>
            Too many lookups: try again shortly. The lookup service is shared
            and rate limited, which is why this check stays free.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 text-[13px]" style={{ color: "var(--color-block)" }}>
            {error}
          </p>
        ) : null}

        {result ? (
          <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--color-line)" }}>
            <div className="flex flex-wrap items-baseline gap-x-4">
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
                {result.status === "healthy"
                  ? "looks good"
                  : result.status === "needs_attention"
                    ? "needs attention"
                    : result.status === "missing"
                      ? "no DMARC record"
                      : "lookup failed"}
              </span>
            </div>

            {/* The record and what it means — never the record alone. */}
            <div className="mt-3">
              <RecordRow
                label="DMARC"
                found={result.dmarc.status === "found" ? true : result.dmarc.status === "missing" ? false : null}
                detail={
                  result.dmarc.status === "found"
                    ? `p=${result.dmarc.policy}: ${POLICY_MEANING[result.dmarc.policy]}`
                    : result.dmarc.status === "missing"
                      ? "No DMARC policy is published, so receivers decide on their own."
                      : "This lookup could not read the DMARC record."
                }
              />
              <RecordRow
                label="SPF"
                found={result.spf.status === "found" ? true : result.spf.status === "missing" ? false : null}
                detail={
                  result.spf.status === "found"
                    ? result.spf.valid === false
                      ? "Published, but it does not validate."
                      : "Published and valid."
                    : "Not published."
                }
              />
              <RecordRow
                label="DKIM"
                found={result.dkim.status === "found" ? true : result.dkim.status === "missing" ? false : null}
                detail={result.dkim.status === "found" ? "At least one selector published." : "No selector found."}
              />
            </div>

            {result.dmarc.record ? (
              <pre
                className="num mt-3 overflow-x-auto rounded-[2px] border px-3 py-2 text-[11.5px]"
                style={{
                  background: "var(--color-elevate)",
                  borderColor: "var(--color-line-strong)",
                  color: "var(--color-ink-2)",
                }}
              >
                {result.dmarc.record}
              </pre>
            ) : null}

            {result.issues.length > 0 ? (
              <ul className="mt-4 flex flex-col gap-2">
                {result.issues.slice(0, 4).map((issue) => (
                  <li key={issue.code} className="text-[12.5px] leading-[1.7]" style={{ color: "var(--color-ink-2)" }}>
                    <strong style={{ color: "var(--color-ink)" }}>{issue.title}.</strong>{" "}
                    {issue.message}
                    {issue.recommendation ? (
                      <span style={{ color: "var(--color-ink-3)" }}> {issue.recommendation}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}

            {/* What the free check is not — the honest boundary, said where it
                matters rather than buried in a footer. */}
            <p
              className="mt-5 border-t pt-4 text-[12.5px] leading-[1.75]"
              style={{ borderColor: "var(--color-line)", color: "var(--color-ink-3)" }}
              data-testid="domain-check-boundary"
            >
              This is one lookup at one moment. DMARC Harbor watches a whole book
              of client domains continuously: posture per domain as reports
              arrive, alerting, shareable evidence and a client portal: which is
              the difference between checking a domain and being responsible for
              it.{" "}
              <Link href="/sign-up" className="underline" style={{ color: "var(--color-ink)" }}>
                Start monitoring free
              </Link>
              .
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
