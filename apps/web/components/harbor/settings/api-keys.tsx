"use client";

/**
 * api-keys.tsx — issuing keys for the public API, and revoking them.
 *
 * Revocation is the decision that matters. A key acts with this workspace's
 * data for as long as it exists, so the page leads with the figures that pick
 * out the keys to revoke (never used, able to change data, about to expire),
 * then the live keys with when each was last used: a key nobody has used in
 * months is a key nobody will miss. Revoking is immediate and permanent, and
 * the confirmation says what stops.
 *
 * Issuing: the full key comes back once (only its hash is stored), so it is
 * shown once, with the API's own warning, until the person says it is stored.
 * There is no rotate endpoint; rotation is issue, switch, revoke, and the page
 * draws those three stops rather than offering a button that does less than
 * it claims.
 *
 * Test hooks: key-name, key-create, key-issued, key-dismiss, key-revoke.
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createApiKeyClient, deleteAllRevokedApiKeys, deleteApiKeyRecord, revokeApiKeyClient } from "@/lib/ops-client";
import type { FeatureStatus } from "@/lib/entitlements";
import type { IssuedApiKey } from "@/lib/types";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Readout, ReadoutStrip } from "@/components/ui/readout";
import { UpgradeNotice } from "@/components/ui/states";
import { Table, TBody, Td, TEmptyRow, Th, THead, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { SetupSteps } from "./lines";
import { OnceSecret, Panel } from "./parts";

export interface KeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: Array<"read" | "write">;
  state: "live" | "revoked" | "expired";
  createdLabel: string | null;
  lastUsedLabel: string | null;
  lastUsedIp: string | null;
  expiresLabel: string | null;
  /** Whole days until expiry, for live keys that have a date. */
  daysLeft: number | null;
  endedLabel: string | null;
}

const EXPIRY = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year (the default)" },
  { days: 1095, label: "3 years (the longest allowed)" },
];

function scopeWords(scopes: Array<"read" | "write">) {
  return scopes.includes("write") ? "Read and change" : "Read only";
}

