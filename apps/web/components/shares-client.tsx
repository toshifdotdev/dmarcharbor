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

import { ActionButton } from "@/components/action-button";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { EntitlementNotice } from "@/components/entitlement-gate";
import { createReportShare, deleteAllRevokedReportShares, deleteReportShareRecord, revokeReportShare } from "@/lib/ops-client";
import { shareHref } from "@/lib/route-hrefs";
import { ConfirmAction } from "@/components/confirm-action";
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
  /**
   * Which token was last copied, not a bare boolean.
   *
   * One boolean would light up every row in the list at the same moment the
   * operator copies one of them, which tells them nothing about what they just
   * took. Keying it by token means exactly one control says "copied", and it is
   * the one they pressed.
   */
  const [copied, setCopied] = useState<string | null>(null);

  const mine = shares.filter((s) => s.domain.id === domainId);
  const revokedShares = mine.filter((s) => s.revokedAt !== null);

  /**
   * Copies the ABSOLUTE url, not the relative path.
   *
   * A share link exists to be sent to somebody outside this workspace - a client's
   * IT contact - so `/share/abc` copied into an email opens nothing. The origin
   * is read at click time rather than baked in, because the same build serves
   * `app.dmarcharbor.com` and every agency's custom domain, and a link minted on
   * one has to resolve on whichever the reader is actually on.
   */
  async function copyLink(token: string) {
    try {
      const absolute = new URL(shareHref(token), window.location.origin).toString();
      await navigator.clipboard.writeText(absolute);
      setCopied(token);
      setTimeout(() => setCopied((current) => (current === token ? null : current)), 2000);
    } catch {
      setCopied(null);
    }
  }

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
      // The token is the contract; the path is ours. Holding the token rather
      // than the rendered path means the same value drives the link, the copy
      // button and the "copied" highlight, and they cannot drift apart.
      setCreated(res.data.token);
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
        A share link lets anyone holding it read this domain's report: useful
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
        <div
          role="status"
          className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]"
          style={{ color: "var(--color-pass)" }}
        >
          <span>Share link created.</span>
          <a
            href={shareHref(created)}
            className="num underline"
            style={{ color: "var(--color-ink)" }}
            data-testid="share-link"
            target="_blank"
            rel="noreferrer"
          >
            {shareHref(created)}
          </a>
          {/* The moment the operator wants this one: it is on screen, it is the
              only new thing here, and it is about to be pasted into an email. */}
          <ActionButton
            label={copied === created ? "copied" : "copy link"}
            loadingLabel="Copying…"
            busy={false}
            onClick={() => copyLink(created)}
            variant="ghost"
            testId="copy-share-link"
            style={{ padding: "4px 10px", fontSize: "11.5px" }}
          />
        </div>
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
                {" "}(this share will expose failure detail)
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

        <ActionButton
          type="submit"
          label={"Create share link"}
          loadingLabel={"Creating…"}
          busy={busy}
          testId="create-share"
        />
      </form>

      {mine.length > 0 ? (
        <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--color-line)" }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="label">Share links</span>
            {/* Only when there is something to clear. Appearing unconditionally
                would put a destructive control on a screen whose common case has
                nothing to clean up. */}
            {revokedShares.length > 0 ? (
              <ConfirmAction
                label={`Remove all revoked (${revokedShares.length})`}
                confirmLabel={`remove ${revokedShares.length} revoked link${revokedShares.length === 1 ? "" : "s"}`}
                consequence={`Deletes ${revokedShares.length} revoked link${revokedShares.length === 1 ? "" : "s"}. They already stopped working, so nobody loses access by removing them.`}
                testId="share-remove-all-revoked"
                onConfirm={async () => {
                  const res = await deleteAllRevokedReportShares(organizationId);
                  if (!res.ok) return { ok: false, message: res.error?.message };
                  router.refresh();
                  return { ok: true };
                }}
              />
            ) : null}
          </div>
          <ul className="mt-1.5">
          {mine.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b py-2.5"
              style={{ borderColor: "rgba(255,255,255,0.055)" }}
            >
              <a
                href={shareHref(s.token)}
                target="_blank"
                rel="noreferrer"
                className="num text-[11.5px] underline"
                style={{ color: s.revokedAt ? "var(--color-ink-3)" : "var(--color-ink-2)" }}
              >
                /share/{s.token.slice(0, 10)}…
              </a>
              {!s.revokedAt ? (
                // Copying is the whole point of a link sent to somebody else, and
                // an unselected truncated token is not pasteable. A revoked link
                // offers no copy at all: copying something that cannot open would
                // hand the operator a link they would have to remember to distrust.
                <ActionButton
                  label={copied === s.token ? "copied" : "copy"}
                  loadingLabel="Copying…"
                  busy={false}
                  onClick={() => copyLink(s.token)}
                  variant="ghost"
                  testId="copy-share-row"
                  style={{ padding: "3px 9px", fontSize: "11px" }}
                />
              ) : null}
              <span className="num text-[10.5px]" style={{ color: "var(--color-ink-3)" }}>
                {s.revokedAt
                  ? `revoked ${new Date(s.revokedAt).toLocaleDateString("en-GB")}`
                  : `expires ${new Date(s.expiresAt).toLocaleDateString("en-GB")}`}
                {" · "}
                {s.viewCount} view{s.viewCount === 1 ? "" : "s"}
              </span>
              {!s.revokedAt ? (
                // Revoking a share is destructive (it kills a link a client may
                // hold), so it is not one keystroke from something harmless:
                // the control arms, names the consequence, then fires.
                <span className="ml-auto">
                  <ConfirmAction
                    label="revoke"
                    confirmLabel="yes, revoke"
                    consequence="a revoked link stops working immediately"
                    testId="revoke-share"
                    onConfirm={async () => {
                      const res = await revokeReportShare(organizationId, s.id);
                      if (!res.ok) setError(res.error);
                      else router.refresh();
                    }}
                  />
                </span>
              ) : (
                // A revoked link is inert but permanent to look at, and its token
                // stays copyable nowhere - it is the residue, and the way to clear
                // it is to say so rather than leave a dead row in the list.
                <span className="ml-auto">
                  <ConfirmAction
                    label="remove"
                    confirmLabel="remove this row"
                    tone="ink"
                    consequence={`Deletes this revoked link and its ${s.viewCount}-view record. It already stopped working.`}
                    testId={`remove-share-${s.id}`}
                    onConfirm={async () => {
                      const res = await deleteReportShareRecord(organizationId, s.id);
                      if (!res.ok) return { ok: false, message: res.error?.message };
                      router.refresh();
                      return { ok: true };
                    }}
                  />
                </span>
              )}
            </li>
          ))}
          </ul>
        </div>
      ) : (
        <p className="mt-4 text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
          No share links yet.
        </p>
      )}
    </section>
  );
}
