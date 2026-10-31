"use client";

/**
 * managed-spf.tsx — the flattened-SPF panel on a domain's setup tab.
 *
 * The customer publishes one apex record that redirects to our zone; the
 * addresses are flattened here and refreshed every six hours. The preview is
 * part of the contract: Save stays disabled until the exact current edits have
 * been flattened and their lookup cost is known.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { instantLabel } from "@/lib/instant";
import type {
  ManagedSpfOutcomeView,
  ManagedSpfPreview,
  ManagedSpfSource,
  ManagedSpfView,
  SpfServiceOption,
} from "@/lib/types";
import {
  checkManagedSpf,
  previewManagedSpf,
  releaseManagedSpf,
  startManagedSpf,
  updateManagedSpf,
} from "@/lib/ops-client";
import { Button } from "@/components/ui/button";
import { CopyValue, DnsRecord } from "@/components/ui/copy";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { UpgradeNotice } from "@/components/ui/states";

type AllQualifier = "-all" | "~all";

const STATUS_WORDS = {
  PENDING: "Waiting for the apex record",
  ACTIVE: "Active",
  RELEASING: "Releasing",
  RELEASED: "Released",
} as const;

function sourceKey(source: ManagedSpfSource): string {
  return `${source.kind}:${source.value}`;
}

function sourceText(source: ManagedSpfSource): string {
  return source.value ? `${source.kind} ${source.value}` : source.kind;
}

function dateLabel(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function outcomeBadge(outcome: ManagedSpfOutcomeView): { text: string; tone: "ok" | "warn" | "fail" | "muted" } {
  if (outcome.mode === "flattened") {
    return {
      text: `Flattened: ${outcome.networks.length} range${outcome.networks.length === 1 ? "" : "s"}`,
      tone: "ok",
    };
  }
  if (outcome.mode === "passthrough") {
    return {
      text: `Passed through: ${outcome.lookups} lookup${outcome.lookups === 1 ? "" : "s"}`,
      tone: "warn",
    };
  }
  if (outcome.networks.length > 0) {
    return {
      text: `Failing since ${dateLabel(outcome.failingSince ?? new Date().toISOString())}: still published with the last good addresses`,
      tone: "warn",
    };
  }
  return {
    text: outcome.mode === "refused" ? "Refused" : "Failed",
    tone: "fail",
  };
}

export function ManagedSpf({
  organizationId,
  domainId,
  domainName,
  view,
  failed,
  canEdit,
  hasFeature,
  spfServices,
  currentSpf,
  brand = "DMARC Harbor",
}: {
  /** The name on this host: the agency's on a verified custom domain. */
  brand?: string;
  organizationId: string;
  domainId: string;
  domainName: string;
  view: ManagedSpfView | null;
  failed: boolean;
  canEdit: boolean;
  /** null when the plan could not be read. */
  hasFeature: boolean | null;
  spfServices: SpfServiceOption[];
  currentSpf: { record: string | null; lookupCount: number | null } | null;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<ManagedSpfView | null>(view);
  const [sources, setSources] = useState<ManagedSpfSource[]>(view?.managed?.sources ?? []);
  const [allQualifier, setAllQualifier] = useState<AllQualifier>(
    view?.managed?.allQualifier === "-all" ? "-all" : "~all",
  );
  const [addKind, setAddKind] = useState<ManagedSpfSource["kind"]>("include");
  const [addValue, setAddValue] = useState("");
  const [preview, setPreview] = useState<ManagedSpfPreview | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorList, setErrorList] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRelease, setConfirmRelease] = useState(false);

  function sync(next: ManagedSpfView): void {
    setCurrent(next);
    if (next.managed) {
      setSources(next.managed.sources);
      setAllQualifier(next.managed.allQualifier === "-all" ? "-all" : "~all");
    } else {
      setSources([]);
      setAllQualifier("~all");
    }
    setPreview(null);
    setPreviewKey(null);
    setErrorList([]);
  }

  function failedResult(res: {
    status: number;
    error: {
      code?: string;
      message?: string;
      outcomes?: ManagedSpfOutcomeView[];
      errors?: string[];
      lookupCount?: number;
      partCount?: number;
    };
  }): void {
    setError(res.error.message ?? "That did not go through. Nothing changed.");
    setErrorList(res.error.errors ?? []);
    if (res.error.code === "VERSION_CHANGED") {
      window.location.reload();
    }
  }

  const editsKey = JSON.stringify({ sources, allQualifier });
  const saveReady = Boolean(preview && previewKey === editsKey);
  const managed = current?.managed ?? null;
  const paused = managed?.paused ?? false;
  const outcomes = preview?.outcomes ?? managed?.outcomes ?? [];

  function outcomeFor(source: ManagedSpfSource): ManagedSpfOutcomeView | null {
    const key = sourceKey(source);
    return outcomes.find((outcome) => sourceKey(outcome.source) === key) ?? null;
  }

  async function start(): Promise<void> {
    setBusy("start");
    setError(null);
    setNotice(null);
    const res = await startManagedSpf(organizationId, domainId);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice("Managed SPF started. Publish the apex record below in place of your existing SPF record.");
    router.refresh();
  }

  async function check(): Promise<void> {
    setBusy("check");
    setError(null);
    setNotice(null);
    const res = await checkManagedSpf(organizationId, domainId);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice(
      res.data.managed?.status === "ACTIVE"
        ? `The apex now redirects to ${brand}.`
        : res.data.managed?.status === "RELEASED"
          ? `The apex no longer references ${brand} and your own record is published.`
          : "Checked just now. Nothing has changed yet.",
    );
    router.refresh();
  }

  async function runPreview(): Promise<void> {
    if (!managed) return;
    setBusy("preview");
    setError(null);
    setErrorList([]);
    setNotice(null);
    const res = await previewManagedSpf(organizationId, domainId, { sources, allQualifier });
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    setPreview(res.data);
    setPreviewKey(editsKey);
  }

  async function save(): Promise<void> {
    if (!managed || !saveReady) return;
    setBusy("save");
    setError(null);
    setErrorList([]);
    setNotice(null);
    const res = await updateManagedSpf(organizationId, domainId, {
      expectedVersion: managed.version,
      sources,
      allQualifier,
    });
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice("The sources were saved and our zone is serving the new addresses.");
    router.refresh();
  }

  async function release(): Promise<void> {
    setBusy("release");
    setError(null);
    setNotice(null);
    const res = await releaseManagedSpf(organizationId, domainId);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setConfirmRelease(false);
    setNotice(
      res.data.managed?.status === "RELEASED"
        ? `Managed SPF stopped at once; the apex never referenced ${brand}.`
        : `Release requested. We keep serving the flattened addresses until the apex stops referencing ${brand}.`,
    );
    router.refresh();
  }

  function addSource(): void {
    const value = addValue.trim();
    if (!value && addKind !== "a" && addKind !== "mx") {
      setError("Enter a value for this source.");
      return;
    }
    setSources((previous) => [...previous, { kind: addKind, value } as ManagedSpfSource]);
    setAddValue("");
    setError(null);
  }

  function removeSource(index: number): void {
    setSources((previous) => previous.filter((_, position) => position !== index));
  }

  const heading = "Managed SPF";

  return (
    <section aria-labelledby="managed-spf-head" className="flex flex-col gap-4 border-b border-rule-2 pb-6">
      <div>
        <h2 id="managed-spf-head" className="text-h3 font-bold tracking-[-0.01em] text-fg">
          {heading}
        </h2>
        {current?.available && !managed ? (
          <p className="mt-1 max-w-[72ch] text-ui text-fg-2">
            Keep SPF under the 10-lookup limit automatically: {brand} resolves your sending services to their
            addresses and keeps them current.
          </p>
        ) : null}
      </div>

      {failed || !current ? (
        <Notice tone="warn" title="The managed SPF state could not be read">
          This is not the same as it being off. Reload the page to try again.
        </Notice>
      ) : !current.available ? (
        <p className="text-ui text-fg-3">Managed SPF is not set up on this deployment.</p>
      ) : !managed ? (
        <div className="flex flex-col gap-3">
          {current.capacity.full ? (
            <Notice tone="warn" title="Hosting is full on this deployment right now">
              Publish the SPF record yourself. Existing managed records keep being served.
            </Notice>
          ) : hasFeature === false ? (
            <UpgradeNotice
              feature="dns.managedSpf"
              message="Managed SPF is included from Harbor. Your current record is unchanged."
              context="You can still publish and maintain the SPF record yourself."
            />
          ) : canEdit ? (
            <div>
              <Button data-testid="spf-start" variant="primary" busy={busy === "start"} busyLabel="Starting" onClick={start}>
                Manage SPF
              </Button>
            </div>
          ) : (
            <p className="text-meta text-fg-3">An owner, admin or analyst can manage SPF for this domain.</p>
          )}
          <div>
            <p className="legend">Current SPF record</p>
            {currentSpf?.record ? (
              <div className="mt-1 flex flex-col gap-1">
                <CopyValue value={currentSpf.record} label="the current SPF record" />
                <p className="text-meta text-fg-3">
                  {currentSpf.lookupCount === null
                    ? "The latest scan did not count its lookups."
                    : `${currentSpf.lookupCount} of the 10 lookups receivers allow.`}
                </p>
              </div>
            ) : (
              <p className="mt-1 text-ui text-fg-3">No SPF record was found in the latest scan.</p>
            )}
          </div>
          {error ? <Notice tone="fail" title={error} /> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ui">
            <span className="font-semibold text-fg">{STATUS_WORDS[managed.status]}</span>
            <span className="text-meta text-fg-3">
              {managed.delegationCheckedAt ? `Last checked ${instantLabel(managed.delegationCheckedAt)}` : "Not checked yet"}
            </span>
            <span className="text-meta text-fg-3">
              Uses {managed.lookupCount} of the 10 lookups receivers allow.
            </span>
          </div>

          {paused ? (
            <Notice tone="warn" title="Your plan no longer includes managed SPF">
              The current addresses keep being published and refreshed; changes are paused. Release is still available.
            </Notice>
          ) : null}
          {managed.capacityBlocked ? (
            <Notice tone="fail" title="The hosted zone is full, so the last published addresses are being kept">
              Remove another hosted record to make room for new parts.
            </Notice>
          ) : null}
          {managed.lastFlattenError ? (
            <Notice tone="fail" title={`The last refresh did not publish: ${managed.lastFlattenError}`} />
          ) : null}
          {notice ? <Notice tone="ok" title={notice} /> : null}
          {error ? <Notice tone="fail" title={error} /> : null}
          {errorList.length > 0 ? (
            <ul className="list-disc pl-4 text-meta text-fail">
              {errorList.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}

          {managed.status === "PENDING" ? (
            <div className="flex flex-col gap-3">
              <DnsRecord
                type="TXT"
                host={domainName}
                zone={domainName}
                value={managed.apex.value}
                testId="spf-apex"
              />
              <p className="max-w-[72ch] text-ui text-fg-2">
                Replace your existing SPF record with this one. A domain must publish only one SPF record.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button data-testid="spf-check" busy={busy === "check"} busyLabel="Checking" onClick={check}>
                  Check now
                </Button>
                {canEdit ? (
                  <Button
                    data-testid="spf-release"
                    variant="ghost"
                    className="text-fail hover:text-fail"
                    onClick={() => setConfirmRelease(true)}
                  >
                    Stop managing
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {managed.status === "RELEASING" && managed.republish ? (
            <div className="flex flex-col gap-3">
              <DnsRecord
                type="TXT"
                host={domainName}
                zone={domainName}
                value={managed.republish.value}
                testId="spf-republish"
              />
              <p className="text-ui text-fg-2">
                This record needs {managed.republish.lookupCount} lookup
                {managed.republish.lookupCount === 1 ? "" : "s"}; receivers allow 10.
              </p>
              {managed.republish.overLimit ? (
                <Notice tone="fail" title={`This record needs ${managed.republish.lookupCount} lookups; receivers allow 10.`}>
                  Reduce the sources before you publish it at your DNS host.
                </Notice>
              ) : null}
              <p className="max-w-[72ch] text-ui text-fg-2">Remove our record reference at the same time.</p>
              <div className="flex flex-wrap items-center gap-3">
                <Button data-testid="spf-check" busy={busy === "check"} busyLabel="Checking" onClick={check}>
                  Check now
                </Button>
                {canEdit ? (
                  <Button
                    data-testid="spf-release"
                    variant="ghost"
                    className="text-fail hover:text-fail"
                    onClick={() => setConfirmRelease(true)}
                  >
                    Stop managing
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {managed.status === "RELEASED" ? (
            <div className="flex flex-col gap-3">
              <p className="text-ui text-fg-2">
                This domain no longer reads its SPF record from {brand}. The TXT you published at the apex is the
                record receivers use.
              </p>
              {canEdit && hasFeature !== false && !current.capacity.full ? (
                <div>
                  <Button data-testid="spf-start" busy={busy === "start"} busyLabel="Starting" onClick={start}>
                    Manage SPF again
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {managed.status === "ACTIVE" || managed.status === "RELEASING" || managed.status === "RELEASED" ? (
            <div className="flex flex-col gap-3">
              {managed.status !== "RELEASING" ? (
                <div className="flex flex-wrap items-center gap-3">
                  <Button data-testid="spf-check" busy={busy === "check"} busyLabel="Checking" onClick={check}>
                    Check now
                  </Button>
                  {managed.status === "ACTIVE" && canEdit ? (
                    <Button
                      data-testid="spf-release"
                      variant="ghost"
                      className="text-fail hover:text-fail"
                      onClick={() => setConfirmRelease(true)}
                    >
                      Stop managing
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {managed.status === "ACTIVE" && canEdit && !paused ? (
                <div className="flex flex-col gap-3 border-t border-rule pt-3">
                  <div className="flex flex-wrap items-end gap-2">
                    <Select
                      aria-label="Add a known sending service"
                      data-testid="spf-add-service"
                      value=""
                      onChange={(event) => {
                        const value = event.target.value;
                        if (!value) return;
                        setSources((previous) =>
                          previous.some((source) => source.kind === "include" && source.value === value)
                            ? previous
                            : [...previous, { kind: "include", value }],
                        );
                      }}
                    >
                      <option value="">Add a service…</option>
                      {spfServices.map((service) => (
                        <option key={service.id} value={service.include}>
                          {service.name}
                        </option>
                      ))}
                    </Select>
                    <Select
                      aria-label="Source kind"
                      data-testid="spf-add-kind"
                      value={addKind}
                      onChange={(event) => setAddKind(event.target.value as ManagedSpfSource["kind"])}
                    >
                      <option value="include">include</option>
                      <option value="ip4">ip4</option>
                      <option value="ip6">ip6</option>
                      <option value="a">a</option>
                      <option value="mx">mx</option>
                    </Select>
                    <Input
                      aria-label="Source value"
                      data-testid="spf-add-value"
                      value={addValue}
                      onChange={(event) => setAddValue(event.target.value)}
                      placeholder={addKind === "a" || addKind === "mx" ? "this domain" : "value"}
                    />
                    <Button data-testid="spf-add" onClick={addSource}>
                      Add
                    </Button>
                  </div>

                  <div data-testid="spf-sources" className="flex flex-col">
                    {sources.length === 0 ? (
                      <p className="text-ui text-fg-3">No sources yet. Add the services that send mail for this domain.</p>
                    ) : null}
                    {sources.map((source, index) => {
                      const outcome = outcomeFor(source);
                      const badge = outcome ? outcomeBadge(outcome) : null;
                      return (
                        <div
                          key={`${sourceKey(source)}-${index}`}
                          className="flex flex-col gap-1 border-b border-rule py-2"
                        >
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui">
                            <span className="data font-semibold text-fg">{sourceText(source)}</span>
                            {badge ? (
                              <span
                                className={
                                  badge.tone === "ok"
                                    ? "text-meta text-ok"
                                    : badge.tone === "fail"
                                      ? "text-meta text-fail"
                                      : "text-meta text-warn"
                                }
                              >
                                {badge.text}
                              </span>
                            ) : (
                              <span className="text-meta text-fg-3">Not previewed</span>
                            )}
                            {canEdit ? (
                              <button
                                type="button"
                                className="link ml-auto text-meta"
                                data-testid={`spf-remove-${index}`}
                                onClick={() => removeSource(index)}
                              >
                                Remove
                              </button>
                            ) : null}
                          </div>
                          {outcome?.reason ? <p className="text-meta text-fg-3">{outcome.reason}</p> : null}
                        </div>
                      );
                    })}
                  </div>

                  <label className="flex flex-wrap items-center gap-2 text-ui text-fg-2">
                    Final all
                    <Select
                      data-testid="spf-all"
                      value={allQualifier}
                      onChange={(event) => setAllQualifier(event.target.value as AllQualifier)}
                    >
                      <option value="-all">-all (recommended once every sender is listed)</option>
                      <option value="~all">~all (soft fail)</option>
                    </Select>
                  </label>

                  <div className="flex flex-wrap items-center gap-3">
                    <Button data-testid="spf-preview" busy={busy === "preview"} busyLabel="Previewing" onClick={runPreview}>
                      Preview
                    </Button>
                    <Button
                      data-testid="spf-save"
                      variant="primary"
                      disabled={!saveReady || busy !== null}
                      busy={busy === "save"}
                      busyLabel="Saving"
                      onClick={save}
                    >
                      Save
                    </Button>
                    {preview && !saveReady ? (
                      <span className="text-meta text-fg-3">Preview the current edits before saving.</span>
                    ) : null}
                  </div>

                  {preview ? (
                    <div className="border border-rule bg-paper-2 p-3 text-ui text-fg-2">
                      <p className="font-semibold text-fg">
                        Uses {preview.lookupCount} of 10 lookups. {preview.parts.length} part
                        {preview.parts.length === 1 ? "" : "s"}.
                      </p>
                      <p className="mt-1 text-meta text-fg-3">
                        {preview.ip4Count} IPv4 range{preview.ip4Count === 1 ? "" : "s"}, {preview.ip6Count} IPv6 range
                        {preview.ip6Count === 1 ? "" : "s"}.
                      </p>
                      {preview.errors.length > 0 ? (
                        <ul className="mt-2 list-disc pl-4 text-meta text-fail">
                          {preview.errors.map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {managed.parts.length > 0 ? (
                <details className="border-t border-rule pt-3">
                  <summary className="cursor-pointer legend">What we publish</summary>
                  <div className="mt-2 flex flex-col gap-3">
                    {managed.parts.map((part) => (
                      <div key={part.name}>
                        <p className="data text-meta font-semibold text-fg">{part.name}</p>
                        <pre className="data mt-1 overflow-x-auto whitespace-pre-wrap break-all text-meta text-fg-2">
                          {part.content}
                        </pre>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}

              {managed.changes.length > 0 ? (
                <div className="flex flex-col gap-2 border-t border-rule pt-3">
                  <p className="legend">History</p>
                  <ul className="flex flex-col">
                    {managed.changes.map((change) => (
                      <li key={change.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule py-2 text-meta">
                        <span className="font-semibold capitalize text-fg">{change.reason}</span>
                        <span className="text-fg-3">{instantLabel(change.createdAt)}</span>
                        <span className="text-fg-3">{change.actor?.name ?? "system"}</span>
                        {change.added.length > 0 ? (
                          <span className="text-ok">added {change.added.join(", ")}</span>
                        ) : null}
                        {change.removed.length > 0 ? (
                          <span className="text-fail">removed {change.removed.join(", ")}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={confirmRelease}
        onClose={() => setConfirmRelease(false)}
        onConfirm={release}
        title="Stop managing this SPF record?"
        body={
          <div className="flex flex-col gap-2">
            <p>
              Publish the unflattened record at your DNS host and remove our redirect at the same time. We keep serving
              until a check sees the apex no longer references {brand}.
            </p>
            {managed?.status === "PENDING" ? <p>This record was never delegated, so it is removed at once.</p> : null}
          </div>
        }
        confirmLabel="Stop managing"
        busy={busy === "release"}
        danger
        error={error}
      />
    </section>
  );
}
