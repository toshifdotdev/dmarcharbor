"use client";

/**
 * dns-publish.tsx — publishes one record the API generated through a stored
 * Cloudflare connection.
 *
 * The browser never assembles a record value. It names a kind, and every name
 * and value shown here came back from the API. The fingerprint from the preview
 * travels with the publish so a change made in Cloudflare in between is refused
 * with the new preview rather than overwritten.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  previewDnsRecord,
  publishDnsRecord,
  restoreDnsPublication,
} from "@/lib/ops-client";
import type {
  DnsConnectionRow,
  DnsPublicationRow,
  DnsPublishPreview,
  DnsPublishRecord,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { UpgradeNotice } from "@/components/ui/states";
import { TideMark } from "@/components/ui/tide";

export interface DnsPublishContext {
  organizationId: string;
  domainId: string;
  connections: DnsConnectionRow[];
  canPublish: boolean;
}

const ACTION_WORDS: Record<DnsPublishPreview["action"], string> = {
  create: "Create the record",
  update: "Replace the current value",
  unchanged: "Already published",
  refused: "Cannot publish",
};

export function DnsPublishButton({
  context,
  record,
  purpose,
}: {
  context: DnsPublishContext;
  record: DnsPublishRecord;
  purpose: string;
}) {
  const router = useRouter();
  const usable = context.connections.filter((connection) => !connection.paused);
  const initial = usable[0] ?? context.connections[0] ?? null;
  const [open, setOpen] = useState(false);
  const [connectionId, setConnectionId] = useState(initial?.id ?? "");
  const [preview, setPreview] = useState<DnsPublishPreview | null>(null);
  const [published, setPublished] = useState<{ message: string; publication: DnsPublicationRow | null } | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "publish" | "restore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planRefused, setPlanRefused] = useState(false);

  const selected = context.connections.find((connection) => connection.id === connectionId) ?? initial;
  const paused = selected?.paused === true;

  async function loadPreview(id: string) {
    if (!id) return;
    setBusy("preview");
    setError(null);
    setPreview(null);
    const result = await previewDnsRecord(context.organizationId, context.domainId, {
      connectionId: id,
      record,
    });
    setBusy(null);
    if (!result.ok) {
      if (result.error.code === "FEATURE_NOT_IN_PLAN") {
        setPlanRefused(true);
        return;
      }
      setError(result.error.message ?? "The current record could not be read from Cloudflare.");
      return;
    }
    setPreview(result.data);
  }

  function openDialog() {
    setOpen(true);
    setPublished(null);
    setRestoreMessage(null);
    setError(null);
    setPlanRefused(false);
    setPreview(null);
  }

  useEffect(() => {
    if (!open || paused || !connectionId || planRefused) return;
    // A connection change re-reads the name; the preview is what makes the
    // action and fingerprint trustworthy.
    if (preview?.connection.id !== connectionId) void loadPreview(connectionId);
  }, [open, connectionId]);

  async function publish() {
    if (!preview || preview.action === "refused" || preview.action === "unchanged") return;
    setBusy("publish");
    setError(null);
    const result = await publishDnsRecord(context.organizationId, context.domainId, {
      connectionId: preview.connection.id,
      record,
      expectedFingerprint: preview.currentFingerprint,
    });
    setBusy(null);
    if (!result.ok) {
      if (result.error.code === "FEATURE_NOT_IN_PLAN") {
        setPlanRefused(true);
        return;
      }
      if (result.error.code === "DNS_CHANGED" && result.error.preview) {
        setPreview(result.error.preview);
        setError("The record changed in Cloudflare after that preview. Check the new values and publish again.");
        return;
      }
      setError(result.error.message ?? "The record was not published. Nothing changed.");
      return;
    }
    setPreview(result.data.preview);
    setPublished({ message: result.data.message, publication: result.data.publication });
    router.refresh();
  }

  async function restore() {
    if (!published?.publication) return;
    setBusy("restore");
    setError(null);
    const result = await restoreDnsPublication(context.organizationId, published.publication.id);
    setBusy(null);
    if (!result.ok) {
      setError(result.error.message ?? "The previous value could not be restored.");
      return;
    }
    setRestoreMessage(result.data.message);
    setPublished(null);
    setPreview(null);
    router.refresh();
    if (connectionId) void loadPreview(connectionId);
  }

  if (!context.canPublish || context.connections.length === 0) {
    return null;
  }

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        onClick={openDialog}
        data-testid={`dns-publish-${record.kind}`}
        title={`Publish “${purpose}” through Cloudflare`}
      >
        Publish with Cloudflare
      </Button>

      <Dialog
        open={open}
        onClose={busy ? () => {} : () => setOpen(false)}
        title="Publish with Cloudflare"
        description="Nothing is written until you press Publish. The value shown is generated by the API."
        testId="dns-publish-dialog"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy !== null}>
              Close
            </Button>
            {published?.publication ? (
              <Button variant="secondary" onClick={restore} busy={busy === "restore"} busyLabel="Restoring">
                {published.publication.previousValue === null ? "Remove the record we created" : "Restore previous value"}
              </Button>
            ) : null}
            {!published && preview && preview.action !== "refused" && preview.action !== "unchanged" && !paused ? (
              <Button variant="primary" onClick={publish} busy={busy === "publish"} busyLabel="Publishing" data-testid="dns-confirm-publish">
                Publish
              </Button>
            ) : null}
          </>
        }
      >
        <div className="flex flex-col gap-5">
          {planRefused || paused ? (
            <UpgradeNotice
              message="Publishing DNS records through Cloudflare is not included in this workspace's plan."
              feature="dns.automation"
              context="The connection is kept. Publishing resumes when the plan grants it again."
            />
          ) : null}

          {context.connections.length > 1 && !planRefused ? (
            <Field label="Cloudflare connection">
              <Select
                value={connectionId}
                onChange={(event) => {
                  setConnectionId(event.target.value);
                  setPreview(null);
                  setError(null);
                  setPlanRefused(false);
                }}
                data-testid="dns-dialog-connection"
              >
                {context.connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {(connection.label || connection.accountName || "Cloudflare") + ` · …${connection.tokenHint}`}
                    {connection.paused ? " (paused)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          {busy === "preview" ? (
            <div role="status" className="flex items-center gap-3 text-ui text-fg-2">
              <TideMark size={18} />
              Reading the current record from Cloudflare…
            </div>
          ) : null}
          {error ? <Notice tone="fail" title={error} /> : null}
          {restoreMessage ? <Notice tone="ok" title={restoreMessage} /> : null}

          {preview && !planRefused ? (
            <>
              <dl className="grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-3 border-y border-rule py-4 text-ui">
                <dt className="text-fg-3">Zone</dt>
                <dd className="data text-fg">{preview.zone.name}</dd>
                <dt className="text-fg-3">Record</dt>
                <dd className="data break-all text-fg">{preview.recordName}</dd>
                <dt className="text-fg-3">Action</dt>
                <dd className="font-semibold text-fg" data-testid="dns-preview-action">
                  {ACTION_WORDS[preview.action]}
                </dd>
                <dt className="text-fg-3">Current value</dt>
                <dd className="flex flex-col gap-1">
                  {preview.currentValues.length === 0 ? (
                    <span className="text-fg-3">No TXT record exists at this name yet.</span>
                  ) : (
                    preview.currentValues.map((value) => (
                      <code key={value} className="data break-all rounded-[6px] bg-paper-3 px-2 py-1 text-meta text-fg">
                        {value}
                      </code>
                    ))
                  )}
                </dd>
                <dt className="text-fg-3">New value</dt>
                <dd>
                  <code className="data break-all rounded-[6px] bg-paper-3 px-2 py-1 text-meta text-fg" data-testid="dns-preview-value">
                    {preview.proposedValue}
                  </code>
                </dd>
              </dl>
              {preview.action === "refused" && preview.reason ? <Notice tone="warn" title={preview.reason} /> : null}
              {preview.action === "unchanged" ? (
                <p className="text-ui text-fg-2">Cloudflare already has this exact value at that name. Nothing to do.</p>
              ) : null}
            </>
          ) : null}

          {published ? (
            <Notice tone="ok" title={published.message}>
              {published.publication
                ? "The record is recorded here, so you can restore the previous value if it was not what you intended."
                : null}
            </Notice>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