export function ApiKeysBoard({
  organizationId,
  keys,
  issuing,
  canIssue,
}: {
  organizationId: string;
  keys: KeyView[];
  /** Whether the plan carries api.access; null when the plan was unreadable. */
  issuing: FeatureStatus;
  /** Owner only: issuing a key and erasing a revoked key's record. */
  canIssue: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const live = keys.filter((k) => k.state === "live");
  const ended = keys.filter((k) => k.state !== "live");
  const neverUsed = live.filter((k) => !k.lastUsedLabel).length;
  const canWrite = live.filter((k) => k.scopes.includes("write")).length;
  const expiringSoon = live.filter((k) => k.daysLeft !== null && k.daysLeft <= 30).length;

  const [name, setName] = useState("");
  const [read, setRead] = useState(true);
  const [write, setWrite] = useState(false);
  const [days, setDays] = useState(365);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);

  const [revoking, setRevoking] = useState<KeyView | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState<string | null>(null);

  const scopes: Array<"read" | "write"> = [...(read ? (["read"] as const) : []), ...(write ? (["write"] as const) : [])];
  const nameOk = name.trim().length >= 3;

  async function issue(e: FormEvent) {
    e.preventDefault();
    if (busy || !nameOk || scopes.length === 0) return;
    setBusy(true);
    setError(null);
    const res = await createApiKeyClient(organizationId, { name: name.trim(), scopes, expiresInDays: days });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setIssued(res.data);
    setName("");
    setWrite(false);
    setRead(true);
    // The list re-reads beneath the panel; the panel is client state and stays.
    router.refresh();
  }

  async function revoke() {
    if (!revoking) return;
    setRevokeBusy(true);
    setRevokeError(null);
    const res = await revokeApiKeyClient(organizationId, revoking.id);
    setRevokeBusy(false);
    if (!res.ok && res.status !== 404) {
      setRevokeError(res.error.message ?? "The key could not be revoked.");
      return;
    }
    toast({ title: `${revoking.name} is revoked`, body: "Requests with it are refused from now on.", tone: "ok" });
    setRevoking(null);
    router.refresh();
  }

  async function removeRecord(k: KeyView) {
    const res = await deleteApiKeyRecord(organizationId, k.id);
    if (!res.ok) {
      setCleanup(res.error.message ?? "The record could not be removed.");
      return;
    }
    router.refresh();
  }

  async function removeAllEnded() {
    const res = await deleteAllRevokedApiKeys(organizationId);
    if (!res.ok) {
      setCleanup(res.error.message ?? "The records could not be removed.");
      return;
    }
    setCleanup(res.data.removed === 0 ? "There were no revoked records to remove." : `${res.data.removed} revoked record${res.data.removed === 1 ? "" : "s"} removed.`);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-10">
      {issued ? (
        <OnceSecret
          testId="key-issued"
          dismissTestId="key-dismiss"
          title={`${issued.name}: copy the key now`}
          value={issued.key}
          label="API key"
          onDismiss={() => {
            setIssued(null);
            router.refresh();
          }}
        >
          <p>{issued.notice ?? "This key is shown once and cannot be retrieved again. Store it now."}</p>
          <p className="mt-1">
            Send it as <code className="data text-fg">Authorization: Bearer &lt;key&gt;</code> to the API under{" "}
            <code className="data text-fg">/api/v1</code>. It can {issued.scopes.includes("write") ? "read and change" : "read"} this
            workspace&rsquo;s clients and domains, and read their scans, reports, senders, policy readiness, TLS summaries,
            alerts and DNS changes until it is revoked or expires on {new Date(issued.expiresAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}.
          </p>
        </OnceSecret>
      ) : null}

      {live.length > 0 ? (
      <ReadoutStrip>
        <Readout label="Live keys" value={live.length} note="Each acts for the whole workspace." />
        <Readout
          label="Never used"
          value={neverUsed}
          tone={neverUsed > 0 ? "warn" : undefined}
          note={neverUsed > 0 ? "Revoke any that nobody claims." : "Every live key has been used."}
        />
        <Readout label="Can change data" value={canWrite} note="Create clients and domains, run scans, acknowledge." />
        <Readout
          label="Expire within 30 days"
          value={expiringSoon}
          tone={expiringSoon > 0 ? "warn" : undefined}
          note={expiringSoon > 0 ? "Issue a replacement before they stop." : "None about to stop."}
        />
      </ReadoutStrip>
      ) : null}

      <Panel
        id="keys-live"
        title="Keys that work now"
        why="Each one reaches this workspace's data until it is revoked or expires. Revoke any key you cannot name the owner of."
        aside={`${live.length} live`}
      >
        <Table caption="Live API keys" minWidth={680}>
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Key starts</Th>
              <Th>Can</Th>
              <Th>Last used</Th>
              <Th>Expires</Th>
              <Th align="right">
                <span className="sr-only">Action</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {live.length === 0 ? (
              <TEmptyRow colSpan={6}>No key can reach this workspace. Nothing is connected through the API.</TEmptyRow>
            ) : (
              live.map((k) => (
                <Tr key={k.id} tone={k.daysLeft !== null && k.daysLeft <= 14 ? "warn" : undefined}>
                  <Td className="font-semibold">
                    {k.name}
                    {k.createdLabel ? <span className="block text-meta font-normal text-fg-3">Issued {k.createdLabel}</span> : null}
                  </Td>
                  <Td mono className="whitespace-nowrap text-meta">
                    {k.prefix}…
                  </Td>
                  <Td className="whitespace-nowrap">{scopeWords(k.scopes)}</Td>
                  <Td>
                    {k.lastUsedLabel ? (
                      <>
                        <span className="tnum">{k.lastUsedLabel}</span>
                        {k.lastUsedIp ? <span className="data block text-meta text-fg-3">{k.lastUsedIp}</span> : null}
                      </>
                    ) : (
                      <span className="font-semibold text-warn">Never used</span>
                    )}
                  </Td>
                  <Td className="tnum whitespace-nowrap">
                    {k.expiresLabel ?? <span className="text-fg-3">not recorded</span>}
                    {k.daysLeft !== null && k.daysLeft <= 30 ? (
                      <span className="block text-meta font-semibold text-warn">
                        {k.daysLeft <= 0 ? "today" : `in ${k.daysLeft} day${k.daysLeft === 1 ? "" : "s"}`}
                      </span>
                    ) : null}
                  </Td>
                  <Td align="right">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setRevokeError(null);
                        setRevoking(k);
                      }}
                      data-testid="key-revoke"
                    >
                      Revoke…
                    </Button>
                  </Td>
                </Tr>
              ))
            )}
          </TBody>
        </Table>
      </Panel>

      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
        <Panel id="keys-issue" title="Issue a key" why="Name it after the system that will hold it, so the list above says who to ask before revoking.">
          {!canIssue ? (
            <p className="text-ui text-fg-2">
              Only the workspace owner issues keys, because a key acts with the whole workspace&rsquo;s access. You can revoke
              any key above.
            </p>
          ) : issuing === false ? (
            <UpgradeNotice
              message="Issuing API keys is not included in this workspace's plan."
              feature="api.access"
              context="Keys issued before stay listed above and can still be revoked."
            />
          ) : (
            <form onSubmit={issue} className="grid max-w-[640px] gap-4">
              <Field label="Name" hint="Three to eighty characters. Two live keys cannot share a name.">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  placeholder="PSA sync, nightly"
                  data-testid="key-name"
                  autoComplete="off"
                />
              </Field>
              <fieldset className="flex flex-col gap-2.5">
                <legend className="mb-1 text-meta font-semibold text-fg-2">What it may do</legend>
                <Checkbox checked={read} onChange={(e) => setRead(e.target.checked)} label="Read" hint="List clients and domains, read a domain's scans, reports, senders, policy readiness and TLS summary, and read alerts and DNS changes." />
                <Checkbox
                  checked={write}
                  onChange={(e) => setWrite(e.target.checked)}
                  label="Change"
                  hint="Create clients and domains, run a scan, and acknowledge alerts and DNS changes. Give this only to a system that needs it: a leaked key that can write can add domains under your plan."
                />
                {scopes.length === 0 ? <p className="text-meta font-medium text-fail">Choose at least one.</p> : null}
              </fieldset>
              <Field label="Stops working after" hint="A key with an end date fails safe if it is forgotten.">
                <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="w-full max-w-[320px]">
                  {EXPIRY.map((o) => (
                    <option key={o.days} value={o.days}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <ActionRefusal error={error} />
              <div>
                <Button
                  type="submit"
                  variant="primary"
                  busy={busy}
                  busyLabel="Issuing the key"
                  disabled={!nameOk || scopes.length === 0}
                  data-testid="key-create"
                >
                  Issue key
                </Button>
              </div>
            </form>
          )}
        </Panel>

        <div className="flex flex-col gap-6 lg:pt-1">
          <SetupSteps
            title="Rotating a key"
            steps={[
              { key: "issue", name: "Issue a new key", detail: "Name it for the same system." },
              { key: "switch", name: "Switch the integration to it", detail: "Both keys work in between, so nothing breaks." },
              { key: "revoke", name: "Revoke the old one", detail: "Requests with it are refused from then on." },
            ]}
          />
          <p className="text-meta text-fg-3">
            Send a key as <code className="data text-fg-2">Authorization: Bearer &lt;key&gt;</code> to the API under{" "}
            <code className="data text-fg-2">/api/v1</code>.
          </p>
        </div>
      </div>

      {ended.length > 0 ? (
        <Panel
          id="keys-ended"
          title="Revoked and expired"
          why="These no longer work. The records are kept so the audit trail can name them; remove them when that is no longer useful."
          aside={
            canIssue ? (
              <Button size="sm" variant="ghost" onClick={removeAllEnded}>
                Remove all revoked records
              </Button>
            ) : null
          }
        >
          <Table caption="Revoked and expired API keys" minWidth={560} dense>
            <THead>
              <tr>
                <Th>Name</Th>
                <Th>Key starts</Th>
                <Th>Ended</Th>
                <Th align="right">
                  <span className="sr-only">Action</span>
                </Th>
              </tr>
            </THead>
            <TBody>
              {ended.map((k) => (
                <Tr key={k.id}>
                  <Td className="font-semibold text-fg-2">{k.name}</Td>
                  <Td mono muted className="whitespace-nowrap text-meta">
                    {k.prefix}…
                  </Td>
                  <Td muted className="tnum text-meta">
                    {k.state === "revoked" ? `Revoked ${k.endedLabel ?? ""}` : `Expired ${k.expiresLabel ?? ""}`}
                  </Td>
                  <Td align="right">
                    {k.state === "revoked" && canIssue ? (
                      <Button size="sm" variant="ghost" onClick={() => removeRecord(k)}>
                        Remove record
                      </Button>
                    ) : null}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          {cleanup ? <Notice tone="info" title={cleanup} /> : null}
        </Panel>
      ) : null}

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={revoke}
        title={revoking ? `Revoke ${revoking.name}?` : "Revoke this key?"}
        body={
          revoking ? (
            <>
              <p>
                Anything using <span className="data text-fg">{revoking.prefix}…</span> stops working at once
                {revoking.lastUsedLabel ? `; it was last used ${revoking.lastUsedLabel}` : "; it has never been used"}.
              </p>
              <p className="mt-2">A revoked key cannot be turned back on. To restore access, issue a new key and put it in the integration.</p>
            </>
          ) : null
        }
        confirmLabel="Revoke key"
        busy={revokeBusy}
        danger
        error={revokeError}
        testId="key-revoke"
      />
    </div>
  );
}
