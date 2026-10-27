"use client";

/**
 * hosted-mta-sts.tsx — the MTA-STS panel on a domain's setup tab.
 *
 * MTA-STS is the record that tells senders which mail servers are allowed to
 * receive this domain's mail, and refuses delivery to any other. That makes it
 * the one hosted feature where a mistake stops mail rather than changing how it
 * looks, which shapes the whole panel:
 *
 * 1. Moving to enforce is checked against evidence, and the blockers are shown
 *    before the button rather than after a refusal.
 * 2. Moving back to testing is always one click and always visible while
 *    enforcing, because it is the safe answer to "something is wrong".
 * 3. The MX list is never changed automatically from DNS. An uncovered host is
 *    raised as a red banner with an explicit "add" that goes through the normal
 *    change path, because following DNS is exactly what MTA-STS defends against.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { instantLabel } from "@/lib/instant";
import type { HostedMtaStsView } from "@/lib/types";
import {
  checkHostedMtaSts,
  releaseHostedMtaSts,
  startHostedMtaSts,
  updateHostedMtaSts,
} from "@/lib/ops-client";
import { Button } from "@/components/ui/button";
import { DnsRecord } from "@/components/ui/copy";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { UpgradeNotice } from "@/components/ui/states";

const STATUS_WORDS = {
  PENDING: "Waiting for the two CNAMEs",
  ACTIVE: "Active",
  RELEASING: "Releasing",
  RELEASED: "Released",
} as const;

const CNAME_WORDS = {
  found: "found",
  missing: "missing",
  elsewhere: "points elsewhere",
} as const;

function dateLabel(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function daysLabel(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  return `${seconds.toLocaleString("en-GB")} seconds`;
}

const CHANGE_WORDS: Record<string, string> = {
  created: "Hosting started",
  policy: "Policy changed",
  released: "Released",
};

export function HostedMtaSts({
  organizationId,
  domainId,
  domainName,
  view,
  failed,
  canEdit,
  hasFeature,
}: {
  organizationId: string;
  domainId: string;
  domainName: string;
  view: HostedMtaStsView | null;
  failed: boolean;
  canEdit: boolean;
  /** null when the plan could not be read. */
  hasFeature: boolean | null;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<HostedMtaStsView | null>(view);
  const [mode, setMode] = useState<"testing" | "enforce">(
    view?.hosted?.mode === "enforce" ? "enforce" : "testing",
  );
  const [mx, setMx] = useState<string[]>(view?.hosted?.mx ?? []);
  const [maxAge, setMaxAge] = useState<string>(String(view?.hosted?.maxAge ?? 86_400));
  const [newHost, setNewHost] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [confirmOverride, setConfirmOverride] = useState(false);

  const hosted = current?.hosted ?? null;
  const paused = hosted?.paused ?? false;
  const enforcing = hosted?.mode === "enforce";

  function sync(next: HostedMtaStsView): void {
    setCurrent(next);
    setMode(next.hosted?.mode === "enforce" ? "enforce" : "testing");
    setMx(next.hosted?.mx ?? []);
    setMaxAge(String(next.hosted?.maxAge ?? 86_400));
    setError(null);
    setBlockers([]);
  }

  function failedResult(res: {
    status: number;
    error: { code?: string; message?: string; blockers?: string[]; view?: unknown };
  }): void {
    setError(res.error.message ?? "That did not go through. Nothing changed.");
    setBlockers(res.error.blockers ?? []);
    if (res.error.code === "VERSION_CHANGED" && res.error.view) {
      setCurrent(res.error.view as HostedMtaStsView);
    }
  }

  async function start(): Promise<void> {
    setBusy("start");
    setError(null);
    setBlockers([]);
    setNotice(null);
    const res = await startHostedMtaSts(organizationId, domainId);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice(
      "Hosting started. Publish the two CNAMEs below; the certificate is issued once mta-sts points here.",
    );
    router.refresh();
  }

  async function check(): Promise<void> {
    setBusy("check");
    setError(null);
    setBlockers([]);
    setNotice(null);
    const res = await checkHostedMtaSts(organizationId, domainId);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice(
      res.data.hosted?.status === "ACTIVE"
        ? "Both CNAMEs point here and the certificate is live. The policy is being served."
        : res.data.hosted?.status === "RELEASED"
          ? "The policy is released and no longer served."
          : "Checked just now. Something is still missing; the rows below say which.",
    );
    router.refresh();
  }

  /**
   * Back to testing, published at once.
   *
   * The safe action when something looks wrong has to be one click, not "change
   * the select, then remember to publish". It never needs a readiness check
   * because testing refuses nothing.
   */
  async function switchToTesting(): Promise<void> {
    if (!hosted) return;
    setMode("testing");
    setBusy("save");
    setError(null);
    setBlockers([]);
    setNotice(null);
    const res = await updateHostedMtaSts(organizationId, domainId, {
      expectedVersion: hosted.version,
      mode: "testing",
      mx,
      maxAge: Number(maxAge) || hosted.maxAge,
    });
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice("The policy is back in testing. Senders deliver and report instead of refusing.");
    router.refresh();
  }

  async function save(override = false): Promise<void> {
    if (!hosted) return;
    const seconds = Number(maxAge);
    setBusy(override ? "override" : "save");
    setError(null);
    setBlockers([]);
    setNotice(null);
    const res = await updateHostedMtaSts(organizationId, domainId, {
      expectedVersion: hosted.version,
      mode,
      mx,
      maxAge: Number.isFinite(seconds) ? seconds : hosted.maxAge,
      override,
    });
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      setConfirmOverride(false);
      return;
    }
    sync(res.data);
    setConfirmOverride(false);
    setNotice(
      res.data.action === "unchanged"
        ? "That is the policy already published. Nothing changed."
        : "The policy is published and the record's id has changed, so senders fetch it again.",
    );
    router.refresh();
  }

  async function addHost(host: string): Promise<void> {    if (!hosted) return;
    setBusy("add");
    setError(null);
    setNotice(null);
    const nextMx = mx.includes(host) ? mx : [...mx, host];
    const res = await updateHostedMtaSts(organizationId, domainId, {
      expectedVersion: hosted.version,
      mode: mode,
      mx: nextMx,
      maxAge: Number(maxAge) || hosted.maxAge,
    });
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice(`${host} was added to the policy. Senders that apply it can deliver there again.`);
    router.refresh();
  }

  async function release(): Promise<void> {
    setBusy("release");
    setError(null);
    setBlockers([]);
    setNotice(null);
    const res = await releaseHostedMtaSts(organizationId, domainId);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setConfirmRelease(false);
    setNotice(
      res.data.hosted?.status === "RELEASED"
        ? "Hosting stopped at once; nothing had been delegated."
        : "A 'none' policy is being served until every cached policy has expired. The date is below.",
    );
    router.refresh();
  }

  function addPattern(): void {
    const value = newHost.trim().toLowerCase();
    if (!value) return;
    if (mx.includes(value)) {
      setNewHost("");
      return;
    }
    setMx((previous) => [...previous, value]);
    setNewHost("");
  }

  return (
    <section aria-labelledby="hosted-mta-sts-head" className="flex flex-col gap-4 border-b border-rule-2 pb-6">
      <div>
        <h2 id="hosted-mta-sts-head" className="text-h3 font-bold tracking-[-0.01em] text-fg">
          MTA-STS
        </h2>
        {current?.available && !hosted ? (
          <p className="mt-1 max-w-[72ch] text-ui text-fg-2">
            Tell senders which mail servers may receive this domain&rsquo;s mail, and refuse delivery to any other.
            You publish two CNAMEs once; the policy itself is edited here and served by DMARC Harbor with a
            certificate Cloudflare renews.
          </p>
        ) : null}
      </div>

      {failed || !current ? (
        <Notice tone="warn" title="The MTA-STS state could not be read">
          This is not the same as it being off. Reload the page to try again.
        </Notice>
      ) : !current.available ? (
        <p className="text-ui text-fg-3" data-testid="hosted-mta-sts-unavailable">
          Hosted MTA-STS is not set up on this deployment.
        </p>
      ) : !hosted ? (
        <div className="flex flex-col gap-4">
          {current.capacity.full ? (
            <Notice tone="warn" title="Hosted MTA-STS is full on this deployment right now">
              {current.capacity.used} of {current.capacity.limit} custom hostnames are in use. Publish the policy
              yourself, or ask the operator to raise the limit.
            </Notice>
          ) : hasFeature === false ? (
            <UpgradeNotice
              feature="dns.hostedMtaSts"
              message="Hosted MTA-STS is included from Harbor. Nothing about this domain changes."
              context="You can still publish _mta-sts yourself and serve the policy from your own web server."
            />
          ) : canEdit ? (
            <div>
              <Button
                data-testid="hosted-mta-sts-start"
                variant="primary"
                busy={busy === "start"}
                busyLabel="Starting"
                onClick={start}
              >
                Host MTA-STS with DMARC Harbor
              </Button>
            </div>
          ) : (
            <p className="text-meta text-fg-3">An owner, admin or analyst can host MTA-STS for this domain.</p>
          )}

          <div className="flex flex-col gap-2 border-t border-rule pt-3">
            <p className="legend">What you need first</p>
            <ul className="flex flex-col gap-1.5 text-ui text-fg-2">
              <li>
                <span className="font-semibold text-fg">Two CNAMEs.</span> One at{" "}
                <code className="data">mta-sts.{domainName}</code> and one at{" "}
                <code className="data">_mta-sts.{domainName}</code>. Both are shown after you start.
              </li>
              <li>
                <span className="font-semibold text-fg">A working MX record.</span> The first policy lists the mail
                servers this domain receives on, so they have to resolve.
              </li>
              <li>
                <span className="font-semibold text-fg">Evidence before enforce.</span> Two weeks in testing and TLS
                reports that show senders already complete TLS, so enforcement refuses nothing that works today.
              </li>
            </ul>
          </div>

          {error ? <Notice tone="fail" title={error} /> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ui">
            <span className="font-semibold text-fg" data-testid="hosted-mta-sts-status">
              {STATUS_WORDS[hosted.status]}
            </span>
            <span className="text-meta text-fg-3">
              {hosted.delegationCheckedAt
                ? `Last checked ${instantLabel(hosted.delegationCheckedAt)}`
                : "Not checked yet"}
            </span>
            <span className="text-meta text-fg-3">
              mode <code className="data">{hosted.mode}</code>, max_age{" "}
              <code className="data">{hosted.maxAge}</code>
            </span>
          </div>

          {paused ? (
            <Notice tone="warn" title="Your plan no longer includes hosted MTA-STS">
              The policy keeps being served and refreshed; edits are paused. Release is still available.
            </Notice>
          ) : null}
          {hosted.lastSyncError ? (
            <Notice tone="fail" title={`The last DNS write did not publish: ${hosted.lastSyncError}`}>
              It is retried every six hours. Nothing was lost.
            </Notice>
          ) : null}
          {notice ? <Notice tone="ok" title={notice} /> : null}
          {error ? <Notice tone="fail" title={error} /> : null}
          {blockers.length > 0 ? (
            <ul className="list-disc pl-4 text-meta text-fail" data-testid="hosted-mta-sts-blockers">
              {blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          ) : null}

          {enforcing && hosted.uncoveredMx.length > 0 ? (
            <Notice tone="fail" title={`Senders that apply this policy refuse to deliver to ${hosted.uncoveredMx.join(", ")}`}>
              <div className="flex flex-col gap-2">
                <p>
                  The domain receives mail on {hosted.uncoveredMx.length === 1 ? "a host" : "hosts"} the policy does
                  not cover. Add {hosted.uncoveredMx.length === 1 ? "it" : "them"} to the policy, or switch to
                  testing.
                </p>
                {canEdit && !paused ? (
                  <div className="flex flex-wrap gap-2">
                    {hosted.uncoveredMx.map((host) => (
                      <Button
                        key={host}
                        data-testid={`hosted-mta-sts-add-${host}`}
                        busy={busy === "add"}
                        busyLabel="Adding"
                        onClick={() => addHost(host)}
                      >
                        Add {host}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            </Notice>
          ) : null}

          {hosted.status === "PENDING" || hosted.status === "ACTIVE" ? (
            <div className="flex flex-col gap-3">
              <DnsRecord
                type="CNAME"
                host={hosted.cname.host}
                zone={domainName}
                value={hosted.cname.target}
                testId="hosted-mta-sts-cname"
              />
              <DnsRecord
                type="CNAME"
                host={hosted.txtCname.host}
                zone={domainName}
                value={hosted.txtCname.target}
                testId="hosted-mta-sts-txt-cname"
              />
              <p className="max-w-[72ch] text-ui text-fg-2">
                Both must point here. The certificate is issued by Cloudflare once{" "}
                <code className="data">{hosted.cname.host}</code> resolves to it, so publish that one first.
              </p>

              <dl className="flex flex-col text-meta" data-testid="hosted-mta-sts-steps">
                <div className="flex justify-between gap-4 border-b border-rule py-1">
                  <dt className="text-fg-3">mta-sts CNAME</dt>
                  <dd className={hosted.mtaCnameState === "found" ? "text-ok" : "text-warn"}>
                    {hosted.mtaCnameState ? CNAME_WORDS[hosted.mtaCnameState] : "not checked"}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-rule py-1">
                  <dt className="text-fg-3">_mta-sts CNAME</dt>
                  <dd className={hosted.txtCnameState === "found" ? "text-ok" : "text-warn"}>
                    {hosted.txtCnameState ? CNAME_WORDS[hosted.txtCnameState] : "not checked"}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-rule py-1">
                  <dt className="text-fg-3">Certificate</dt>
                  <dd className={hosted.certificate.ready ? "text-ok" : "text-warn"}>
                    {hosted.certificate.ready
                      ? "active"
                      : hosted.certificate.sslStatus === "failed"
                        ? "failed"
                        : (hosted.certificate.sslStatus ?? "pending")}
                    {hosted.certificate.error ? `: ${hosted.certificate.error}` : ""}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-rule py-1">
                  <dt className="text-fg-3">Policy record</dt>
                  <dd className="data text-fg">{hosted.policyId}</dd>
                </div>
              </dl>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  data-testid="hosted-mta-sts-check"
                  busy={busy === "check"}
                  busyLabel="Checking"
                  onClick={check}
                >
                  Check now
                </Button>
                {canEdit ? (
                  <Button
                    data-testid="hosted-mta-sts-release"
                    variant="ghost"
                    className="text-fail hover:text-fail"
                    onClick={() => setConfirmRelease(true)}
                  >
                    Stop hosting
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {hosted.status === "RELEASING" ? (
            <div className="flex flex-col gap-3">
              <Notice tone="warn" title="A 'none' policy is being served until cached policies expire">
                <div className="flex flex-col gap-1">
                  <p>
                    We keep serving <code className="data">mode: none</code> until{" "}
                    <span className="font-semibold">
                      {hosted.releaseServeUntil ? dateLabel(hosted.releaseServeUntil) : "the window closes"}
                    </span>
                    . After that date, remove both CNAMEs.
                  </p>
                  <p>
                    If you publish your own MTA-STS instead, set it up before{" "}
                    {hosted.releaseServeUntil ? dateLabel(hosted.releaseServeUntil) : "that date"}.
                  </p>
                </div>
              </Notice>
              <p className="text-meta text-fg-3">
                Senders that cached the enforcing policy keep applying it until its max_age expires, which is why the
                policy is not withdrawn at once.
              </p>
              <div>
                <Button
                  data-testid="hosted-mta-sts-check"
                  busy={busy === "check"}
                  busyLabel="Checking"
                  onClick={check}
                >
                  Check now
                </Button>
              </div>
            </div>
          ) : null}

          {hosted.status === "RELEASED" ? (
            <div className="flex flex-col gap-3">
              <p className="text-ui text-fg-2">
                This domain no longer has its MTA-STS policy served by DMARC Harbor. Both CNAMEs can be removed.
              </p>
              {canEdit && hasFeature !== false && !current.capacity.full ? (
                <div>
                  <Button
                    data-testid="hosted-mta-sts-start"
                    busy={busy === "start"}
                    busyLabel="Starting"
                    onClick={start}
                  >
                    Host MTA-STS again
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {hosted.status === "ACTIVE" && canEdit && !paused ? (
            <div className="flex flex-col gap-3 border-t border-rule pt-3" data-testid="hosted-mta-sts-editor">
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-meta text-fg-2">
                  Mode
                  <Select
                    data-testid="hosted-mta-sts-mode"
                    value={mode}
                    onChange={(event) => setMode(event.target.value as "testing" | "enforce")}
                  >
                    <option value="testing">testing — report, still deliver</option>
                    <option value="enforce">enforce — refuse undeclared servers</option>
                  </Select>
                </label>
                <label className="flex flex-col gap-1 text-meta text-fg-2">
                  max_age (seconds)
                  <Input
                    data-testid="hosted-mta-sts-max-age"
                    type="number"
                    min={86_400}
                    max={31_557_600}
                    step={86_400}
                    value={maxAge}
                    onChange={(event) => setMaxAge(event.target.value)}
                    className="w-40"
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <Input
                  aria-label="Add an MX host or wildcard"
                  data-testid="hosted-mta-sts-add-input"
                  value={newHost}
                  onChange={(event) => setNewHost(event.target.value)}
                  placeholder="mx1.example.com or *.example.com"
                />
                <Button data-testid="hosted-mta-sts-add" onClick={addPattern}>
                  Add
                </Button>
              </div>

              <ul className="flex flex-col" data-testid="hosted-mta-sts-mx">
                {mx.length === 0 ? (
                  <li className="text-ui text-fg-3">No MX hosts yet. A policy needs at least one.</li>
                ) : null}
                {mx.map((host, index) => (
                  <li
                    key={`${host}-${index}`}
                    className="flex items-center gap-3 border-b border-rule py-2 text-ui"
                  >
                    <code className="data font-semibold text-fg">{host}</code>
                    <button
                      type="button"
                      className="link ml-auto text-meta"
                      data-testid={`hosted-mta-sts-remove-${index}`}
                      onClick={() => setMx((previous) => previous.filter((_, position) => position !== index))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  data-testid="hosted-mta-sts-save"
                  variant="primary"
                  busy={busy === "save"}
                  busyLabel="Publishing"
                  onClick={() => save(false)}
                >
                  Publish the policy
                </Button>
                {mode === "enforce" && hosted.mode !== "enforce" && hosted.readiness.blockers.length > 0 ? (
                  <Button data-testid="hosted-mta-sts-override" onClick={() => setConfirmOverride(true)}>
                    Enforce anyway
                  </Button>
                ) : null}
                {enforcing ? (
                  <Button
                    data-testid="hosted-mta-sts-back-to-testing"
                    busy={busy === "save"}
                    busyLabel="Switching"
                    onClick={switchToTesting}
                  >
                    Switch to testing
                  </Button>
                ) : null}
              </div>

              {mode === "enforce" && hosted.mode !== "enforce" ? (
                <div className="flex flex-col gap-2 border border-rule bg-paper-2 p-3" data-testid="hosted-mta-sts-readiness">
                  <p className="text-ui font-semibold text-fg">
                    {hosted.readiness.ready
                      ? "Ready to enforce: every check passes."
                      : `${hosted.readiness.blockers.length} thing${hosted.readiness.blockers.length === 1 ? "" : "s"} to resolve before enforcing`}
                  </p>
                  {hosted.readiness.blockers.length > 0 ? (
                    <ul className="flex list-disc flex-col gap-1 pl-4 text-meta text-fg-2">
                      {hosted.readiness.blockers.map((blocker) => (
                        <li key={blocker.code}>
                          {blocker.message}
                          {blocker.code === "no_tls_reports" || blocker.code === "tls_failures" ? (
                            <>
                              {" "}
                              <Link href={`/domains/${domainId}?tab=tls`} className="link">
                                See the TLS reports
                              </Link>
                              .
                            </>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              <details className="border-t border-rule pt-3">
                <summary className="cursor-pointer legend">What we serve</summary>
                <pre
                  data-testid="hosted-mta-sts-policy"
                  className="data mt-2 overflow-x-auto whitespace-pre-wrap break-all text-meta text-fg-2"
                >
                  {hosted.policy}
                </pre>
                <p className="mt-1 text-meta text-fg-3">
                  Served at <code className="data">{hosted.policyUrl}</code>, which only answers while the CNAME
                  points here.
                </p>
              </details>
            </div>
          ) : null}

          {hosted.changes.length > 0 ? (
            <div className="flex flex-col gap-2 border-t border-rule pt-3">
              <p className="legend">History</p>
              <ul className="flex flex-col">
                {hosted.changes.map((change) => (
                  <li
                    key={change.id}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule py-2 text-meta"
                  >
                    <span className="font-semibold text-fg">
                      {CHANGE_WORDS[change.reason] ?? change.reason}
                    </span>
                    <span className="text-fg-3">{instantLabel(change.createdAt)}</span>
                    <span className="text-fg-3">{change.actor?.name ?? "system"}</span>
                    <span className="data text-fg-3">
                      {change.previousMode ?? "none"} → {change.newMode}
                      {change.reason !== "released"
                        ? `, ${change.newMx.length} mx, ${daysLabel(change.newMaxAge)}`
                        : ""}
                    </span>
                    {change.readinessOverride ? <span className="text-warn">enforced over blockers</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={confirmRelease}
        onClose={() => setConfirmRelease(false)}
        onConfirm={release}
        title="Stop hosting this MTA-STS policy?"
        body={
          <div className="flex flex-col gap-2">
            <p>
              We publish <code className="data">mode: none</code> with a new id and keep serving it until every
              policy a sender may have cached has expired. Only then are the CNAMEs yours to remove.
            </p>
            {hosted?.status === "PENDING" ? (
              <p>This record was never delegated, so the hostname and the TXT are removed at once.</p>
            ) : (
              <p>Withdrawing an enforcing policy immediately would leave senders refusing mail to servers you still use.</p>
            )}
          </div>
        }
        confirmLabel="Stop hosting"
        busy={busy === "release"}
        danger
        error={error}
        testId="hosted-mta-sts-release"
      />

      <ConfirmDialog
        open={confirmOverride}
        onClose={() => setConfirmOverride(false)}
        onConfirm={() => save(true)}
        title="Enforce before the checks pass?"
        body={
          <div className="flex flex-col gap-2">
            <p>
              Senders that apply this policy will refuse to deliver to any mail server it does not cover, and TLS
              failures become delivery failures. The override is recorded in the audit trail.
            </p>
            {hosted?.readiness.blockers.map((blocker) => (
              <p key={blocker.code} className="text-meta text-fg-2">
                {blocker.message}
              </p>
            ))}
          </div>
        }
        confirmLabel="Enforce anyway"
        busy={busy === "override"}
        danger
        error={error}
        testId="hosted-mta-sts-override"
      />
    </section>
  );
}
