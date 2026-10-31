"use client";

/**
 * share-links.tsx — a read-only link to one domain's report, for someone
 * outside the workspace.
 *
 * The usual reader is a client's IT contact who has no login and should not
 * need one. A link publishes the report to anyone holding it, so the panel
 * says that before anything is made, and every live link has a visible end:
 * an expiry and a revoke. Forensic evidence is opt-in per link and named as
 * what it is, because it carries message detail.
 *
 * Calls, all existing API:
 *   POST   /report-shares                    create
 *   POST   /report-shares/:id/revoke         stops the link at once
 *   DELETE /report-shares/:id                removes a revoked row
 *   DELETE /report-shares/revoked            removes every revoked row
 *
 * The link handed out is the rendered page (/share/<token>) on whichever host
 * the operator is on, so an agency's own domain hands out its own links. Dates
 * arrive formatted from the server; nothing here formats a timestamp.
 */

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { clsx } from "clsx";
import {
  createReportShare,
  deleteAllRevokedReportShares,
  deleteReportShareRecord,
  revokeReportShare,
} from "@/lib/ops-client";
import { shareHref } from "@/lib/route-hrefs";
import { Button, ButtonLink } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { ConfirmDialog } from "@/components/ui/dialog";
import { CopyButton } from "@/components/ui/copy";
import { Segmented } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";

export interface ShareView {
  id: string;
  token: string;
  createdLabel: string;
  expiresLabel: string;
  revokedLabel: string | null;
  expired: boolean;
  viewCount: number;
  includeSources: boolean;
  includeForensics: boolean;
}

const EXPIRY = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
] as const;
type Expiry = (typeof EXPIRY)[number]["value"];

const noop = () => () => {};
function useOrigin() {
  return useSyncExternalStore(noop, () => window.location.origin, () => "");
}

type Pending =
  | { kind: "revoke"; share: ShareView }
  | { kind: "remove"; share: ShareView }
  | { kind: "clear"; count: number }
  | null;

