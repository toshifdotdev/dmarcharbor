"use client";

/**
 * psa.tsx — the PSA settings board.
 *
 * The product's job here is to file a ticket in the system a technician already
 * has open, under the right customer. That shapes the page:
 *
 * 1. The line at the top says whether tickets are getting through, in a word,
 *    with the last successful call as the evidence; the figures below it say
 *    how many tickets are open and how many clients would get none.
 * 2. Connecting is proven before it is stored: Save calls the provider, and a
 *    refusal is shown as the provider's own sentence. The provider's own steps
 *    are drawn beside the credentials.
 * 3. A client with no mapping is never defaulted to a company. The mapping
 *    table comes first once connected, and the job log exists so "no ticket" is
 *    visible rather than silent.
 * 4. Every raw code the API can return is translated here. `/^[A-Z_]+$/` never
 *    reaches the screen.
 *
 * The three ticket triggers apply the moment they are flipped, so they are
 * switches; the queue, type, statuses and priority wait for Save.
 *
 * Test hooks: psa-connect, psa-providers, psa-provider-<id>, psa-credentials,
 * psa-credential-<key>, psa-connect-save, psa-error, psa-status, psa-test,
 * psa-pause, psa-resume, psa-replace, psa-replace-form, psa-replace-<key>,
 * psa-replace-save, psa-disconnect, psa-settings, psa-load-options, psa-queue,
 * psa-type, psa-open-status, psa-closed-status, psa-priority,
 * psa-close-on-resolve, psa-ticket-on-alert, psa-ticket-on-dns,
 * psa-save-settings, psa-skipped, psa-mappings, psa-map-<id>, psa-unmap-<id>,
 * psa-search-<id>, psa-company-search, psa-company-<id>, psa-jobs,
 * psa-ticket-<id>, psa-retry-<id>.
 */

