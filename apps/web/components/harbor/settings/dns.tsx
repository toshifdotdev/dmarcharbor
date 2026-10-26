"use client";

/**
 * dns.tsx — Cloudflare connections for publishing the records this service
 * generates.
 *
 * The API Token is a credential. It goes into an uncontrolled field, is stored
 * encrypted, and never comes back: the page shows only its last four characters.
 * The API verifies the token before saving it, so a pasted Global API Key or a
 * dead token is refused here rather than failing on the first publish.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { createDnsConnection, deleteDnsConnection } from "@/lib/ops-client";
import { instantLabel } from "@/lib/instant";
import type { DnsConnectionRow } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { KeyValue, Notice } from "@/components/ui/notice";
import { UpgradeNotice } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { Panel } from "./parts";

function connectionName(connection: DnsConnectionRow): string {
  return connection.label || connection.accountName || "Cloudflare connection";
}

export function DnsConnectionsBoard({
  organizationId,
  connections,
  canManage,
  feature,
  planLabel,
}: {
  organizationId: string;
  connections: DnsConnectionRow[];
  canManage: boolean;
  feature: boolean | null;
  planLabel: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const tokenInput = useRef<HTMLInputElement | null>(null);
  const form = useRef<HTMLFormElement | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<DnsConnectionRow | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  const unavailable = feature === false;

  async function add(event: FormEvent) {
    event.preventDefault();
    if (busy || unavailable) return;
    const token = tokenInput.current?.value.trim() ?? "";
    setBusy(true);
    setError(null);
    const result = await createDnsConnection(organizationId, {
      provider: "CLOUDFLARE",
      token,
      label: label.trim() || null,
    });
    setBusy(false);
    if (tokenInput.current) tokenInput.current.value = "";
    if (!result.ok) {
      setError(result.error.message ?? "The Cloudflare connection could not be saved. Nothing changed.");
      return;
    }
    form.current?.reset();
    setLabel("");
    toast({ title: "Cloudflare connected", body: "You can now publish generated records from a domain or its setup page.", tone: "ok" });
    router.refresh();
  }

  async function remove() {
    if (!removing) return;
    setRemoveBusy(true);
    const result = await deleteDnsConnection(organizationId, removing.id);
    setRemoveBusy(false);
    if (!result.ok) {
      setError(result.error.message ?? "The connection could not be removed.");
      setRemoving(null);
      return;
    }
    setRemoving(null);
    toast({ title: "Cloudflare connection removed", tone: "ok" });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-8">
      {unavailable ? (
        <UpgradeNotice
          message={`Publishing DNS records through Cloudflare is not included in this workspace's plan. It is included from ${planLabel}.`}
          feature="dns.automation"
          context="A connection already configured is kept and appears paused. Publishing resumes when the plan grants it again."
        />
      ) : null}

      <Panel
        id="dns-connections"
        title="Cloudflare connections"
        why="Each connection is a scoped Cloudflare API Token. Up to five are allowed, for agencies with more than one Cloudflare account."
      >
        {connections.length === 0 ? (
          <p className="text-ui text-fg-2" data-testid="dns-no-connections">
            No Cloudflare connection yet. Add one below, then use “Publish with Cloudflare” beside a generated record.
          </p>
        ) : (
          <ul className="flex flex-col" data-testid="dns-connection-list">
            {connections.map((connection) => (
              <li key={connection.id} className="flex flex-col gap-2 border-b border-rule py-4 first:pt-0 last:border-b-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-body font-semibold text-fg">{connectionName(connection)}</span>
                  {connection.paused ? <Badge tone="void">Paused</Badge> : <Badge tone="ok">Connected</Badge>}
                  <span className="flex-1" />
                  {canManage ? (
                    <Button size="sm" variant="ghost" className="text-fail hover:text-fail" onClick={() => setRemoving(connection)}>
                      Remove
                    </Button>
                  ) : null}
                </div>
                <KeyValue
                  rows={[
                    ["Provider", "Cloudflare"],
                    ["Token", <code key="t" className="data text-fg">…{connection.tokenHint}</code>],
                    connection.accountName ? ["Account", connection.accountName] : null,
                    ["Verified", connection.lastVerifiedAt ? instantLabel(connection.lastVerifiedAt) : "not yet"],
                    connection.paused ? ["Publishing", <span key="p" className="text-warn">Paused: included from {planLabel}</span>] : null,
                    connection.lastError ? [
                      "Last error",
                      <span key="e" className="text-fail">{connection.lastError}</span>,
                    ] : null,
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
        {error ? <Notice tone="fail" title={error} /> : null}
      </Panel>

      <Panel
        id="dns-add"
        title={connections.length === 0 ? "Connect Cloudflare" : "Add another Cloudflare connection"}
        why={
          <>
            In Cloudflare, open <span className="font-semibold">My Profile → API Tokens → Create Token</span>. Use an API
            Token, not the Global API Key. Give it <span className="font-semibold">Zone → DNS → Edit</span> and{" "}
            <span className="font-semibold">Zone → Zone → Read</span>, limited to the zones you want us to manage. Copy the
            token once; Cloudflare will not show it again.
          </>
        }
      >
        {unavailable ? (
          <p className="text-ui text-fg-2">
            Adding a connection is unavailable on this plan. Existing connections can still be removed.
          </p>
        ) : canManage ? (
          <form ref={form} onSubmit={add} className="grid max-w-[640px] gap-4">
            <Field
              label="Cloudflare API Token"
              hint="A scoped token, not the Global API Key. It is stored encrypted, never shown again, and only its last four characters are displayed."
            >
              <Input
                ref={tokenInput}
                type="password"
                mono
                name="token"
                defaultValue=""
                required
                autoComplete="new-password"
                spellCheck={false}
                placeholder="Paste the API Token"
                data-testid="dns-token"
              />
            </Field>
            <Field label="Name this connection" hint="Optional. For example “Acme production Cloudflare”.">
              <Input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} placeholder="Acme production" data-testid="dns-label" />
            </Field>
            <div>
              <Button type="submit" variant="primary" busy={busy} busyLabel="Checking the token with Cloudflare" data-testid="dns-connect">
                Connect Cloudflare
              </Button>
            </div>
            <p className="text-meta text-fg-3">
              We check the token with Cloudflare before saving it. A Global API Key is refused because it gives access to the
              whole account.
            </p>
          </form>
        ) : (
          <p className="text-ui text-fg-2">An owner or admin can connect Cloudflare.</p>
        )}
      </Panel>

      <p className="text-meta text-fg-3">
        Publishing uses only the records this service generates. The connection cannot be used to write arbitrary DNS
        content. See{" "}
        <Link href="/settings/audit" className="link">
          the audit trail
        </Link>{" "}
        for every publish and restore.
      </p>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title="Remove this Cloudflare connection?"
        body={
          <p>
            The stored token is deleted and publishing stops. Publication history is kept, but a published record can no
            longer be restored from here.
          </p>
        }
        confirmLabel="Remove connection"
        busy={removeBusy}
        danger
      />
    </div>
  );
}
