"use client";

/**
 * hosted-dmarc.tsx — the CNAME delegation panel on a domain's setup tab.
 *
 * One record at the customer's DNS points _dmarc at our zone; every later
 * policy change happens here. Values arrive from the API and are shown as
 * plain text, never rendered as HTML.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { instantLabel } from "@/lib/instant";
import type { ApiErrorBody, HostedDmarcView } from "@/lib/types";
import {
  checkHostedDmarc,
  releaseHostedDmarc,
  restoreHostedDmarc,
  startHostedDmarc,
  updateHostedDmarc,
} from "@/lib/ops-client";
import { Button } from "@/components/ui/button";
import { CopyValue } from "@/components/ui/copy";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { UpgradeNotice } from "@/components/ui/states";
import { DnsHandoff } from "./dns-handoff";

type Policy = "none" | "quarantine" | "reject";
const POLICIES: Policy[] = ["none", "quarantine", "reject"];

const STATUS_WORDS = {
  PENDING: "Waiting for the CNAME",
  ACTIVE: "Active",
  RELEASING: "Releasing",
  RELEASED: "Released",
} as const;

export function HostedDmarc({
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
  view: HostedDmarcView | null;
  failed: boolean;
  canEdit: boolean;
  /** null when the plan could not be read. */
  hasFeature: boolean | null;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<HostedDmarcView | null>(view);
  const [policy, setPolicy] = useState<Policy>((view?.hosted?.policy.p as Policy | undefined) ?? "none");
  const [testing, setTesting] = useState(view?.hosted?.policy.testing ?? false);
  const [np, setNp] = useState<Policy | "">((view?.hosted?.policy.np as Policy | null | undefined) ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<string[] | null>(null);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [confirmOverride, setConfirmOverride] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  function sync(next: HostedDmarcView): void {
    setCurrent(next);
    if (next.hosted) {
      setPolicy(next.hosted.policy.p as Policy);
      setTesting(next.hosted.policy.testing);
      setNp((next.hosted.policy.np as Policy | null) ?? "");
    }
  }

  function failedResult(res: { status: number; error: ApiErrorBody["error"] }): void {
    setError(res.error.message ?? "That did not go through. Nothing changed.");
    if (res.error.blockers) setBlockers(res.error.blockers);
    if (res.error.code === "VERSION_CHANGED") {
      if (res.error.view && "hosted" in res.error.view) sync(res.error.view);
      router.refresh();
    }
  }

  async function start(): Promise<void> {
    setBusy("start");
    setError(null);
    setNotice(null);
    const res = await startHostedDmarc(organizationId, domainId);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice("Hosting started. Publish the CNAME below and remove the TXT at _dmarc.");
    router.refresh();
  }

  async function check(): Promise<void> {
    setBusy("check");
    setError(null);
    setNotice(null);
    const res = await checkHostedDmarc(organizationId, domainId);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice(
      res.data.hosted?.status === "ACTIVE"
        ? "The CNAME is in place. This domain now reads its DMARC record from DMARC Harbor."
        : res.data.hosted?.status === "RELEASED"
          ? "The CNAME is gone and your TXT is published. This domain no longer reads from DMARC Harbor."
          : "Checked just now. Nothing has changed yet.",
    );
    router.refresh();
  }

  async function save(override = false): Promise<void> {
    if (!current?.hosted) return;
    setBusy(override ? "override" : "save");
    setError(null);
    setNotice(null);
    setBlockers(null);
    const res = await updateHostedDmarc(organizationId, domainId, {
      expectedVersion: current.hosted.version,
      policy,
      testing,
      np: np === "" ? null : np,
      ...(override ? { override: true } : {}),
    });
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setConfirmOverride(false);
    setNotice(res.data.action === "unchanged" ? "That is already the policy being served." : "Policy published.");
    router.refresh();
  }

  async function release(): Promise<void> {
    setBusy("release");
    setError(null);
    setNotice(null);
    const res = await releaseHostedDmarc(organizationId, domainId);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setConfirmRelease(false);
    setNotice(
      res.data.hosted?.status === "RELEASED"
        ? "Hosting stopped at once; the record was never delegated."
        : "Release requested. We keep serving your record until a scan sees the CNAME is gone.",
    );
    router.refresh();
  }

  async function restore(changeId: string): Promise<void> {
    if (!current?.hosted) return;
    setBusy(`restore-${changeId}`);
    setError(null);
    setNotice(null);
    const res = await restoreHostedDmarc(organizationId, domainId, changeId, current.hosted.version);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setRestoring(null);
    setNotice("The earlier value is being served again.");
    router.refresh();
  }

  const hosted = current?.hosted ?? null;
  const paused = hosted?.paused ?? false;
  const heading = "Hosted DMARC record";

  return (
    <section aria-labelledby="hosted-dmarc-head" className="flex flex-col gap-4 border-b border-rule-2 pb-6">
      <div>
        <h2 id="hosted-dmarc-head" className="text-h3 font-bold tracking-[-0.01em] text-fg">
          {heading}
        </h2>
        {current?.available ? (
          <p className="mt-1 max-w-[72ch] text-ui text-fg-2">
            Point _dmarc at DMARC Harbor once, and change the policy here from then on. Your current record is kept as it
            is.
          </p>
        ) : null}
      </div>

      {failed || !current ? (
        <Notice tone="warn" title="The hosted DMARC state could not be read">
          This is not the same as it being off. Reload the page to try again.
        </Notice>
      ) : !current.available ? (
        <p className="text-ui text-fg-3">Hosted DMARC records are not set up on this deployment.</p>
      ) : !hosted ? (
        <div className="flex flex-col gap-3">
          {current.capacity.full ? (
            <Notice tone="warn" title="Hosting is full on this deployment right now">
              Publish the TXT record yourself. Existing hosted records keep being served.
            </Notice>
          ) : hasFeature === false ? (
            <UpgradeNotice
              feature="dns.hosted"
              message="Hosted DMARC records are included from Fairway. Your current record is unchanged."
              context="You can still publish and maintain the DMARC record yourself."
            />
          ) : canEdit ? (
            <div>
              <Button variant="primary" data-testid="hosted-start" busy={busy === "start"} busyLabel="Starting" onClick={start}>
                Host this record
              </Button>
            </div>
          ) : (
            <p className="text-meta text-fg-3">An owner, admin or analyst can start hosting this record.</p>
          )}
          {error ? <Notice tone="fail" title={error} /> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ui">
            <span className="font-semibold text-fg">{STATUS_WORDS[hosted.status]}</span>
            <span className="text-meta text-fg-3">
              {hosted.delegationCheckedAt ? `Last checked ${instantLabel(hosted.delegationCheckedAt)}` : "Not checked yet"}
            </span>
            {hosted.lastSyncedAt ? (
              <span className="text-meta text-fg-3">Last written to our zone {instantLabel(hosted.lastSyncedAt)}</span>
            ) : null}
          </div>

          {paused ? (
            <Notice tone="warn" title="Your plan no longer includes hosted records">
              The last value keeps being served; changes are paused. Stop hosting is still available.
            </Notice>
          ) : null}
          {hosted.lastSyncError ? <Notice tone="fail" title={`Our DNS zone refused the last write: ${hosted.lastSyncError}`} /> : null}
          {notice ? <Notice tone="ok" title={notice} /> : null}
          {error ? <Notice tone="fail" title={error} /> : null}

          {hosted.status === "PENDING" ? (
            <div className="flex flex-col gap-3">
              <DnsHandoff
                domain={domainName}
                records={[
                  {
                    purpose: "Delegate the DMARC record to DMARC Harbor",
                    host: hosted.cname.host,
                    type: "CNAME",
                    value: hosted.cname.target,
                    testId: "hosted-cname",
                  },
                ]}
              />
              <p className="max-w-[72ch] text-ui text-fg-2">
                Remove the existing TXT record at _dmarc in the same edit. A name cannot hold a CNAME and a TXT record.
              </p>
              <ServedValue value={hosted.value} />
              <div className="flex flex-wrap items-center gap-3">
                <Button data-testid="hosted-check" busy={busy === "check"} busyLabel="Checking" onClick={check}>
                  Check now
                </Button>
                {canEdit ? (
                  <Button data-testid="hosted-release" variant="ghost" className="text-fail hover:text-fail" onClick={() => setConfirmRelease(true)}>
                    Stop hosting
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {hosted.status === "ACTIVE" ? (
            <div className="flex flex-col gap-3">
              <ServedValue value={hosted.value} />
              <div className="flex flex-wrap items-center gap-3">
                <Button data-testid="hosted-check" busy={busy === "check"} busyLabel="Checking" onClick={check}>
                  Check now
                </Button>
                {canEdit ? (
                  <Button data-testid="hosted-release" variant="ghost" className="text-fail hover:text-fail" onClick={() => setConfirmRelease(true)}>
                    Stop hosting
                  </Button>
                ) : null}
              </div>

              {canEdit && !paused ? (
                <div className="flex flex-col gap-3 border-t border-rule pt-3">
                  <p className="legend">Policy</p>
                  <div role="radiogroup" aria-label="DMARC policy" className="flex flex-wrap gap-4 text-ui">
                    {POLICIES.map((value) => (
                      <label key={value} className="flex items-center gap-1.5">
                        <input
                          type="radio"
                          name="hosted-policy"
                          value={value}
                          checked={policy === value}
                          onChange={() => setPolicy(value)}
                          data-testid={`hosted-policy-${value}`}
                        />
                        {value}
                      </label>
                    ))}
                  </div>
                  <label className="flex items-center gap-2 text-ui text-fg-2">
                    <input type="checkbox" checked={testing} onChange={(event) => setTesting(event.target.checked)} data-testid="hosted-testing" />
                    testing (t=y)
                  </label>
                  <label className="flex flex-wrap items-center gap-2 text-ui text-fg-2">
                    np= (non-existent subdomains)
                    <Select data-testid="hosted-np" value={np} onChange={(event) => setNp(event.target.value as Policy | "")}>
                      <option value="">same as p</option>
                      {POLICIES.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <p className="text-meta text-fg-3">
                    From p={hosted.policy.p}
                    {hosted.policy.testing ? " (testing)" : ""}
                    {hosted.policy.np ? ` np=${hosted.policy.np}` : ""} to p={policy}
                    {testing ? " (testing)" : ""}
                    {np ? ` np=${np}` : ""}.
                  </p>
                  <div>
                    <Button data-testid="hosted-save" variant="primary" busy={busy === "save"} busyLabel="Publishing" onClick={() => save(false)}>
                      Publish policy
                    </Button>
                  </div>
                  {blockers ? (
                    <Notice tone="fail" title="This policy is not ready">
                      <ul className="list-disc pl-4">
                        {blockers.map((blocker) => (
                          <li key={blocker}>{blocker}</li>
                        ))}
                      </ul>
                      <div className="mt-2">
                        <Button data-testid="hosted-override" onClick={() => setConfirmOverride(true)}>
                          Publish anyway
                        </Button>
                      </div>
                    </Notice>
                  ) : null}
                </div>
              ) : null}

              {paused && canEdit ? (
                <div>
                  <Button data-testid="hosted-release" variant="ghost" className="text-fail hover:text-fail" onClick={() => setConfirmRelease(true)}>
                    Stop hosting
                  </Button>
                </div>
              ) : null}

              {hosted.changes.length > 0 ? (
                <div className="flex flex-col gap-2 border-t border-rule pt-3">
                  <p className="legend">Changes</p>
                  <ul className="flex flex-col">
                    {hosted.changes.map((change) => (
                      <li key={change.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule py-2 text-meta">
                        <span className="font-semibold capitalize text-fg">{change.reason}</span>
                        <span className="text-fg-3">{instantLabel(change.createdAt)}</span>
                        <span className="text-fg-3">{change.actor?.name ?? "system"}</span>
                        <span className="data min-w-0 flex-1 truncate text-fg-2" title={change.newValue}>
                          {change.previousValue ? `${change.previousValue} → ` : ""}
                          {change.newValue}
                        </span>
                        {change.readinessOverride ? <span className="text-warn">overridden readiness</span> : null}
                        {change.restoredAt ? <span className="text-fg-3">restored</span> : null}
                        {canEdit && change.restorable ? (
                          <button
                            type="button"
                            className="link text-meta"
                            data-testid={`hosted-restore-${change.id}`}
                            onClick={() => setRestoring(change.id)}
                          >
                            Put this back
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

          {hosted.status === "RELEASING" ? (
            <div className="flex flex-col gap-3">
              {hosted.republish ? (
                <DnsHandoff
                  domain={domainName}
                  records={[
                    {
                      purpose: "Keep DMARC working while you remove the CNAME",
                      host: hosted.republish.host,
                      type: "TXT",
                      value: hosted.republish.value,
                      testId: "hosted-republish",
                    },
                  ]}
                />
              ) : null}
              <p className="max-w-[72ch] text-ui text-fg-2">
                Remove the CNAME at the same time. We keep serving the record until a scan sees the CNAME is gone.
              </p>
              {hosted.releaseBlocked === "no_record_published" ? (
                <Notice tone="warn" title="Nothing is published at _dmarc yet">
                  We keep serving your record until a TXT record appears there.
                </Notice>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button data-testid="hosted-check" busy={busy === "check"} busyLabel="Checking" onClick={check}>
                  Check now
                </Button>
              </div>
            </div>
          ) : null}

          {hosted.status === "RELEASED" ? (
            <p className="text-ui text-fg-2">
              This domain no longer reads its DMARC record from DMARC Harbor. The TXT you published at _dmarc is the
              record receivers use.
            </p>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={confirmRelease}
        onClose={() => setConfirmRelease(false)}
        onConfirm={release}
        title="Stop hosting this DMARC record?"
        body={
          <div className="flex flex-col gap-2">
            <p>
              Publish the TXT record below at _dmarc and remove the CNAME in the same edit. We keep serving until a scan
              sees the CNAME is gone; then our copy is removed.
            </p>
            {hosted?.status === "PENDING" ? <p>This record has never been delegated, so it is removed at once.</p> : null}
          </div>
        }
        confirmLabel="Stop hosting"
        busy={busy === "release"}
        danger
        error={error}
      />

      <ConfirmDialog
        open={confirmOverride}
        onClose={() => setConfirmOverride(false)}
        onConfirm={() => save(true)}
        title="Publish a policy that is not ready?"
        body={
          <div className="flex flex-col gap-2">
            {blockers?.map((blocker) => (
              <p key={blocker}>{blocker}</p>
            ))}
            <p className="font-semibold text-fg">Publishing anyway can quarantine or reject legitimate mail.</p>
          </div>
        }
        confirmLabel="Publish anyway"
        busy={busy === "override"}
        danger
        error={error}
      />

      <ConfirmDialog
        open={restoring !== null}
        onClose={() => setRestoring(null)}
        onConfirm={() => restoring && restore(restoring)}
        title="Put the earlier value back?"
        body={<p>Receivers start using it as soon as our zone answers with it. This does not change your CNAME.</p>}
        confirmLabel="Put this back"
        busy={restoring !== null && busy === `restore-${restoring}`}
        error={error}
      />
    </section>
  );
}

function ServedValue({ value }: { value: string }) {
  return (
    <div>
      <p className="legend">DMARC record we serve</p>
      <CopyValue value={value} label="the served DMARC record" className="mt-1" />
    </div>
  );
}
