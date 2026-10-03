"use client";

/**
 * erasure-client.tsx — erasure of personal data. Destructive and irreversible.
 *
 * This form must never read like an ordinary settings form. The API's own
 * lifecycle is the safety rail and the UI presents it: PREVIEW (what a request
 * would delete, anonymise and retain — before anything happens) → REQUEST
 * (202, enters a grace period) → EXECUTE (after the grace period, irreversible).
 * Cancel is offered until the grace period ends.
 *
 * The wording states plainly that this erases CUSTOMER data — the data their
 * clients' recipients sent through their domains. Free on every plan, because
 * erasure is a right, not a paid feature.
 */

import { ActionButton } from "@/components/action-button";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  cancelErasureJob,
  requestErasureJob,
} from "@/lib/ops-client";
import type { ApiErrorBody, ErasurePreview, ErasureRequestRow } from "@/lib/types";

export function ErasurePanel({
  organizationId,
  preview,
  requests,
  clients,
}: {
  organizationId: string;
  preview: ErasurePreview | null;
  requests: ErasureRequestRow[];
  clients: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [scope, setScope] = useState<"ORGANIZATION" | "CLIENT" | "DOMAIN">("ORGANIZATION");
  const [targetId, setTargetId] = useState("");
  const [reason, setReason] = useState("");
  const [confirmWord, setConfirmWord] = useState("");
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);
  const [created, setCreated] = useState<{ id: string; purgeAfter: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // The pending state survives a reload: the server's request list carries the
  // row, so a pending request is pending on every render: not only in the
  // moment it was created. A grace period nobody can see is not a grace period.
  const pendingRequest = created
    ? { id: created.id, purgeAfter: created.purgeAfter }
    : (requests.find((r) => r.state === "PENDING") ?? null);

  const canSubmit =
    confirmWord.trim().toUpperCase() === "ERASE" && (scope === "ORGANIZATION" || Boolean(targetId));

  async function request(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setCreated(null);
    const res = await requestErasureJob(organizationId, {
      scope,
      ...(scope !== "ORGANIZATION" && targetId ? { targetId } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setCreated({ id: res.data.id, purgeAfter: res.data.purgeAfter });
      setConfirmWord("");
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* The warning comes before the form, not after it. */}
      <section
        className="rounded-[2px] border px-5 py-5"
        style={{
          borderColor: "var(--color-block)",
          background: "var(--color-block-soft)",
        }}
        data-testid="erasure-warning"
      >
        <p
          className="num text-[11px] font-semibold tracking-[0.12em] uppercase"
          style={{ color: "var(--color-block)" }}
        >
          Destructive · irreversible
        </p>
        <h2 className="mt-2 text-[17px] font-semibold tracking-[-0.012em]" style={{ color: "var(--color-ink)" }}>
          This erases real customer data
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--color-ink-2)" }}>
          An erasure request removes personal data belonging to the people whose
          mail passed through your clients' domains: recipient identifiers,
          addresses, forensic evidence. Once executed it{" "}
          <strong style={{ color: "var(--color-ink)" }}>cannot be undone</strong>, and
          the platform keeps only what it must (anonymised audit evidence and the
          erasure certificate itself).
        </p>
        <p className="mt-2 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
          A request enters a <strong style={{ color: "var(--color-ink)" }}>grace
          period</strong> before anything is deleted: you can cancel it while it
          is pending. Export your data first if you need a copy.
        </p>
        <p className="mt-2 text-[12px]" style={{ color: "var(--color-ink-3)" }}>
          Available on every plan at no cost. Erasure of personal data is a
          right, not a paid feature.
        </p>
      </section>

      {/* The API's own preview: exactly what a request would do. */}
      {preview ? (
        <section
          className="lift rounded-[2px] border p-5"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
          data-testid="erasure-preview"
        >
          <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
            What a request would do: {preview.scopeLabel}
          </h2>
          <div className="mt-3 flex flex-wrap gap-x-8 gap-y-2">
            <Stat label="Personal data records" value={preview.totals.personalDataRecords} tone="var(--color-block)" />
            <Stat label="Records deleted" value={preview.totals.recordsDeleted} />
            <Stat label="Records anonymised" value={preview.totals.recordsAnonymised} />
            <Stat label="Evidence retained" value={preview.totals.evidenceRetained} />
          </div>
          <ul className="mt-4 border-t pt-3" style={{ borderColor: "var(--color-line)" }}>
            {preview.actions.slice(0, 8).map((a) => (
              <li key={a.key} className="flex items-baseline gap-x-4 border-b py-2" style={{ borderColor: "rgba(255,255,255,0.055)" }}>
                <span
                  className="num text-[10px] tracking-[0.12em] uppercase"
                  style={{
                    minWidth: 64,
                    color:
                      a.action === "delete"
                        ? "var(--color-block)"
                        : a.action === "anonymize"
                          ? "var(--color-unverified)"
                          : "var(--color-ink-3)",
                  }}
                >
                  {a.action}
                </span>
                <span className="text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
                  {a.label}: {a.count} record{a.count === 1 ? "" : "s"} · {a.reason}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {pendingRequest ? (
        <section
          role="status"
          data-testid="erasure-pending"
          className="rounded-[2px] border px-5 py-4"
          style={{ borderColor: "var(--color-unverified)", background: "var(--color-unverified-soft)" }}
        >
          <p className="num text-[11px] font-semibold tracking-[0.12em] uppercase" style={{ color: "var(--color-unverified)" }}>
            Request pending · grace period
          </p>
          <p className="mt-2 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
            Nothing has been deleted yet. The erasure executes on{" "}
            <strong style={{ color: "var(--color-ink)" }}>
              {new Date(pendingRequest.purgeAfter).toLocaleString("en-GB")}
            </strong>{" "}
           : you can cancel it until then, below.
          </p>
        </section>
      ) : null}

      {error ? (
        <p role="alert" className="text-[13px]" style={{ color: "var(--color-block)" }}>
          {error.message}
        </p>
      ) : null}

      <section
        className="lift rounded-[2px] border p-5"
        style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      >
        <h2 className="text-[16px] font-semibold tracking-[-0.012em]">Request an erasure</h2>
        <form onSubmit={request} className="mt-4 flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <div className="label">Scope</div>
              <select
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value as typeof scope);
                  setTargetId("");
                }}
                data-testid="erasure-scope"
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
                  data-testid="erasure-target"
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
            <div className="min-w-[220px] flex-1">
              <div className="label">Reason (optional, for the audit record)</div>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={280}
                placeholder="client data-subject request, ticket #482"
                className="mt-2 w-full rounded-[2px] border px-3.5 py-2.5 text-[13px] outline-none"
                style={{
                  background: "var(--color-elevate)",
                  borderColor: "var(--color-line-strong)",
                  color: "var(--color-ink)",
                }}
              />
            </div>
          </div>

          <div>
            <div className="label">
              Type ERASE to confirm: this cannot be undone
            </div>
            <input
              value={confirmWord}
              onChange={(e) => setConfirmWord(e.target.value)}
              placeholder="ERASE"
              autoComplete="off"
              data-testid="erasure-confirm"
              className="mt-2 w-full max-w-[220px] rounded-[2px] border px-3.5 py-2.5 text-[13px] outline-none"
              style={{
                background: "var(--color-elevate)",
                borderColor: confirmWord.trim().toUpperCase() === "ERASE" ? "var(--color-block)" : "var(--color-line-strong)",
                color: "var(--color-ink)",
              }}
            />
          </div>

          <ActionButton
            type="submit"
            label={"Request erasure"}
            loadingLabel={"Requesting…"}
            busy={busy}
            disabled={!canSubmit}
            testId="erasure-submit"
          />
        </form>

        {requests.length > 0 ? (
          <ul className="mt-6 border-t pt-3" style={{ borderColor: "var(--color-line)" }}>
            {requests.map((r) => (
              <li
                key={r.id}
                data-testid="erasure-row"
                data-erasure-state={r.state}
                className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b py-3"
                style={{ borderColor: "rgba(255,255,255,0.055)" }}
              >
                <div className="min-w-0 flex-1">
                  <div className="num text-[12.5px]" style={{ color: "var(--color-ink)" }}>
                    {r.scope.toLowerCase()}
                    {r.reason ? ` · ${r.reason}` : ""}
                  </div>
                  <div className="num text-[11px]" style={{ color: "var(--color-ink-3)" }}>
                    {r.state === "PENDING"
                      ? `executes ${new Date(r.purgeAfter).toLocaleString("en-GB")}`
                      : r.state.toLowerCase()}
                  </div>
                </div>
                <span
                  className="num text-[10px] tracking-[0.12em] uppercase"
                  style={{
                    color:
                      r.state === "PENDING"
                        ? "var(--color-unverified)"
                        : r.state === "EXECUTED"
                          ? "var(--color-block)"
                          : "var(--color-ink-3)",
                  }}
                >
                  {r.state.toLowerCase()}
                </span>
                {r.state === "PENDING" ? (
                  <button
                    type="button"
                    onClick={async () => {
                      await cancelErasureJob(organizationId, r.id);
                      router.refresh();
                    }}
                    className="text-[11.5px] underline"
                    style={{ color: "var(--color-pass)" }}
                    data-testid="erasure-cancel"
                  >
                    cancel
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="num mt-1 text-[21px] font-semibold" style={{ color: tone ?? "var(--color-ink)" }}>
        {value.toLocaleString("en-US")}
      </div>
    </div>
  );
}
