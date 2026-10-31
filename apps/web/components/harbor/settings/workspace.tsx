"use client";

/**
 * workspace.tsx — renaming the workspace (WorkspaceRename, at the end of the
 * file) and deleting it.
 *
 * Deleting is the most destructive control in the
 * product: every client, domain, report and share link goes, at once, with no
 * grace period. So the confirmation is built from the API's own count of what
 * would go (the preview endpoint; the same numbers the delete reports after),
 * asks for the workspace's slug to be typed, and is refused by the API while a
 * paid subscription is still running, which the page explains with the way out
 * rather than as an error.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  deleteWorkspace,
  previewWorkspaceDeletion,
  renameWorkspace,
  type DeletionSummary,
  type HostedDeletionPreview,
  type ManagedSpfDeletionPreview,
} from "@/lib/ops-client";
import { Button, ButtonLink } from "@/components/ui/button";
import { DnsRecord } from "@/components/ui/copy";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { useToast } from "@/components/ui/toast";
import { DangerZone } from "./parts";

const LINES: Array<[keyof DeletionSummary, string, string]> = [
  ["domains", "domain", "domains"],
  ["dmarcReports", "aggregate report", "aggregate reports"],
  ["forensicReports", "forensic sample", "forensic samples"],
  ["alertRules", "alert rule", "alert rules"],
  ["alertEvents", "alert event", "alert events"],
  ["reportDigests", "scheduled digest", "scheduled digests"],
  ["scans", "DNS scan", "DNS scans"],
  ["reportShares", "share link", "share links"],
  ["portalAccessGrants", "client portal grant", "client portal grants"],
  ["compliancePacks", "compliance pack", "compliance packs"],
];

export function WorkspaceDeletion({
  organizationId,
  name,
  slug,
  isOwner,
  serviceName = "this service",
}: {
  organizationId: string;
  name: string;
  slug: string;
  /** null: the role could not be read; the API decides. */
  isOwner: boolean | null;
  /** The product's name as this host shows it (readHostBrand), never hard-coded. */
  serviceName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<DeletionSummary | null>(null);
  const [hosted, setHosted] = useState<HostedDeletionPreview[]>([]);
  const [managedSpf, setManagedSpf] = useState<ManagedSpfDeletionPreview[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; subscription: boolean } | null>(null);

  async function begin() {
    setOpen(true);
    setTyped("");
    setError(null);
    setPreviewError(null);
    setLoading(true);
    setHosted([]);
    setManagedSpf([]);
    const res = await previewWorkspaceDeletion(organizationId);
    setLoading(false);
    if (!res.ok) {
      setPreviewError(res.error.message ?? "What would be deleted could not be read.");
      return;
    }
    setSummary(res.data.summary);
    setHosted(res.data.hostedDmarc ?? []);
    setManagedSpf(res.data.managedSpf ?? []);
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    const res = await deleteWorkspace(organizationId);
    if (!res.ok) {
      setBusy(false);
      setError({
        message: res.error.message ?? "The workspace could not be deleted. Nothing was removed.",
        subscription: res.error.code === "SUBSCRIPTION_STILL_ACTIVE",
      });
      return;
    }
    // The workspace is gone; the app picks another one, or the welcome page.
    window.location.assign("/");
  }

  const matches = typed.trim() === slug;

  return (
    <DangerZone
      testId="workspace-delete"
      title="Delete this workspace"
      consequence={
        <>
          <p>
            Every client, domain and report in <span className="font-semibold text-fg">{name}</span> is deleted at once,
            with no grace period. Share links, portal access and Trust Centers stop working, and every member loses access.
          </p>
          <p className="mt-1">
            To remove one client&rsquo;s personal data instead, use{" "}
            <Link href="/settings/erasure" className="link">
              Erasure
            </Link>
            , which waits out a grace period and can be cancelled until then. Export the data first if anyone will want it:{" "}
            <Link href="/settings/export" className="link">
              Data export
            </Link>
            .
          </p>
        </>
      }
    >
      {isOwner === false ? (
        <p className="text-ui text-fg-3">Only the workspace owner can delete it.</p>
      ) : (
        <div>
          <Button variant="danger" onClick={begin}>
            Delete workspace…
          </Button>
        </div>
      )}

      <Dialog
        open={open}
        onClose={() => (busy ? undefined : setOpen(false))}
        title={`Delete ${name}?`}
        testId="workspace-delete-confirm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Keep the workspace
            </Button>
            <Button variant="danger" onClick={confirm} disabled={!matches || !summary} busy={busy} busyLabel="Deleting the workspace">
              Delete everything
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-ui text-fg-2">
          {loading ? <p>Counting what would be deleted…</p> : null}
          {previewError ? (
            <Notice tone="fail" title="What would be deleted could not be read">
              {previewError} Deleting without seeing it is not offered.
            </Notice>
          ) : null}
          {summary ? (
            <div>
              <p className="font-semibold text-fg">This deletes, permanently:</p>
              <ul className="mt-1.5 grid grid-cols-1 border-t border-rule tnum sm:grid-cols-2 sm:gap-x-6">
                {LINES.map(([k, one, many]) => (
                  <li
                    key={k}
                    className={`flex items-baseline justify-between gap-3 border-b border-rule py-1 ${summary[k] === 0 ? "text-fg-4" : "text-fg"}`}
                  >
                    <span>{summary[k] === 1 ? one : many}</span>
                    <span className="font-semibold">{summary[k] === 0 ? "none" : summary[k].toLocaleString("en-GB")}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {hosted.length > 0 ? (
            <div className="rounded-ctl border border-warn/40 bg-warn-wash p-3">
              <p className="font-semibold text-fg">These domains read their DMARC record from {serviceName}.</p>
              <p className="mt-1 max-w-[72ch] text-meta text-fg-2">
                Publish this TXT at your DNS host and remove the CNAME first, or the domain will have no DMARC record once
                it is deleted here.
              </p>
              <div className="mt-3 flex flex-col gap-3">
                {hosted.map((record) => (
                  <div key={record.domain}>
                    <p className="mb-1 text-meta font-semibold text-fg">{record.domain}</p>
                    <DnsRecord
                      type="TXT"
                      host={record.republish.host}
                      zone={record.republish.host.replace(/^_dmarc\./, "")}
                      value={record.republish.value}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {managedSpf.length > 0 ? (
            <div className="rounded-ctl border border-warn/40 bg-warn-wash p-3">
              <p className="font-semibold text-fg">These domains&rsquo; SPF records are managed by {serviceName}.</p>
              <p className="mt-1 max-w-[72ch] text-meta text-fg-2">
                Publish this TXT at your DNS host and remove the redirect to {serviceName} first, or the domain will lose
                its SPF record once it is deleted here.
              </p>
              <div className="mt-3 flex flex-col gap-3">
                {managedSpf.map((record) => (
                  <div key={record.domain}>
                    <p className="mb-1 text-meta font-semibold text-fg">{record.domain}</p>
                    <DnsRecord
                      type="TXT"
                      host={record.republish.host}
                      zone={record.republish.host}
                      value={record.republish.value}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <Field label={<>Type the workspace slug, <code className="data text-fg">{slug}</code>, to confirm</>}>
            <Input mono value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} data-testid="workspace-delete-input" />
          </Field>
          {error ? (
            <div role="alert" data-testid="workspace-delete-error">
              <Notice
                tone={error.subscription ? "warn" : "fail"}
                title={error.subscription ? "The subscription is still running" : "Nothing was deleted"}
                action={
                  error.subscription ? (
                    <ButtonLink href="/billing" size="sm">
                      Open billing
                    </ButtonLink>
                  ) : undefined
                }
              >
                {error.message}
              </Notice>
            </div>
          ) : null}
        </div>
      </Dialog>
    </DangerZone>
  );
}

/**
 * Renaming the workspace, for an agency that renames itself. The slug and the
 * workspace id stay, so links, support references and the delete confirmation
 * keep working. Owner or admin; anyone else reads the name and is told who can
 * change it.
 *
 * Test hooks: workspace-rename-input, workspace-rename-save.
 */
export function WorkspaceRename({
  organizationId,
  name,
  canRename,
}: {
  organizationId: string;
  name: string;
  /** null: the role could not be read; the API decides. */
  canRename: boolean | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = value.trim();
  const valid = trimmed.length >= 2 && trimmed.length <= 80;
  const changed = trimmed !== name;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!valid || !changed || busy) return;
    setBusy(true);
    setError(null);
    const res = await renameWorkspace(organizationId, trimmed);
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message ?? "The workspace could not be renamed. Nothing changed.");
      return;
    }
    toast({ title: `The workspace is now ${res.data.workspace.name}`, tone: "ok" });
    router.refresh();
  }

  if (canRename === false) {
    return (
      <p className="text-ui text-fg-2">
        An owner or admin of this workspace can rename it.
      </p>
    );
  }

  return (
    <form onSubmit={save} className="flex max-w-[560px] flex-col gap-3">
      <Field
        label="Workspace name"
        hint="Shown in the app, in invitation and alert emails, and to your clients' portal contacts. The slug and ID stay the same."
        error={trimmed.length > 0 && !valid ? "Between 2 and 80 characters." : undefined}
      >
        <Input
          size="lg"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          data-testid="workspace-rename-input"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="secondary"
          disabled={!valid || !changed}
          busy={busy}
          busyLabel="Saving"
          data-testid="workspace-rename-save"
        >
          Save name
        </Button>
        {error ? (
          <p role="alert" className="text-ui font-medium text-fail">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
