"use client";

/**
 * shares-client.tsx — report share links: create, list, revoke.
 *
 * The share link is the EXISTING public surface (GET
 * /api/reports/share/:token) — this form mints tokens for it and links to it.
 * It is never rebuilt here. A share publishes report data to anyone holding
 * the URL, so the form says so before creation, and includeForensics is only
 * offered where the plan and role permit it.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EntitlementNotice } from "@/components/entitlement-gate";
import { createReportShare, revokeReportShare } from "@/lib/ops-client";
import type { ApiErrorBody, ReportShareRow } from "@/lib/types";

const EXPIRY_CHOICES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
];

export function ShareForm({
  organizationId,
  domainId,
  shares,
}: {
  organizationId: string;
  domainId: string;
  shares: ReportShareRow[];
}) {
  const router = useRouter();
  const [includeSources, setIncludeSources] = useState(true);
  const [includeForensics, setIncludeForensics] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mine = shares.filter((s) => s.domain.id === domainId);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCreated(null);
    const res = await createReportShare(organizationId, {
      domainId,
      includeForensics,
      includeSources,
      expiresInDays,
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      // The API returns the existing public path — link to it, never rebuild.
      setCreated(res.data.url);
      router.refresh();
    }
  }

  return (
    <section
      className="lift rounded-[2px] border p-5"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
    >
      <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
        4 · Share the report
      </h2>
      <p className="mt-1.5 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
        A share link lets anyone holding it read this domain's report — useful
        for sending evidence to your client's IT contact.
      </p>

      {error ? (
        error.code === "FEATURE_NOT_IN_PLAN" ? (
          <div className="mt-3">
            <EntitlementNotice error={error} />
          </div>
        ) : (
          <p role="alert" className="mt-3 text-[13px]" style={{ color: "var(--color-block)" }}>
            {error.message}
          </p>
        )
      ) : null}

      {created ? (
        <p role="status" className="mt-3 text-[13px]" style={{ color: "var(--color-pass)" }}>
          Share link created.{" "}
          <a
            href={created}
            className="underline"
            style={{ color: "var(--color-ink)" }}
            data-testid="share-link"
            target="_blank"
            rel="noreferrer"
          >
            {created}
          </a>
        </p>
      ) : null}

      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
            <input
              type="checkbox"
              checked={includeSources}
              onChange={(e) => setIncludeSources(e.target.checked)}
            />
            include source detail
          </label>
          <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
            <input
              type="checkbox"
              checked={includeForensics}
              onChange={(e) => setIncludeForensics(e.target.checked)}
              data-testid="share-forensics"
            />
            include forensic evidence
            {includeForensics ? (
              <span style={{ color: "var(--color-unverified)" }}>
                {" "}— this share will expose failure detail
              </span>
            ) : null}
          </label>
          <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
            expires in
            <select
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(Number(e.target.value))}
              style={{
                background: "var(--color-elevate)",
                border: "1px solid var(--color-line-strong)",
                borderRadius: 2,
                color: "var(--color-ink)",
                padding: "6px 10px",
                fontSize: 13,
              }}
            >
              {EXPIRY_CHOICES.map((c) => (
                <option key={c.days} value={c.days}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <button
          type="submit"
          disabled={busy}
          className="self-start rounded-[2px] px-5 py-2.5 text-[13.5px] font-semibold"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
          data-testid="create-share"
        >
          {busy ? "Creating…" : "Create share link"}
        </button>
      </form>

      {mine.length > 0 ? (
        <ul className="mt-5 border-t pt-4" style={{ borderColor: "var(--color-line)" }}>
          {mine.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b py-2.5"
              style={{ borderColor: "rgba(255,255,255,0.055)" }}
            >
              <a
                href={`/api/reports/share/${s.token}`}
                target="_blank"
                rel="noreferrer"
                className="num text-[11.5px] underline"
                style={{ color: s.revokedAt ? "var(--color-ink-3)" : "var(--color-ink-2)" }}
              >
                /api/reports/share/{s.token.slice(0, 10)}…
              </a>
              <span className="num text-[10.5px]" style={{ color: "var(--color-ink-3)" }}>
                {s.revokedAt
                  ? `revoked ${new Date(s.revokedAt).toLocaleDateString("en-GB")}`
                  : `expires ${new Date(s.expiresAt).toLocaleDateString("en-GB")}`}
                {" · "}
                {s.viewCount} view{s.viewCount === 1 ? "" : "s"}
              </span>
              {!s.revokedAt ? (
                <button
                  type="button"
                  onClick={async () => {
                    await revokeReportShare(organizationId, s.id);
                    router.refresh();
                  }}
                  className="ml-auto text-[11.5px] underline"
                  style={{ color: "var(--color-block)" }}
                  data-testid="revoke-share"
                >
                  revoke
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
          No share links yet.
        </p>
      )}
    </section>
  );
}
