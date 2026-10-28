"use client";

/**
 * psa.tsx — the PSA settings board.
 *
 * The product's job here is to file a ticket in the system a technician already
 * has open, under the right customer. That shapes three things:
 *
 * 1. Connecting is proven before it is stored: Save calls the provider, and a
 *    refusal is shown as the provider's own sentence.
 * 2. A client with no mapping is never defaulted to a company. The banner and
 *    the job log exist so "no ticket" is visible rather than silent.
 * 3. Every raw code the API can return is translated here. `/^[A-Z_]+$/` never
 *    reaches the screen.
 */

import { useEffect, useState } from "react";
import { instantLabel } from "@/lib/instant";
import type {
  PsaCompany,
  PsaJobView,
  PsaMappingView,
  PsaOptions,
  PsaProviderName,
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
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { ConfirmDialog } from "@/components/ui/dialog";
import { UpgradeNotice } from "@/components/ui/states";

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
    { key: "resourceServer", label: "Resource server", hint: "https://acme.halopsa.com" },
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
  no_closed_status: "No closed status is chosen in the ticket settings.",
  not_applicable: "There was nothing to do.",
};

const STATUS_WORDS: Record<string, string> = {
  PENDING: "Waiting",
  IN_FLIGHT: "Sending",
  DONE: "Done",
  FAILED: "Failed",
  SKIPPED: "Skipped",
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
  const chosenLabel = PROVIDERS.find((entry) => entry.id === provider)?.label ?? "The PSA";
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

  return (
    <div className="flex flex-col gap-6">
      {error ? <Notice tone="fail" title={error} testId="psa-error" /> : null}
      {notice ? <Notice tone="ok" title={notice} /> : null}

      {!connection ? (
        <div className="flex flex-col gap-4" data-testid="psa-connect">
          <div>
            <h2 className="text-h3 font-bold tracking-[-0.01em] text-fg">Connect your PSA</h2>
            <p className="mt-1 max-w-[72ch] text-ui text-fg-2">
              One PSA per workspace. Once it is connected, map each client to a company in it — a ticket is only ever
              filed under the company its client is mapped to.
            </p>
          </div>

          {psaFeature === false ? (
            <UpgradeNotice
              feature="integrations.psa"
              message={`PSA ticketing is included from ${psaPlanLabel}. Nothing about this workspace changes.`}
              context="You can still send events to your own systems with webhooks."
            />
          ) : null}

          <fieldset className="flex flex-col gap-2" data-testid="psa-providers">
            <legend className="legend">Which PSA?</legend>
            {PROVIDERS.map((entry) => {
              const availability = current.providers.find((candidate) => candidate.provider === entry.id);
              return (
                <label
                  key={entry.id}
                  className={
                    availability?.available
                      ? "flex cursor-pointer items-start gap-3 border border-rule-2 p-3 text-ui hover:border-fg-3"
                      : "flex items-start gap-3 border border-rule-2 bg-paper-3 p-3 text-ui opacity-70"
                  }
                >
                  <input
                    type="radio"
                    name="psa-provider"
                    value={entry.id}
                    data-testid={`psa-provider-${entry.id.toLowerCase()}`}
                    checked={provider === entry.id}
                    disabled={!availability?.available}
                    onChange={() => {
                      setProvider(entry.id);
                      setCredentials({});
                    }}
                    className="mt-1"
                  />
                  <span className="flex flex-col gap-1">
                    <span className="font-semibold text-fg">{entry.label}</span>
                    <span className="text-meta text-fg-2">{entry.needs}</span>
                    <span className="text-meta text-fg-3">
                      {availability?.available ? entry.where : (availability?.reason ?? "Not available on this deployment.")}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          {canManage && chosen?.available ? (
            <div className="flex flex-col gap-3" data-testid="psa-credentials">
              <p className="legend">Credentials</p>
              {FIELDS[provider].map((field) => (
                <label key={field.key} className="flex flex-col gap-1 text-meta text-fg-2">
                  <span className="font-semibold text-fg">
                    {field.label}
                    {field.optional ? <span className="text-fg-3"> (optional)</span> : null}
                  </span>
                  <Input
                    type={field.secret ? "password" : "text"}
                    autoComplete="off"
                    data-testid={`psa-credential-${field.key}`}
                    value={credentials[field.key] ?? ""}
                    placeholder={field.hint}
                    onChange={(event) =>
                      setCredentials((previous) => ({ ...previous, [field.key]: event.target.value }))
                    }
                  />
                </label>
              ))}
              <p className="text-meta text-fg-3">
                Credentials are encrypted before they are stored and are never shown again. A secret field is cleared
                after saving.
              </p>
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
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ui">
            <span className="font-semibold text-fg" data-testid="psa-status">
              {connectedProvider?.label ?? connection.provider}
            </span>
            <span className="text-fg-3">{connection.status === "PAUSED" ? "Paused" : "Connected"}</span>
            <span className="data text-meta text-fg-3">{connection.credentialHint}</span>
            <span className="text-meta text-fg-3">
              {connection.health.lastSuccessAt
                ? `Last success ${instantLabel(connection.health.lastSuccessAt)}`
                : "No successful call yet"}
            </span>
          </div>

          {connection.status === "PAUSED" ? (
            <Notice tone="warn" title="Ticketing is paused">
              <div className="flex flex-col gap-2">
                <p>{connection.pausedReason ?? "An administrator paused it."}</p>
                {canManage ? (
                  <div>
                    <Button data-testid="psa-resume" busy={busy === "enabled"} busyLabel="Resuming" onClick={() => setEnabled(true)}>
                      Resume
                    </Button>
                  </div>
                ) : null}
              </div>
            </Notice>
          ) : null}

          {connection.health.lastError && connection.status === "ACTIVE" ? (
            <Notice tone="fail" title="The last attempt did not reach the PSA">
              {connection.health.lastError}
            </Notice>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button data-testid="psa-test" busy={busy === "test"} busyLabel="Testing" onClick={runTest}>
              Test the connection
            </Button>
            {canManage && connection.status === "ACTIVE" ? (
              <Button data-testid="psa-pause" busy={busy === "enabled"} busyLabel="Pausing" onClick={() => setEnabled(false)}>
                Pause ticketing
              </Button>
            ) : null}
            {canManage ? (
              <Button data-testid="psa-replace" onClick={() => setReplacing((value) => !value)}>
                {replacing ? "Cancel" : "Replace credentials"}
              </Button>
            ) : null}
            {canManage ? (
              <Button
                variant="ghost"
                className="text-fail hover:text-fail"
                data-testid="psa-disconnect"
                onClick={() => setConfirmDisconnect(true)}
              >
                Disconnect
              </Button>
            ) : null}
          </div>

          {replacing && canManage ? (
            <div className="flex flex-col gap-3 border border-rule-2 p-3" data-testid="psa-replace-form">
              <p className="legend">New credentials for {connectedProvider?.label ?? connection.provider}</p>
              {FIELDS[connection.provider].map((field) => (
                <label key={field.key} className="flex flex-col gap-1 text-meta text-fg-2">
                  <span className="font-semibold text-fg">{field.label}</span>
                  <Input
                    type={field.secret ? "password" : "text"}
                    autoComplete="off"
                    data-testid={`psa-replace-${field.key}`}
                    value={credentials[field.key] ?? ""}
                    onChange={(event) =>
                      setCredentials((previous) => ({ ...previous, [field.key]: event.target.value }))
                    }
                  />
                </label>
              ))}
              <div>
                <Button
                  variant="primary"
                  data-testid="psa-replace-save"
                  busy={busy === "replace"}
                  busyLabel="Testing"
                  onClick={replaceCredentials}
                >
                  Test and save
                </Button>
              </div>
            </div>
          ) : null}

          {/* Ticket settings */}
          <div className="flex flex-col gap-3 border-t border-rule pt-3" data-testid="psa-settings">
            <div className="flex flex-wrap items-center gap-3">
              <p className="legend">Ticket settings</p>
              <Button data-testid="psa-load-options" busy={busy === "options"} busyLabel="Reading" onClick={loadOptions}>
                {options ? "Reload from the PSA" : "Read the options from the PSA"}
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-meta text-fg-2">
                <span className="font-semibold text-fg">Board or queue</span>
                <Select
                  data-testid="psa-queue"
                  value={draft.queue}
                  onChange={(event) => setDraft((previous) => ({ ...previous, queue: event.target.value }))}
                >
                  <option value="">Use the provider default</option>
                  {(options?.queues ?? []).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-meta text-fg-2">
                <span className="font-semibold text-fg">Ticket type</span>
                <Select
                  data-testid="psa-type"
                  value={draft.type}
                  onChange={(event) => setDraft((previous) => ({ ...previous, type: event.target.value }))}
                >
                  <option value="">Use the provider default</option>
                  {(options?.ticketTypes ?? []).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-meta text-fg-2">
                <span className="font-semibold text-fg">Open status</span>
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
              </label>
              <label className="flex flex-col gap-1 text-meta text-fg-2">
                <span className="font-semibold text-fg">Closed status</span>
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
              </label>
              <label className="flex flex-col gap-1 text-meta text-fg-2">
                <span className="font-semibold text-fg">Priority</span>
                <Select
                  data-testid="psa-priority"
                  value={draft.priority}
                  onChange={(event) => setDraft((previous) => ({ ...previous, priority: event.target.value }))}
                >
                  <option value="">Use the provider default</option>
                  {(options?.priorities ?? []).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </Select>
              </label>
            </div>

            <div className="flex flex-col gap-2 text-ui text-fg-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  data-testid="psa-close-on-resolve"
                  checked={connection.settings.closeOnResolve}
                  onChange={(event) => {
                    const value = event.target.checked;
                    setCurrent((previous) =>
                      previous.connection
                        ? { ...previous, connection: { ...previous.connection, settings: { ...previous.connection.settings, closeOnResolve: value } } }
                        : previous,
                    );
                    void patchPsa(organizationId, {
                      expectedVersion: connection.version,
                      settings: { closeOnResolve: value },
                    }).then((res) => {
                      if (res.ok) setCurrent(res.data);
                      else failedResult(res);
                    });
                  }}
                />
                Close the ticket when the alert resolves or every DNS change is acknowledged
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  data-testid="psa-ticket-on-alert"
                  checked={connection.settings.ticketOnAlert}
                  onChange={(event) => {
                    const value = event.target.checked;
                    void patchPsa(organizationId, {
                      expectedVersion: connection.version,
                      settings: { ticketOnAlert: value },
                    }).then((res) => {
                      if (res.ok) setCurrent(res.data);
                      else failedResult(res);
                    });
                  }}
                />
                Open a ticket when an alert fires
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  data-testid="psa-ticket-on-dns"
                  checked={connection.settings.ticketOnCriticalDns}
                  onChange={(event) => {
                    const value = event.target.checked;
                    void patchPsa(organizationId, {
                      expectedVersion: connection.version,
                      settings: { ticketOnCriticalDns: value },
                    }).then((res) => {
                      if (res.ok) setCurrent(res.data);
                      else failedResult(res);
                    });
                  }}
                />
                Open a ticket for critical DNS changes
              </label>
            </div>

            {canManage ? (
              <div>
                <Button
                  data-testid="psa-save-settings"
                  variant="primary"
                  busy={busy === "settings"}
                  busyLabel="Saving"
                  onClick={saveSettings}
                >
                  Save the ticket settings
                </Button>
              </div>
            ) : null}
          </div>

          {/* Skipped because unmapped */}
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

          {/* Mappings */}
          <div className="flex flex-col gap-3 border-t border-rule pt-3" data-testid="psa-mappings">
            <div>
              <p className="legend">Clients and companies</p>
              <p className="mt-1 max-w-[72ch] text-meta text-fg-3">
                A ticket is only ever filed under the company its client is mapped to. An unmapped client gets no
                ticket, which is safer than filing under the wrong customer.
              </p>
            </div>

            {mappingRows === null ? (
              <p className="text-ui text-fg-3">The client list could not be read.</p>
            ) : mappingRows.length === 0 ? (
              <p className="text-ui text-fg-3">This workspace has no clients yet.</p>
            ) : (
              <ul className="flex flex-col">
                {mappingRows.map((row) => (
                  <li key={row.clientId} className="flex flex-col gap-2 border-b border-rule py-2">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui">
                      <span className="font-semibold text-fg">{row.clientName}</span>
                      {row.mapping ? (
                        <span className="text-fg-2">→ {row.mapping.externalCompanyName}</span>
                      ) : (
                        <span className="text-fg-3">Not mapped</span>
                      )}
                      {canManage && psaFeature !== false ? (
                        <span className="ml-auto flex gap-2">
                          <button
                            type="button"
                            className="link text-meta"
                            data-testid={`psa-map-${row.clientId}`}
                            onClick={() => {
                              setMappingFor(row.clientId === mappingFor ? null : row.clientId);
                              setCompanyQuery("");
                              setCompanies([]);
                            }}
                          >
                            {row.mapping ? "Change" : "Map"}
                          </button>
                          {row.mapping ? (
                            <button
                              type="button"
                              className="link text-meta text-fail"
                              data-testid={`psa-unmap-${row.clientId}`}
                              onClick={() => unmap(row.clientId)}
                            >
                              Remove
                            </button>
                          ) : null}
                        </span>
                      ) : null}
                    </div>

                    {mappingFor === row.clientId ? (
                      <div className="flex flex-col gap-2 pl-4" data-testid={`psa-search-${row.clientId}`}>
                        <Input
                          aria-label={`Search companies for ${row.clientName}`}
                          data-testid="psa-company-search"
                          value={companyQuery}
                          placeholder="Type at least two characters"
                          onChange={(event) => setCompanyQuery(event.target.value)}
                        />
                        {companies.length > 0 ? (
                          <ul className="flex flex-col border border-rule">
                            {companies.map((company) => (
                              <li key={company.id}>
                                <button
                                  type="button"
                                  data-testid={`psa-company-${company.id}`}
                                  className="block w-full px-2 py-1.5 text-left text-ui text-fg-2 hover:bg-paper-2 hover:text-fg"
                                  onClick={() => mapCompany(row.clientId, company)}
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
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {unmappedCount > 0 ? (
              <p className="text-meta text-fg-3">
                {unmappedCount} {unmappedCount === 1 ? "client is" : "clients are"} not mapped and will not be
                ticketed.
              </p>
            ) : null}
          </div>

          {/* Job log */}
          <div className="flex flex-col gap-3 border-t border-rule pt-3" data-testid="psa-jobs">
            <p className="legend">Recent activity</p>
            {jobRows === null ? (
              <p className="text-ui text-fg-3">The job log could not be read.</p>
            ) : jobRows.length === 0 ? (
              <p className="text-ui text-fg-3">Nothing has been sent to the PSA yet.</p>
            ) : (
              <ul className="flex flex-col">
                {jobRows.map((job) => (
                  <li key={job.id} className="flex flex-col gap-1 border-b border-rule py-2 text-meta">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="font-semibold text-fg">{KIND_WORDS[job.kind] ?? job.kind}</span>
                      <span
                        className={
                          job.status === "FAILED"
                            ? "text-fail"
                            : job.status === "SKIPPED"
                              ? "text-warn"
                              : "text-fg-2"
                        }
                      >
                        {STATUS_WORDS[job.status] ?? job.status}
                      </span>
                      <span className="text-fg-3">{instantLabel(job.createdAt)}</span>
                      {job.ticket?.url ? (
                        <a
                          href={job.ticket.url}
                          className="link"
                          target="_blank"
                          rel="noreferrer noopener"
                          data-testid={`psa-ticket-${job.id}`}
                        >
                          Open the ticket
                        </a>
                      ) : null}
                      {job.status === "FAILED" && canManage ? (
                        <button
                          type="button"
                          className="link ml-auto"
                          data-testid={`psa-retry-${job.id}`}
                          onClick={() => retry(job.id)}
                        >
                          Retry
                        </button>
                      ) : null}
                    </div>
                    {job.skipReason ? (
                      <p className="text-fg-3">{SKIP_WORDS[job.skipReason] ?? "There was nothing to do."}</p>
                    ) : null}
                    {job.lastError ? <p className="text-fail">{job.lastError}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={disconnect}
        title="Disconnect this PSA?"
        body={
          <div className="flex flex-col gap-2">
            <p>
              The connection, the client mappings and the queued work are removed from DMARC Harbor. Nothing new will
              be filed.
            </p>
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
