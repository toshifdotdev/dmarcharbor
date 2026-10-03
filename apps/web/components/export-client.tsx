"use client";

/**
 * export-client.tsx — data export (data-subject right).
 *
 * An export is a REQUEST that is prepared and then available — not an instant
 * download — because that is what the API does: POST creates a job, the job
 * carries a downloadUrl with a short-lived token, and the list shows what is
 * prepared and what has expired. The UI presents that lifecycle honestly
 * rather than pretending the file appears on click.
 *
 * Free on every plan. The copy never implies a GDPR right is a paid feature.
 */

import { ActionButton } from "@/components/action-button";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createExportJob, revokeExportJob } from "@/lib/ops-client";
import type { ApiErrorBody, ExportJob } from "@/lib/types";

export function ExportPanel({
  organizationId,
  jobs,
  linkDays,
  clients,
}: {
  organizationId: string;
  jobs: ExportJob[];
  linkDays: number;
  clients: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [scope, setScope] = useState<"ORGANIZATION" | "CLIENT" | "DOMAIN">("ORGANIZATION");
  const [targetId, setTargetId] = useState("");
  const [format, setFormat] = useState<"JSON" | "CSV">("JSON");
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [justCreated, setJustCreated] = useState<string | null>(null);

  async function request(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setJustCreated(null);
    const res = await createExportJob(organizationId, {
      scope,
      format,
      ...(scope !== "ORGANIZATION" && targetId ? { targetId } : {}),
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setJustCreated(res.data.id);
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <section
        className="lift rounded-[2px] border p-5"
        style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      >
        <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
          Request a data export
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--color-ink-2)" }}>
          An export is <strong style={{ color: "var(--color-ink)" }}>prepared, then
          made available</strong>: it is not an instant download. Once it is ready
          its link works for {linkDays} days, then expires. Available on{" "}
          <strong style={{ color: "var(--color-ink)" }}>every plan at no cost</strong>:
          export of personal data is a right, not a paid feature.
        </p>

        {error ? (
          <p role="alert" className="mt-3 text-[13px]" style={{ color: "var(--color-block)" }}>
            {error.message}
          </p>
        ) : null}
        {justCreated ? (
          <p role="status" className="mt-3 text-[13px]" style={{ color: "var(--color-pass)" }}>
            Request received. The export appears below as soon as it is prepared.
          </p>
        ) : null}

        <form onSubmit={request} className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <div className="label">Scope</div>
            <select
              value={scope}
              onChange={(e) => {
                setScope(e.target.value as typeof scope);
                setTargetId("");
              }}
              data-testid="export-scope"
              className="mt-2 rounded-[2px] border px-3 py-2.5 text-[13px]"
              style={{
                background: "var(--color-elevate)",
                borderColor: "var(--color-line-strong)",
                color: "var(--color-ink)",
              }}
            >
              <option value="ORGANIZATION">whole workspace</option>
              <option value="CLIENT">one client</option>
            </select>
          </div>

          {scope === "CLIENT" ? (
            <div>
              <div className="label">Client</div>
              <select
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                required
                data-testid="export-target"
                className="mt-2 rounded-[2px] border px-3 py-2.5 text-[13px]"
                style={{
                  background: "var(--color-elevate)",
                  borderColor: "var(--color-line-strong)",
                  color: "var(--color-ink)",
                }}
              >
                <option value="">choose a client…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          ) : null}

          <div>
            <div className="label">Format</div>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as "JSON" | "CSV")}
              className="mt-2 rounded-[2px] border px-3 py-2.5 text-[13px]"
              style={{
                background: "var(--color-elevate)",
                borderColor: "var(--color-line-strong)",
                color: "var(--color-ink)",
              }}
            >
              <option value="JSON">JSON</option>
              <option value="CSV">CSV</option>
            </select>
          </div>

          <ActionButton
            type="submit"
            label={"Request export"}
            loadingLabel={"Requesting…"}
            busy={busy}
            disabled={(scope === "CLIENT" && !targetId)}
            testId="export-request"
          />
        </form>
      </section>

      <section
        className="lift rounded-[2px] border p-5"
        style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      >
        <h2 className="text-[16px] font-semibold tracking-[-0.012em]">Your export requests</h2>
        {jobs.length === 0 ? (
          <p className="mt-3 text-[13px]" style={{ color: "var(--color-ink-3)" }}>
            No export requests yet.
          </p>
        ) : (
          <ul className="mt-3">
            {jobs.map((j) => {
              const expired = new Date(j.expiresAt).getTime() < Date.now();
              const revoked = Boolean(j.revokedAt);
              const ready = Boolean(j.downloadUrl) && !expired && !revoked;
              return (
                <li
                  key={j.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b py-3"
                  style={{ borderColor: "rgba(255,255,255,0.055)" }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="num text-[12.5px]" style={{ color: "var(--color-ink)" }}>
                      {j.scope.toLowerCase()} · {j.format}
                    </div>
                    <div className="num text-[11px]" style={{ color: "var(--color-ink-3)" }}>
                      {ready
                        ? `link live until ${new Date(j.expiresAt).toLocaleString("en-GB")}`
                        : revoked
                          ? "revoked"
                          : expired
                            ? "expired"
                            : "preparing"}
                    </div>
                  </div>
                  {ready ? (
                    <a
                      href={j.downloadUrl}
                      className="rounded-[2px] border px-3.5 py-1.5 text-[12px] font-semibold"
                      style={{ borderColor: "var(--color-line-strong)", color: "var(--color-ink-2)" }}
                      data-testid="export-download"
                    >
                      download
                    </a>
                  ) : (
                    <span
                      className="num text-[10px] tracking-[0.12em] uppercase"
                      style={{ color: "var(--color-ink-3)" }}
                    >
                      {revoked ? "revoked" : expired ? "expired" : "preparing"}
                    </span>
                  )}
                  {!revoked ? (
                    <button
                      type="button"
                      onClick={async () => {
                        await revokeExportJob(organizationId, j.id);
                        router.refresh();
                      }}
                      className="text-[11.5px] underline"
                      style={{ color: "var(--color-block)" }}
                      data-testid="export-revoke"
                    >
                      revoke
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
