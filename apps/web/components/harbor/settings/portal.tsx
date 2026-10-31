"use client";

/**
 * portal.tsx — which client contacts can open a read-only view of their own
 * domains.
 *
 * The decision is who sees a client's results, so the page says exactly what
 * a contact sees (and what they never see) before the form, and lists every
 * grant by client with whether the person has actually used it. A grant waits
 * on an email address until someone signs in with it, so "granted" and "in
 * use" are different states and are shown as different states.
 *
 * Revoking is immediate. A revoked grant's record is kept until it is removed,
 * so the audit trail can still name it.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { deleteAllRevokedPortalAccess, deletePortalAccessRecord, grantPortalAccess, revokePortalAccess } from "@/lib/ops-client";
import type { FeatureStatus } from "@/lib/entitlements";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Button } from "@/components/ui/button";
import { CopyValue } from "@/components/ui/copy";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { UpgradeNotice } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { FigureHead, Panel, RouteColumn, StateWord, plural } from "./parts";

export interface GrantView {
  id: string;
  clientId: string;
  clientName: string;
  email: string;
  displayName: string | null;
  active: boolean;
  firstSeenLabel: string | null;
  grantedLabel: string;
}

export function PortalBoard({
  organizationId,
  clients,
  grants,
  canManage,
  granting,
  portalUrl,
}: {
  organizationId: string;
  clients: Array<{ id: string; name: string; domainCount: number }>;
  grants: GrantView[];
  canManage: boolean;
  granting: FeatureStatus;
  portalUrl: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [granted, setGranted] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<GrantView | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const byClient = useMemo(() => {
    const map = new Map<string, GrantView[]>();
    for (const g of grants) map.set(g.clientId, [...(map.get(g.clientId) ?? []), g]);
    return [...map.entries()]
      .map(([id, list]) => ({ id, name: list[0]?.clientName ?? "A client", list }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [grants]);
  const revokedCount = grants.filter((g) => !g.active).length;

  async function grant(e: FormEvent) {
    e.preventDefault();
    if (busy || !clientId) return;
    setBusy(true);
    setError(null);
    setGranted(null);
    const res = await grantPortalAccess(organizationId, clientId, {
      email: email.trim(),
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setGranted(res.data.notice ?? `${res.data.email} can now open ${res.data.clientName}'s portal.`);
    setEmail("");
    setDisplayName("");
    router.refresh();
  }

  async function revoke() {
    if (!revoking) return;
    setRevokeBusy(true);
    const res = await revokePortalAccess(organizationId, revoking.id);
    setRevokeBusy(false);
    if (!res.ok && res.status !== 404) {
      setListError(res.error.message ?? "The access could not be revoked.");
      setRevoking(null);
      return;
    }
    toast({ title: `${revoking.email} can no longer open the portal`, tone: "ok" });
    setRevoking(null);
    router.refresh();
  }

  async function removeRecord(g: GrantView) {
    const res = await deletePortalAccessRecord(organizationId, g.id);
    if (!res.ok) {
      setListError(res.error.message ?? "The record could not be removed.");
      return;
    }
    router.refresh();
  }

  async function removeAllRevoked() {
    const res = await deleteAllRevokedPortalAccess(organizationId);
    if (!res.ok) {
      setListError(res.error.message ?? "The records could not be removed.");
      return;
    }
    toast({ title: res.data.removed === 0 ? "No revoked records to remove" : `${res.data.removed} revoked record${res.data.removed === 1 ? "" : "s"} removed`, tone: "ok" });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-14">
      <figure aria-labelledby="pa-figure" className="flex flex-col gap-5">
        <FigureHead
          name={<span id="pa-figure">What a contact sees</span>}
          kind="one client, read-only"
          aside={
            <Link href="/settings/branding" className="link font-semibold">
              Preview it in your brand
            </Link>
          }
        />
        <div className="grid gap-x-14 gap-y-8 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            <p className="text-ui font-semibold text-fg">Their line stops at</p>
            <RouteColumn
              label="What a client contact sees"
              stops={[
                { key: "client", shape: "origin", name: "Their own client", kind: "and no other" },
                { key: "verdict", shape: "station", name: "A plain verdict per domain", kind: "in words, not codes" },
                { key: "policy", shape: "station", name: "The published policy", kind: "and when reports last arrived" },
                { key: "monthly", shape: "station", name: "Monthly reports", kind: "the ones you issue" },
                { key: "approve", shape: "station", name: "Changes you ask them to approve", kind: "if you propose one" },
                { key: "brand", shape: "terminus", name: "Under your name", kind: "and your logo and colours with white label" },
              ]}
            />
          </div>
          <div className="flex flex-col gap-3">
            <p className="text-ui font-semibold text-fg">Closed to them</p>
            <RouteColumn
              label="What a client contact never sees"
              stops={[
                { key: "forensic", shape: "station", closed: true, name: "Forensic samples", kind: "message-level detail" },
                { key: "recipients", shape: "station", closed: true, arrive: "closed", name: "Recipient addresses" },
                { key: "others", shape: "station", closed: true, arrive: "closed", name: "Other clients", kind: "and their domains" },
                { key: "billing", shape: "station", closed: true, arrive: "closed", name: "Billing and your plan" },
                { key: "settings", shape: "terminus", closed: true, arrive: "closed", name: "Settings and people", kind: "they change nothing here" },
              ]}
            />
          </div>
        </div>
        <figcaption className="flex flex-col gap-1.5 border-t border-rule pt-3">
          <span className="text-meta text-fg-3">They sign in here, with the address you grant:</span>
          <CopyValue value={portalUrl} label="portal address" className="max-w-[520px]" />
        </figcaption>
      </figure>

      <Panel id="pa-grant" title="Give a contact access" why="Access is held against the email address and covers one client. It starts the first time that address signs in.">
        {!canManage ? (
          <p className="text-ui text-fg-2">An owner or admin can give or revoke access.</p>
        ) : granting === false ? (
          <UpgradeNotice
            message="The client portal is not included in this workspace's plan."
            feature="portal.client"
            context="While it is not included, contacts who already have access see a page saying their report is paused. Their access is kept and comes back with the portal; the grants below can still be revoked."
          />
        ) : clients.length === 0 ? (
          <p className="text-ui text-fg-2">Add a client first: access is given per client.</p>
        ) : (
          <form onSubmit={grant} className="grid max-w-[720px] gap-4 sm:grid-cols-2">
            <Field label="Client" className="sm:col-span-2">
              <Select value={clientId} onChange={(e) => setClientId(e.target.value)} className="w-full max-w-[420px]">
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.domainCount} domain{c.domainCount === 1 ? "" : "s"})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Their email address">
              <Input type="email" mono value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} autoComplete="off" />
            </Field>
            <Field label="Their name" hint="Optional. Shown to you, not to them.">
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} autoComplete="off" />
            </Field>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <ActionRefusal error={error} />
              {granted ? <Notice tone="ok" title="Access granted">{granted} They get an email saying so.</Notice> : null}
              <div>
                <Button type="submit" variant="primary" busy={busy} busyLabel="Granting access">
                  Grant access
                </Button>
              </div>
            </div>
          </form>
        )}
      </Panel>

      <Panel
        id="pa-list"
        title="Who has access"
        aside={
          canManage && revokedCount > 0 ? (
            <Button size="sm" variant="ghost" onClick={removeAllRevoked}>
              Remove {revokedCount} revoked record{revokedCount === 1 ? "" : "s"}
            </Button>
          ) : null
        }
      >
        {byClient.length === 0 ? (
          <p className="text-ui text-fg-2">Nobody outside the workspace can see anything.</p>
        ) : (
          <div className="flex flex-col gap-8">
            {byClient.map((c) => {
              const live = c.list.filter((g) => g.active).length;
              return (
                <div key={c.id}>
                  <h3 className="flex flex-wrap items-baseline gap-x-2 text-ui">
                    <span className="font-bold text-fg">{c.name}</span>
                    <span className="tnum text-fg-3">
                      {live === 0 ? "no contact has access" : `${plural(live, "contact")} with access`}
                    </span>
                  </h3>
                  <ul className="mt-2 flex flex-col border-t border-rule">
                    {c.list.map((g) => (
                      <li
                        key={g.id}
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 border-b border-rule py-2.5 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,12.5rem)_6.5rem]"
                      >
                        <span className="min-w-0">
                          <span className={g.active ? "data break-all text-ui font-semibold text-fg" : "data break-all text-ui text-fg-3 line-through"}>
                            {g.email}
                          </span>
                          {g.displayName ? <span className="ml-2 text-meta text-fg-3">{g.displayName}</span> : null}
                        </span>
                        <span className="col-start-1 row-start-2 md:col-start-auto md:row-start-auto">
                          {g.active ? (
                            g.firstSeenLabel ? (
                              <StateWord shape="square" tone="ok" size="meta">
                                In use since {g.firstSeenLabel}
                              </StateWord>
                            ) : (
                              <StateWord shape="ring" tone="warn" size="meta">
                                Not signed in yet
                              </StateWord>
                            )
                          ) : (
                            <StateWord shape="closed" tone="void" size="meta">
                              Revoked
                            </StateWord>
                          )}
                        </span>
                        <span className="col-start-1 row-start-3 text-meta text-fg-3 md:col-start-auto md:row-start-auto">
                          Granted {g.grantedLabel}
                        </span>
                        <span className="col-start-2 row-start-1 flex justify-end md:col-start-auto md:row-start-auto">
                          {canManage ? (
                            g.active ? (
                              <Button size="sm" variant="ghost" className="text-fail hover:text-fail" onClick={() => setRevoking(g)}>
                                Revoke
                              </Button>
                            ) : (
                              <button type="button" className="link text-meta" onClick={() => removeRecord(g)}>
                                Remove record
                              </button>
                            )
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
        {listError ? <Notice tone="fail" title={listError} /> : null}
      </Panel>

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={revoke}
        title={revoking ? `Revoke ${revoking.email}?` : "Revoke access?"}
        body={
          revoking ? (
            <p>
              They lose {revoking.clientName}&rsquo;s portal the next time they load it. Granting the same address again
              restores it.
            </p>
          ) : null
        }
        confirmLabel="Revoke access"
        busy={revokeBusy}
        danger
      />
    </div>
  );
}