import { useEffect, useState } from "react";
import { clsx } from "clsx";
import { instantLabel } from "@/lib/instant";
import type {
  PsaCompany,
  PsaJobView,
  PsaMappingView,
  PsaOptions,
  PsaProviderName,
  PsaTicketSettings,
  PsaView,
} from "@/lib/types";
import {
  deletePsa,
  getPsaOptions,
  patchPsa,
  removePsaMapping,
  retryPsaJob,
  savePsa,
  searchPsaCompanies,
  setPsaMapping,
  testPsa,
} from "@/lib/ops-client";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/choice";
import { Field, Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Readout, ReadoutStrip } from "@/components/ui/readout";
import { UpgradeNotice } from "@/components/ui/states";
import { Nil, Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { ConnectionLine, SetupSteps, type LineState } from "./lines";
import { Panel } from "./parts";

const PROVIDERS: Array<{
  id: PsaProviderName;
  label: string;
  needs: string;
  where: string;
}> = [
  {
    id: "HALOPSA",
    label: "HaloPSA",
    needs: "Your Halo address, a client ID and a client secret.",
    where:
      "In Halo: Configuration › Integrations › Halo API. Create an application with the “Client ID and Secret (Services)” method and allow read:tickets and edit:tickets.",
  },
  {
    id: "CONNECTWISE",
    label: "ConnectWise PSA",
    needs: "Your site, company ID, and an API member’s public and private key.",
    where:
      "In ConnectWise: System › Members › API Members. An API member does not use a paid seat; generate its key pair there.",
  },
  {
    id: "AUTOTASK",
    label: "Autotask",
    needs: "An API user, its secret, and the integration code.",
    where:
      "In Autotask: create an API-only user with a tracking identifier. If your vendor is not listed, choose “Custom (Internal Integration)”, which generates the code.",
  },
];

const FIELDS: Record<PsaProviderName, Array<{ key: string; label: string; secret?: boolean; optional?: boolean; hint?: string }>> = {
  HALOPSA: [
    { key: "resourceServer", label: "Resource server", hint: "https://your-instance.halopsa.com" },
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client secret", secret: true },
    { key: "authServer", label: "Authorisation server", optional: true, hint: "Defaults to <resource server>/auth" },
    { key: "tenant", label: "Tenant", optional: true, hint: "Only for hosted Halo" },
  ],
  CONNECTWISE: [
    { key: "site", label: "Site hostname", hint: "api-na.myconnectwise.net" },
    { key: "companyId", label: "Company ID" },
    { key: "publicKey", label: "Public key" },
    { key: "privateKey", label: "Private key", secret: true },
  ],
  AUTOTASK: [
    { key: "username", label: "API user" },
    { key: "secret", label: "Secret", secret: true },
    { key: "integrationCode", label: "Integration code" },
  ],
};

const SKIP_WORDS: Record<string, string> = {
  unmapped_client: "The client is not mapped to a PSA company, so no ticket was opened.",
  ticket_not_opened: "The ticket this belongs to was never opened, so there was nothing to add to.",
  source_deleted: "The domain or alert was deleted before the ticket was opened, so none was.",
  no_closed_status: "No closed status is chosen in the ticket settings.",
  not_applicable: "There was nothing to do.",
};

const STATUS_WORDS: Record<string, [string, Tone]> = {
  PENDING: ["Waiting", "neutral"],
  IN_FLIGHT: ["Sending", "accent"],
  DONE: ["Done", "ok"],
  FAILED: ["Failed", "fail"],
  SKIPPED: ["Skipped", "warn"],
};

const KIND_WORDS: Record<string, string> = {
  OPEN: "Open a ticket",
  NOTE: "Add a note",
  CLOSE: "Close the ticket",
};

/** The API's codes, said as sentences. A raw code never reaches the screen. */
function readable(message: string | undefined, fallback: string): string {
  if (!message) return fallback;
  return /^[A-Z_]+$/.test(message.trim()) ? fallback : message;
}

function settingsFrom(view: PsaView): {
  queue: string;
  type: string;
  openStatus: string;
  closedStatus: string;
  priority: string;
} {
  const settings = view.connection?.settings;
  return {
    queue: settings?.ticketQueueId ?? "",
    type: settings?.ticketTypeId ?? "",
    openStatus: settings?.openStatusId ?? "",
    closedStatus: settings?.closedStatusId ?? "",
    priority: settings?.priorityId ?? "",
  };
}

type Trigger = "closeOnResolve" | "ticketOnAlert" | "ticketOnCriticalDns";

export function PsaBoard({
  organizationId,
  view,
  mappings,
  jobs,
  canManage,
  psaFeature,
  psaPlanLabel,
}: {
  organizationId: string;
  view: PsaView;
  mappings: PsaMappingView[] | null;
  jobs: PsaJobView[] | null;
  canManage: boolean;
  psaFeature: boolean | null;
  psaPlanLabel: string;
}) {
  const [current, setCurrent] = useState<PsaView>(view);
  const [mappingRows, setMappingRows] = useState<PsaMappingView[] | null>(mappings);
  const [jobRows, setJobRows] = useState<PsaJobView[] | null>(jobs);

  const [provider, setProvider] = useState<PsaProviderName>("HALOPSA");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [replacing, setReplacing] = useState(false);
  const [options, setOptions] = useState<PsaOptions | null>(null);
  const [draft, setDraft] = useState(settingsFrom(view));

  const [mappingFor, setMappingFor] = useState<string | null>(null);
  const [companyQuery, setCompanyQuery] = useState("");
  const [companies, setCompanies] = useState<PsaCompany[]>([]);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const connection = current.connection;
  const chosen = current.providers.find((entry) => entry.provider === provider);
  const chosenEntry = PROVIDERS.find((entry) => entry.id === provider) ?? PROVIDERS[0];
  const chosenLabel = chosenEntry.label;
  const connectedProvider = connection ? PROVIDERS.find((entry) => entry.id === connection.provider) : null;

  function sync(next: PsaView): void {
    setCurrent(next);
    setDraft(settingsFrom(next));
    setError(null);
    setCredentials({});
    setReplacing(false);
  }

  function failedResult(res: { status: number; error: { message?: string; code?: string } }): void {
    setError(readable(res.error.message, "That did not go through. Nothing changed."));
  }

  async function connect(): Promise<void> {
    setBusy("connect");
    setError(null);
    setNotice(null);
    const res = await savePsa(organizationId, { provider, credentials });
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice(`${chosenLabel} is connected. Now map each client to its company.`);
  }

  async function replaceCredentials(): Promise<void> {
    if (!connection) return;
    setBusy("replace");
    setError(null);
    setNotice(null);
    const res = await savePsa(organizationId, { provider: connection.provider, credentials });
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice("The credentials were tested and saved.");
  }

  async function runTest(): Promise<void> {
    setBusy("test");
    setError(null);
    setNotice(null);
    const res = await testPsa(organizationId);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    setNotice(res.data.detail);
  }

  async function loadOptions(): Promise<void> {
    setBusy("options");
    setError(null);
    const res = await getPsaOptions(organizationId);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    setOptions(res.data);
  }

  async function saveSettings(): Promise<void> {
    if (!connection) return;
    setBusy("settings");
    setError(null);
    setNotice(null);
    const res = await patchPsa(organizationId, {
      expectedVersion: connection.version,
      settings: {
        ticketQueueId: draft.queue || null,
        ticketTypeId: draft.type || null,
        openStatusId: draft.openStatus || null,
        closedStatusId: draft.closedStatus || null,
        priorityId: draft.priority || null,
      },
    });
    setBusy(null);
    if (!res.ok) {
      if (res.error.code === "VERSION_CHANGED" && res.error.view) {
        sync(res.error.view as unknown as PsaView);
      }
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice("Ticket settings saved.");
  }

  /** A trigger applies the moment it is flipped: the same write as before. */
  function applyTrigger(key: Trigger, value: boolean): void {
    if (!connection) return;
    if (key === "closeOnResolve") {
      setCurrent((previous) =>
        previous.connection
          ? { ...previous, connection: { ...previous.connection, settings: { ...previous.connection.settings, closeOnResolve: value } } }
          : previous,
      );
    }
    setBusy(`trigger:${key}`);
    void patchPsa(organizationId, {
      expectedVersion: connection.version,
      settings: { [key]: value } as Partial<PsaTicketSettings>,
    }).then((res) => {
      setBusy(null);
      if (res.ok) setCurrent(res.data);
      else failedResult(res);
    });
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    setBusy("enabled");
    setError(null);
    setNotice(null);
    const res = await patchPsa(organizationId, { enabled });
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    sync(res.data);
    setNotice(
      enabled
        ? "Ticketing resumed. Queued jobs start sending on the next pass."
        : "Ticketing paused. Nothing new is sent until you resume.",
    );
  }

  async function disconnect(): Promise<void> {
    setBusy("disconnect");
    setError(null);
    const res = await deletePsa(organizationId);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    setConfirmDisconnect(false);
    setCurrent({ ...current, connection: null, skippedUnmapped: [], ticketCounts: { open: 0, closed: 0 } });
    setMappingRows((rows) => rows?.map((row) => ({ ...row, mapping: null })) ?? null);
    setJobRows([]);
    setNotice("The PSA was disconnected. Tickets already in it are unchanged.");
  }

  // Company search, debounced: a keystroke per request would spend the
  // workspace's rate limit on typing.
  useEffect(() => {
    if (!mappingFor || companyQuery.trim().length < 2) {
      setCompanies([]);
      return;
    }
    const timer = setTimeout(() => {
      void searchPsaCompanies(organizationId, companyQuery.trim()).then((res) => {
        if (res.ok) setCompanies(res.data.companies);
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [companyQuery, mappingFor, organizationId]);

  async function mapCompany(clientId: string, company: PsaCompany): Promise<void> {
    setBusy(`map:${clientId}`);
    setError(null);
    const res = await setPsaMapping(organizationId, clientId, {
      externalCompanyId: company.id,
      externalCompanyName: company.name,
    });
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    setMappingRows(res.data.mappings);
    setMappingFor(null);
    setCompanyQuery("");
    setCompanies([]);
    setNotice(`${company.name} will receive this client’s tickets.`);
  }

  async function unmap(clientId: string): Promise<void> {
    setBusy(`unmap:${clientId}`);
    setError(null);
    const res = await removePsaMapping(organizationId, clientId);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    setMappingRows(res.data.mappings);
    setNotice("The mapping was removed. New tickets for this client stop; open ones stay open.");
  }

  async function retry(jobId: string): Promise<void> {
    setBusy(`retry:${jobId}`);
    setError(null);
    const res = await retryPsaJob(organizationId, jobId);
    setBusy(null);
    if (!res.ok) {
      failedResult(res);
      return;
    }
    setJobRows(res.data.jobs);
    setNotice("The job is queued again and will be attempted on the next pass.");
  }

  const unmappedCount = mappingRows?.filter((row) => !row.mapping).length ?? 0;
  const mappedCount = mappingRows ? mappingRows.length - unmappedCount : null;
  const skippedTotal = current.skippedUnmapped.reduce((n, entry) => n + entry.count, 0);

  const lineState: LineState = !connection
    ? "none"
    : connection.status === "PAUSED"
      ? "paused"
      : connection.health.lastError
        ? "failing"
        : "live";
  const lineWord = { none: "Not connected", paused: "Paused", failing: "Failing", live: "Connected", unknown: "Unknown" }[lineState];

  // The refusal is shown where it was asked for: beside "Test and connect" while
  // connecting, at the top once connected.
  const errorNotice = error ? <Notice tone="fail" title={error} testId="psa-error" /> : null;
  const credentialsShown = !connection && canManage && Boolean(chosen?.available);

  return (
    <div className="flex flex-col gap-10">
      {credentialsShown ? null : errorNotice}
      {notice ? <Notice tone="ok" title={notice} /> : null}

      {!connection ? (
        <div className="flex flex-col gap-8" data-testid="psa-connect">
          <ConnectionLine
            state="none"
            word="Not connected"
            detail="No tickets are opened. Alerts and DNS changes still reach email, Slack and Teams."
            label="Alerts and DNS changes to your PSA: not connected."
            from={{ name: "Alerts and DNS changes", kind: "in this workspace" }}
            to={{ name: "Your PSA", kind: "HaloPSA, ConnectWise or Autotask" }}
          />

          {psaFeature === false ? (
            <UpgradeNotice
              feature="integrations.psa"
              message={`PSA ticketing is included from ${psaPlanLabel}. Nothing about this workspace changes.`}
              context="You can still send events to your own systems with webhooks."
            />
          ) : null}

          <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
            <div className="flex flex-col gap-6">
              <div>
                <h2 className="text-h3 font-bold tracking-[-0.01em] text-fg">Connect your PSA</h2>
                <p className="mt-0.5 max-w-[72ch] text-ui text-fg-2">
                  One PSA per workspace. Once it is connected, map each client to a company in it: a ticket is only ever
                  filed under the company its client is mapped to.
                </p>
              </div>

              <fieldset className="flex flex-col" data-testid="psa-providers">
                <legend className="mb-1.5 text-meta font-semibold text-fg-2">Which PSA?</legend>
                <div className="border-t border-rule">
                  {PROVIDERS.map((entry) => {
                    const availability = current.providers.find((candidate) => candidate.provider === entry.id);
                    const on = provider === entry.id;
                    return (
                      <label
                        key={entry.id}
                        className={clsx(
                          "relative flex items-start gap-3 border-b border-rule py-3 pl-3 pr-2 text-ui transition-colors duration-100",
                          availability?.available ? "cursor-pointer hover:bg-paper-3/60" : "cursor-not-allowed",
                          on && availability?.available && "before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-fg",
                        )}
                      >
                        <input
                          type="radio"
                          name="psa-provider"
                          value={entry.id}
                          data-testid={`psa-provider-${entry.id.toLowerCase()}`}
                          checked={on}
                          disabled={!availability?.available}
                          onChange={() => {
                            setProvider(entry.id);
                            setCredentials({});
                          }}
                          className="mt-[3px] size-4 shrink-0 accent-[var(--color-fg)]"
                        />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className={clsx("font-bold", availability?.available ? "text-fg" : "text-fg-3")}>{entry.label}</span>
                          <span className="text-meta text-fg-2">
                            {availability?.available ? entry.needs : (availability?.reason ?? "Not available on this deployment.")}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {canManage && chosen?.available ? (
                <div className="flex max-w-[640px] flex-col gap-4" data-testid="psa-credentials">
                  <p className="text-ui font-bold text-fg">{chosenLabel} credentials</p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {FIELDS[provider].map((field) => (
                      <Field
                        key={field.key}
                        label={
                          <>
                            {field.label}
                            {field.optional ? <span className="font-normal text-fg-3"> (optional)</span> : null}
                          </>
                        }
                        className={field.key === "resourceServer" || field.key === "site" ? "sm:col-span-2" : undefined}
                      >
                        <Input
                          type={field.secret ? "password" : "text"}
                          mono={!field.secret && !(field.hint ?? "").includes(" ")}
                          autoComplete="off"
                          spellCheck={false}
                          data-testid={`psa-credential-${field.key}`}
                          value={credentials[field.key] ?? ""}
                          placeholder={field.hint}
                          onChange={(event) => setCredentials((previous) => ({ ...previous, [field.key]: event.target.value }))}
                        />
                      </Field>
                    ))}
                  </div>
                  <p className="text-meta text-fg-3">
                    Credentials are encrypted before they are stored and are never shown again. A secret field is cleared
                    after saving.
                  </p>
                  {errorNotice}
                  <div>
                    <Button
                      variant="primary"
                      data-testid="psa-connect-save"
                      busy={busy === "connect"}
                      busyLabel="Testing"
                      disabled={psaFeature === false}
                      onClick={connect}
                    >
                      Test and connect
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-meta text-fg-3">An owner or admin can connect the PSA for this workspace.</p>
              )}
            </div>

            <SetupSteps
              title={`Getting ${chosenLabel} ready`}
              className="lg:pt-1"
              steps={[
                { key: "where", name: `Create API access in ${chosenLabel}`, detail: chosenEntry.where },
                { key: "needs", name: "Copy what it gives you", detail: chosenEntry.needs },
                { key: "test", name: "Test and connect here", detail: "The PSA is called before anything is stored; a refusal is shown in its own words." },
                { key: "map", name: "Map each client to its company", detail: "A client with no mapping gets no ticket." },
              ]}
            />
          </div>
        </div>
      ) : (
        <>
          <section aria-label="PSA status" className="flex flex-col gap-4">
            <ConnectionLine
              testId="psa-status"
              state={lineState}
              word={lineWord}
              detail={
                connection.health.lastSuccessAt
                  ? `Last successful call ${instantLabel(connection.health.lastSuccessAt)}.`
                  : "No successful call yet."
              }
              label={`Alerts and DNS changes to ${connectedProvider?.label ?? connection.provider}: ${lineWord.toLowerCase()}.`}
              aside={
                <Button size="sm" data-testid="psa-test" busy={busy === "test"} busyLabel="Testing" onClick={runTest}>
                  Test the connection
                </Button>
              }
              from={{ name: "Alerts and DNS changes", kind: "the triggers below" }}
              to={{ name: connectedProvider?.label ?? connection.provider, kind: <span className="data">{connection.credentialHint}</span> }}
            />

            {connection.status === "PAUSED" ? (
              <Notice
                tone="warn"
                title="Ticketing is paused"
                action={
                  canManage ? (
                    <Button size="sm" data-testid="psa-resume" busy={busy === "enabled"} busyLabel="Resuming" onClick={() => setEnabled(true)}>
                      Resume
                    </Button>
                  ) : null
                }
              >
                {connection.pausedReason ?? "An administrator paused it."}
              </Notice>
            ) : null}

            {connection.health.lastError && connection.status === "ACTIVE" ? (
              <Notice tone="fail" title="The last attempt did not reach the PSA">
                {connection.health.lastError}
              </Notice>
            ) : null}

            <ReadoutStrip>
              <Readout label="Tickets open" value={current.ticketCounts.open} note="Filed from this workspace." />
              <Readout label="Tickets closed" value={current.ticketCounts.closed} note="Closed from this workspace." />
              <Readout
                label="Clients mapped"
                value={mappedCount ?? <Nil label="not read" />}
                unit={mappingRows ? `of ${mappingRows.length}` : undefined}
                tone={unmappedCount > 0 ? "warn" : undefined}
                note={unmappedCount > 0 ? `${unmappedCount} get no tickets.` : "Every client has a company."}
              />
              <Readout
                label="Events not ticketed"
                value={skippedTotal}
                tone={skippedTotal > 0 ? "warn" : undefined}
                note={skippedTotal > 0 ? "Their client is not mapped." : "Nothing skipped."}
              />
            </ReadoutStrip>
          </section>

          {current.skippedUnmapped.length > 0 ? (
            <Notice tone="warn" title="Some events were not ticketed" testId="psa-skipped">
              <div className="flex flex-col gap-1">
                {current.skippedUnmapped.map((entry) => (
                  <p key={entry.clientId}>
                    {entry.count} {entry.count === 1 ? "event" : "events"} for {entry.clientName}{" "}
                    {entry.count === 1 ? "was" : "were"} not ticketed because {entry.clientName} is not mapped to a
                    company.
                  </p>
                ))}
              </div>
            </Notice>
          ) : null}

          <div data-testid="psa-mappings">
            <Panel
              id="psa-map-head"
              title="Clients and companies"
              why="A ticket is only ever filed under the company its client is mapped to. An unmapped client gets no ticket, which is safer than filing under the wrong customer."
              aside={mappingRows && mappingRows.length > 0 ? `${mappedCount} of ${mappingRows.length} mapped` : null}
            >
              {mappingRows === null ? (
                <Notice tone="warn" title="The client list could not be read">
                  This is not the same as having no clients. Reload to try again.
                </Notice>
              ) : mappingRows.length === 0 ? (
                <p className="text-ui text-fg-3">This workspace has no clients yet.</p>
              ) : (
                <Table caption="Clients and the PSA company each is filed under" minWidth={560}>
                  <THead>
                    <tr>
                      <Th>Client</Th>
                      <Th>Files tickets under</Th>
                      <Th align="right">
                        <span className="sr-only">Actions</span>
                      </Th>
                    </tr>
                  </THead>
                  <TBody>
                    {mappingRows.map((row) => (
                      <MappingRow
                        key={row.clientId}
                        row={row}
                        open={mappingFor === row.clientId}
                        canEdit={canManage && psaFeature !== false}
                        companies={companies}
                        companyQuery={companyQuery}
                        onQuery={setCompanyQuery}
                        onToggle={() => {
                          setMappingFor(row.clientId === mappingFor ? null : row.clientId);
                          setCompanyQuery("");
                          setCompanies([]);
                        }}
                        onPick={(company) => mapCompany(row.clientId, company)}
                        onUnmap={() => unmap(row.clientId)}
                      />
                    ))}
                  </TBody>
                </Table>
              )}
            </Panel>
          </div>

          <div data-testid="psa-settings">
            <Panel
              id="psa-settings-head"
              title="Ticket settings"
              why="Where tickets land in the PSA and what opens them. The triggers apply at once; the queue, type, statuses and priority wait for Save."
              aside={
                <Button size="sm" data-testid="psa-load-options" busy={busy === "options"} busyLabel="Reading" onClick={loadOptions}>
                  {options ? "Reload from the PSA" : "Read the options from the PSA"}
                </Button>
              }
            >
              <div className="grid gap-x-12 gap-y-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
                <div className="flex flex-col gap-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Board or queue">
                      <Select data-testid="psa-queue" value={draft.queue} onChange={(event) => setDraft((previous) => ({ ...previous, queue: event.target.value }))}>
                        <option value="">Use the provider default</option>
                        {(options?.queues ?? []).map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Ticket type">
                      <Select data-testid="psa-type" value={draft.type} onChange={(event) => setDraft((previous) => ({ ...previous, type: event.target.value }))}>
                        <option value="">Use the provider default</option>
                        {(options?.ticketTypes ?? []).map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Open status">
                      <Select
                        data-testid="psa-open-status"
                        value={draft.openStatus}
                        onChange={(event) => setDraft((previous) => ({ ...previous, openStatus: event.target.value }))}
                      >
                        <option value="">Use the provider default</option>
                        {(options?.openStatuses ?? []).map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Closed status">
                      <Select
                        data-testid="psa-closed-status"
                        value={draft.closedStatus}
                        onChange={(event) => setDraft((previous) => ({ ...previous, closedStatus: event.target.value }))}
                      >
                        <option value="">Do not close tickets</option>
                        {(options?.closedStatuses ?? []).map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Priority">
                      <Select data-testid="psa-priority" value={draft.priority} onChange={(event) => setDraft((previous) => ({ ...previous, priority: event.target.value }))}>
                        <option value="">Use the provider default</option>
                        {(options?.priorities ?? []).map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  {canManage ? (
                    <div>
                      <Button data-testid="psa-save-settings" variant="primary" busy={busy === "settings"} busyLabel="Saving" onClick={saveSettings}>
                        Save the ticket settings
                      </Button>
                    </div>
                  ) : null}
                </div>

                <ul className="flex flex-col border-t border-rule">
                  {(
                    [
                      ["ticketOnAlert", "psa-ticket-on-alert", "Open a ticket when an alert fires", connection.settings.ticketOnAlert],
                      ["ticketOnCriticalDns", "psa-ticket-on-dns", "Open a ticket for critical DNS changes", connection.settings.ticketOnCriticalDns],
                      [
                        "closeOnResolve",
                        "psa-close-on-resolve",
                        "Close the ticket when the alert resolves or every DNS change is acknowledged",
                        connection.settings.closeOnResolve,
                      ],
                    ] as Array<[Trigger, string, string, boolean]>
                  ).map(([key, testId, text, on]) => (
                    <li key={key} className="flex items-start justify-between gap-4 border-b border-rule py-3">
                      <span className="text-ui text-fg">{text}</span>
                      <span data-testid={testId} className="flex shrink-0 items-center gap-2 pt-px">
                        <Switch
                          checked={on}
                          onChange={(next) => applyTrigger(key, next)}
                          busy={busy === `trigger:${key}`}
                          disabled={!canManage}
                          label={text}
                        />
                        <span className="w-[22px] text-meta font-semibold text-fg-2">{on ? "On" : "Off"}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </Panel>
          </div>

          <div data-testid="psa-jobs">
            <Panel id="psa-jobs-head" title="Recent activity" why="What was sent to the PSA, newest first. A skipped job says why no ticket was filed.">
              {jobRows === null ? (
                <Notice tone="warn" title="The job log could not be read">
                  This is not the same as nothing having been sent. Reload to try again.
                </Notice>
              ) : jobRows.length === 0 ? (
                <p className="text-ui text-fg-3">Nothing has been sent to the PSA yet.</p>
              ) : (
                <Table caption="PSA jobs" minWidth={720} dense>
                  <THead>
                    <tr>
                      <Th>When</Th>
                      <Th>What</Th>
                      <Th>Outcome</Th>
                      <Th align="right">
                        <span className="sr-only">Ticket and actions</span>
                      </Th>
                    </tr>
                  </THead>
                  <TBody>
                    {jobRows.map((job) => {
                      const [word, tone] = STATUS_WORDS[job.status] ?? [job.status, "neutral" as Tone];
                      return (
                        <Tr key={job.id} tone={job.status === "FAILED" ? "fail" : job.status === "SKIPPED" ? "warn" : undefined}>
                          <Td className="tnum whitespace-nowrap text-meta">{instantLabel(job.createdAt)}</Td>
                          <Td className="font-semibold">{KIND_WORDS[job.kind] ?? job.kind}</Td>
                          <Td className="max-w-[360px]">
                            <Badge tone={tone}>{word}</Badge>
                            {job.skipReason ? (
                              <span className="mt-0.5 block text-meta text-fg-3">{SKIP_WORDS[job.skipReason] ?? "There was nothing to do."}</span>
                            ) : null}
                            {job.lastError ? <span className="mt-0.5 block break-words text-meta text-fail">{job.lastError}</span> : null}
                          </Td>
                          <Td align="right" className="whitespace-nowrap text-meta">
                            {job.ticket?.url ? (
                              <a href={job.ticket.url} className="link" target="_blank" rel="noreferrer noopener" data-testid={`psa-ticket-${job.id}`}>
                                Open the ticket
                              </a>
                            ) : null}
                            {job.status === "FAILED" && canManage ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="ml-2"
                                data-testid={`psa-retry-${job.id}`}
                                busy={busy === `retry:${job.id}`}
                                busyLabel="Queuing"
                                onClick={() => retry(job.id)}
                              >
                                Retry
                              </Button>
                            ) : null}
                          </Td>
                        </Tr>
                      );
                    })}
                  </TBody>
                </Table>
              )}
            </Panel>
          </div>

          {canManage ? (
            <section aria-labelledby="psa-conn-head" className="flex flex-col gap-3 border-t border-rule pt-5">
              <div>
                <h2 id="psa-conn-head" className="text-h3 font-bold tracking-[-0.01em] text-fg">
                  The connection
                </h2>
                <p className="mt-0.5 max-w-[72ch] text-ui text-fg-2">
                  Pause to stop new tickets for a while, replace the credentials when they are rotated in{" "}
                  {connectedProvider?.label ?? "the PSA"}, or disconnect to remove the connection and its mappings.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {connection.status === "ACTIVE" ? (
                  <Button data-testid="psa-pause" busy={busy === "enabled"} busyLabel="Pausing" onClick={() => setEnabled(false)}>
                    Pause ticketing
                  </Button>
                ) : null}
                <Button data-testid="psa-replace" onClick={() => setReplacing((value) => !value)}>
                  {replacing ? "Cancel" : "Replace credentials"}
                </Button>
                <Button variant="ghost" className="text-fail hover:text-fail" data-testid="psa-disconnect" onClick={() => setConfirmDisconnect(true)}>
                  Disconnect
                </Button>
              </div>

              {replacing ? (
                <div className="flex max-w-[640px] flex-col gap-4 border-t border-rule pt-4" data-testid="psa-replace-form">
                  <p className="text-ui font-bold text-fg">New credentials for {connectedProvider?.label ?? connection.provider}</p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {FIELDS[connection.provider].map((field) => (
                      <Field key={field.key} label={field.label} className={field.key === "resourceServer" || field.key === "site" ? "sm:col-span-2" : undefined}>
                        <Input
                          type={field.secret ? "password" : "text"}
                          mono={!field.secret && !(field.hint ?? "").includes(" ")}
                          autoComplete="off"
                          spellCheck={false}
                          data-testid={`psa-replace-${field.key}`}
                          value={credentials[field.key] ?? ""}
                          onChange={(event) => setCredentials((previous) => ({ ...previous, [field.key]: event.target.value }))}
                        />
                      </Field>
                    ))}
                  </div>
                  <div>
                    <Button variant="primary" data-testid="psa-replace-save" busy={busy === "replace"} busyLabel="Testing" onClick={replaceCredentials}>
                      Test and save
                    </Button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={disconnect}
        title="Disconnect this PSA?"
        body={
          <div className="flex flex-col gap-2">
            <p>The connection, the client mappings and the queued work are removed from this workspace. Nothing new will be filed.</p>
            <p>Tickets already in your PSA are not changed or deleted. They stay where they are.</p>
          </div>
        }
        confirmLabel="Disconnect"
        busy={busy === "disconnect"}
        danger
        error={error}
        testId="psa-disconnect"
      />
    </div>
  );
}

function MappingRow({
  row,
  open,
  canEdit,
  companies,
  companyQuery,
  onQuery,
  onToggle,
  onPick,
  onUnmap,
}: {
  row: PsaMappingView;
  open: boolean;
  canEdit: boolean;
  companies: PsaCompany[];
  companyQuery: string;
  onQuery: (q: string) => void;
  onToggle: () => void;
  onPick: (company: PsaCompany) => void;
  onUnmap: () => void;
}) {
  return (
    <>
      <Tr tone={row.mapping ? undefined : "warn"}>
        <Td className="font-semibold">{row.clientName}</Td>
        <Td>
          {row.mapping ? (
            row.mapping.externalCompanyName
          ) : (
            <Badge tone="warn">
              <span aria-hidden className="size-2 rounded-full border-2 border-warn-mark" />
              Not mapped: no tickets
            </Badge>
          )}
        </Td>
        <Td align="right" className="whitespace-nowrap">
          {canEdit ? (
            <span className="inline-flex items-center gap-1">
              <Button size="sm" variant={row.mapping ? "ghost" : "secondary"} data-testid={`psa-map-${row.clientId}`} onClick={onToggle} aria-expanded={open}>
                {open ? "Cancel" : row.mapping ? "Change" : "Map"}
              </Button>
              {row.mapping ? (
                <Button size="sm" variant="ghost" className="text-fail hover:text-fail" data-testid={`psa-unmap-${row.clientId}`} onClick={onUnmap}>
                  Remove
                </Button>
              ) : null}
            </span>
          ) : null}
        </Td>
      </Tr>
      {open ? (
        <tr className="border-b border-rule">
          <td colSpan={3} className="px-2.5 pb-3 pt-1">
            <div className="flex max-w-[480px] flex-col gap-2" data-testid={`psa-search-${row.clientId}`}>
              <Input
                aria-label={`Search companies for ${row.clientName}`}
                data-testid="psa-company-search"
                value={companyQuery}
                placeholder="Type at least two characters of the company name"
                onChange={(event) => onQuery(event.target.value)}
              />
              {companies.length > 0 ? (
                <ul className="flex flex-col rounded-ctl border border-rule">
                  {companies.map((company) => (
                    <li key={company.id} className="border-b border-rule last:border-b-0">
                      <button
                        type="button"
                        data-testid={`psa-company-${company.id}`}
                        className="block w-full px-3 py-2 text-left text-ui text-fg-2 transition-colors duration-100 hover:bg-paper-3 hover:text-fg"
                        onClick={() => onPick(company)}
                      >
                        {company.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : companyQuery.trim().length >= 2 ? (
                <p className="text-meta text-fg-3">No company matched.</p>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