export function ShareLinks({
  organizationId,
  domainId,
  domainName,
  shares,
}: {
  organizationId: string;
  domainId: string;
  domainName: string;
  shares: ShareView[];
}) {
  const router = useRouter();
  const origin = useOrigin();
  const [expiry, setExpiry] = useState<Expiry>("30");
  const [includeSources, setIncludeSources] = useState(true);
  const [includeForensics, setIncludeForensics] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const absolute = (token: string) => (origin ? `${origin}${shareHref(token)}` : shareHref(token));
  const live = shares.filter((s) => !s.revokedLabel && !s.expired);
  const revoked = shares.filter((s) => s.revokedLabel);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await createReportShare(organizationId, {
      domainId,
      includeSources,
      includeForensics,
      expiresInDays: Number(expiry),
    });
    setBusy(false);
    if (!res.ok) {
      setError({ code: res.error.code ?? String(res.status), message: res.error.message ?? "The link could not be created." });
      return;
    }
    setCreated(res.data.token);
    router.refresh();
  }

  async function confirm() {
    if (!pending) return;
    setConfirmBusy(true);
    setConfirmError(null);
    const res =
      pending.kind === "revoke"
        ? await revokeReportShare(organizationId, pending.share.id)
        : pending.kind === "remove"
          ? await deleteReportShareRecord(organizationId, pending.share.id)
          : await deleteAllRevokedReportShares(organizationId);
    setConfirmBusy(false);
    if (!res.ok) {
      setConfirmError(res.error.message ?? "That did not go through.");
      return;
    }
    if (pending.kind === "revoke" && pending.share.token === created) setCreated(null);
    setPending(null);
    router.refresh();
  }

  return (
    <section aria-labelledby="share-head" className="flex flex-col gap-5">
      <div>
        <h2 id="share-head" className="text-h3 font-bold tracking-[-0.01em] text-fg">
          Share the report
        </h2>
        <p className="mt-1 max-w-[68ch] text-ui text-fg-2">
          A read-only link to {domainName}&rsquo;s report, for someone without a login, such as the client&rsquo;s IT
          contact. Anyone holding the link can open it until it expires or you revoke it.
        </p>
      </div>

      <form onSubmit={create} className="flex flex-col gap-5 border-y border-rule py-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-meta font-semibold text-fg-2">Expires after</span>
          <Segmented label="Expires after" value={expiry} options={[...EXPIRY]} onChange={setExpiry} size="sm" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 sm:gap-8">
          <Checkbox
            checked={includeSources}
            onChange={(e) => setIncludeSources(e.target.checked)}
            label="Include sending sources"
            hint="Which servers sent mail as the domain, and how each did."
          />
          <Checkbox
            checked={includeForensics}
            onChange={(e) => setIncludeForensics(e.target.checked)}
            data-testid="share-forensics"
            label="Include forensic evidence"
            hint={
              includeForensics ? (
                <span className="text-warn">The link will show failure detail from individual messages.</span>
              ) : (
                "Detail from individual failed messages. Off unless you need it."
              )
            }
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button type="submit" variant="secondary" busy={busy} busyLabel="Creating the link" data-testid="create-share">
            Create share link
          </Button>
          <span className="tnum text-meta text-fg-3">
            {live.length === 0 ? "No live links for this domain." : `${live.length} live link${live.length === 1 ? "" : "s"} below.`}
          </span>
        </div>
        {error ? (
          error.code === "FEATURE_NOT_IN_PLAN" || error.code === "402" ? (
            <Notice
              tone="warn"
              title="Share links are not on this workspace's plan"
              action={
                <ButtonLink href="/billing" size="sm">
                  See plan options
                </ButtonLink>
              }
            >
              {error.message}
            </Notice>
          ) : (
            <Notice tone="fail" title={error.message} />
          )
        ) : null}
      </form>

      {created ? (
        <div role="status" data-copy-scope className="flex flex-col gap-2 rounded-[10px] border border-ok/30 bg-ok-wash px-3.5 py-3">
          <p className="flex items-center gap-2 text-ui font-semibold text-fg">
            <span aria-hidden className="block size-2 shrink-0 bg-ok" />
            Link created. Send it to whoever needs the report.
          </p>
          <div className="flex flex-wrap items-start gap-2 pl-4">
            <a
              href={shareHref(created)}
              target="_blank"
              rel="noreferrer"
              data-testid="share-link"
              data-copy-value
              className="data min-w-0 flex-1 break-all pt-[3px] text-meta font-semibold text-fg underline decoration-rule-2 underline-offset-2 hover:decoration-current"
            >
              {absolute(created)}
            </a>
            <CopyButton value={absolute(created)} label="Copy the share link" testId="copy-share-link" />
          </div>
        </div>
      ) : null}

      {shares.length > 0 ? (
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2 pb-2">
            <p className="text-ui font-bold text-fg">Links for this domain</p>
            {revoked.length > 0 ? (
              <button
                type="button"
                className="link text-meta font-semibold"
                data-testid="share-remove-all-revoked"
                onClick={() => {
                  setConfirmError(null);
                  setPending({ kind: "clear", count: revoked.length });
                }}
              >
                Remove {revoked.length} revoked
              </button>
            ) : null}
          </div>
          <ul className="border-t border-rule">
            {shares.map((s) => {
              const dead = Boolean(s.revokedLabel) || s.expired;
              return (
                <li
                  key={s.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-rule py-2.5"
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                      <a
                        href={shareHref(s.token)}
                        target="_blank"
                        rel="noreferrer"
                        className={clsx("data text-meta font-semibold", dead ? "text-fg-3 line-through decoration-fg-4" : "link")}
                      >
                        /share/{s.token.slice(0, 10)}…
                      </a>
                      <span
                        className={clsx(
                          "inline-flex items-center gap-1.5 text-meta font-semibold",
                          s.revokedLabel ? "text-fail" : s.expired ? "text-fg-3" : "text-ok",
                        )}
                      >
                        <ShareMark state={s.revokedLabel ? "revoked" : s.expired ? "expired" : "live"} />
                        {s.revokedLabel ? `Revoked ${s.revokedLabel}` : s.expired ? `Expired ${s.expiresLabel}` : `Live until ${s.expiresLabel}`}
                      </span>
                    </p>
                    <p className="mt-0.5 text-meta text-fg-3">
                      Created {s.createdLabel} · <span className="tnum">{s.viewCount}</span> view{s.viewCount === 1 ? "" : "s"} ·{" "}
                      {[s.includeSources ? "sources" : null, s.includeForensics ? "forensic evidence" : null].filter(Boolean).join(" and ") ||
                        "aggregate only"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {!dead ? <CopyButton value={absolute(s.token)} label="Copy this share link" testId="copy-share-row" /> : null}
                    {!s.revokedLabel ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="revoke-share"
                        onClick={() => {
                          setConfirmError(null);
                          setPending({ kind: "revoke", share: s });
                        }}
                      >
                        Revoke
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={`remove-share-${s.id}`}
                        onClick={() => {
                          setConfirmError(null);
                          setPending({ kind: "remove", share: s });
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={confirm}
        busy={confirmBusy}
        error={confirmError}
        danger={pending?.kind === "revoke"}
        testId={
          pending?.kind === "revoke" ? "revoke-share" : pending?.kind === "remove" ? `remove-share-${pending.share.id}` : "share-remove-all-revoked"
        }
        title={
          pending?.kind === "revoke"
            ? "Revoke this share link?"
            : pending?.kind === "remove"
              ? "Remove this revoked link?"
              : `Remove ${pending?.kind === "clear" ? pending.count : 0} revoked links?`
        }
        confirmLabel={pending?.kind === "revoke" ? "Revoke link" : "Remove"}
        body={
          pending?.kind === "revoke" ? (
            <>
              The link stops working immediately for anyone who has it. It has been opened{" "}
              <span className="tnum font-semibold text-fg">{pending.share.viewCount}</span> time
              {pending.share.viewCount === 1 ? "" : "s"}. This cannot be undone; you can always create a new link.
            </>
          ) : (
            "Revoked links already stopped working, so nobody loses access. This only clears them from the list, with their view counts."
          )
        }
      />
    </section>
  );
}

/** A link's state as a shape beside its word: live is a filled square, revoked a diamond, expired a hollow square. */
function ShareMark({ state }: { state: "live" | "revoked" | "expired" }) {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden className="shrink-0">
      {state === "live" ? <rect x="0.5" y="0.5" width="9" height="9" fill="var(--color-ok)" /> : null}
      {state === "revoked" ? <path d="M5 0 10 5 5 10 0 5Z" fill="var(--color-fail)" /> : null}
      {state === "expired" ? <rect x="1" y="1" width="8" height="8" fill="none" stroke="var(--color-void)" strokeWidth="1.5" /> : null}
    </svg>
  );
}
