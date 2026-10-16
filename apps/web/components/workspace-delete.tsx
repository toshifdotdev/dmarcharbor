"use client";

/**
 * workspace-delete.tsx — the most destructive control in the product.
 *
 * Deleting a workspace does not remove one client's data. It removes every
 * client, every domain, every report, forensic report, scan, alert rule, alert
 * event, digest, share link, portal grant and API key in it, for every member
 * who has access, and it cannot be undone. Two presses are not a strong enough
 * guard for that, so this asks the operator to type the workspace name, and the
 * button stays disabled until what they typed matches.
 *
 * The counts above the field are read from the server on mount rather than
 * written into the copy: a confirmation that quotes real numbers cannot go stale
 * the way a hardcoded sentence does, and this screen's whole job is to be
 * believed at the moment somebody is frightened.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteWorkspace, previewWorkspaceDeletion, type DeletionSummary } from "@/lib/ops-client";

/** The rows that go, named. Zero rows are never mentioned. */
function describe(summary: DeletionSummary): string {
  const rows: Array<[number, string]> = [
    [summary.domains, "domain"],
    [summary.dmarcReports, "DMARC report"],
    [summary.forensicReports, "forensic report"],
    [summary.reportDigests, "digest"],
    [summary.scans, "scan"],
    [summary.alertRules, "alert rule"],
    [summary.alertEvents, "alert event"],
    [summary.reportShares, "share link"],
    [summary.portalAccessGrants, "portal access grant"],
    [summary.compliancePacks, "compliance pack"],
  ];
  return rows
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}${count === 1 ? "" : "s"}`)
    .join(" · ");
}

export function WorkspaceDelete({
  organizationId,
  workspaceName,
}: {
  organizationId: string;
  workspaceName: string;
}) {
  const router = useRouter();
  const [summary, setSummary] = useState<DeletionSummary | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const preview = await previewWorkspaceDeletion(organizationId);
    // A union, not a promise of a value: an unreadable preview must leave the
    // button disabled rather than arm a destructive control on a guess.
    setSummary(preview.ok ? preview.data.summary : null);
  }, [organizationId]);

  useEffect(() => {
    load().catch(() => setSummary(null));
  }, [load]);

  // Exact match, and case-sensitive on purpose: `Northwind` should not satisfy a
  // prompt asking for `northwind-trading`. A guard that is forgiving about the
  // thing being protected is not a guard.
  const armed = typed === workspaceName;

  async function run() {
    setBusy(true);
    setError(null);
    const res = await deleteWorkspace(organizationId);
    setBusy(false);
    if (res.ok) {
      // The workspace is gone, so every page inside it is a 404 now. The only
      // honest landing is the welcome screen, which is where an account with no
      // workspace belongs.
      router.push("/welcome");
      router.refresh();
      return;
    }
    setError(res.error?.message ?? "That could not be deleted. Try again.");
    // An active subscription is the one refusal that can be resolved, and the
    // counts it quoted are still true, so refresh rather than leave a stale
    // summary above the error.
    if (res.status === 409) await load().catch(() => undefined);
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="label">This deletes</div>
        <p className="mt-1.5 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
          {summary === null
            ? "Reading what this would remove…"
            : summary.domains + summary.dmarcReports === 0
              ? "Nothing yet — the workspace is empty, so there is nothing to lose."
              : describe(summary)}
        </p>
      </div>

      <div>
        <label className="label" htmlFor="workspace-delete-confirm">
          Type <span className="num">{workspaceName}</span> to confirm
        </label>
        <input
          id="workspace-delete-confirm"
          data-testid="workspace-delete-input"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={workspaceName}
          className="mt-1.5 w-full rounded-[2px] border px-3 py-2 text-[13px]"
          style={{
            borderColor: typed.length > 0 && armed ? "var(--color-block)" : "var(--color-line-strong)",
            background: "var(--color-surface)",
            color: "var(--color-ink)",
          }}
        />
      </div>

      <div>
        <button
          type="button"
          data-testid="workspace-delete"
          disabled={!armed || busy || summary === null}
          onClick={run}
          className="rounded-[2px] border px-3.5 py-2 text-[12.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            borderColor: "var(--color-block)",
            background: armed && summary !== null ? "var(--color-block)" : "transparent",
            color: armed && summary !== null ? "var(--color-surface)" : "var(--color-block)",
          }}
        >
          {busy ? "Deleting…" : "Delete this workspace permanently"}
        </button>
        {!armed && typed.length > 0 ? (
          <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--color-ink-3)" }}>
            The name does not match yet.
          </p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" data-testid="workspace-delete-error" className="text-[12px]" style={{ color: "var(--color-block)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
