"use client";

/**
 * digests-client.tsx — scheduled client report emails.
 *
 * Field names follow the API contract exactly: frequency (NOT cadence),
 * sendHourUtc 0-23, weekday 0-6 for WEEKLY, dayOfMonth 1-28 for MONTHLY,
 * recipientEmails 1-20, includeForensics.
 *
 * dayOfMonth is capped at 28 ON PURPOSE — every month has a 28th, and a
 * digest on the 31st would silently skip February. The form says so; it does
 * not "fix" the range.
 *
 * includeForensics is only offered when the workspace holds reports.forensic:
 * a digest with forensic content is never available without that entitlement,
 * and portal contacts never receive it.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EntitlementNotice } from "@/components/entitlement-gate";
import {
  createReportDigest,
  patchReportDigest,
  removeReportDigest,
} from "@/lib/ops-client";
import type { ApiErrorBody, ReportDigestRow } from "@/lib/types";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function DigestForm({
  organizationId,
  domains,
  allowForensics,
}: {
  organizationId: string;
  domains: Array<{ id: string; name: string }>;
  allowForensics: boolean;
}) {
  const router = useRouter();
  const [domainId, setDomainId] = useState(domains[0]?.id ?? "");
  const [frequency, setFrequency] = useState<"WEEKLY" | "MONTHLY">("WEEKLY");
  const [sendHourUtc, setSendHourUtc] = useState(9);
  const [weekday, setWeekday] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [recipientText, setRecipientText] = useState("");
  const [includeForensics, setIncludeForensics] = useState(false);
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);
  const [busy, setBusy] = useState(false);

  const recipients = recipientText
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await createReportDigest(organizationId, {
      domainId,
      frequency,
      sendHourUtc,
      weekday,
      dayOfMonth,
      recipientEmails: recipients,
      includeForensics,
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setRecipientText("");
      router.refresh();
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="lift flex flex-col gap-4 rounded-[2px] border p-5"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
    >
      <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">New digest</h2>

      {error ? (
        error.code === "FEATURE_NOT_IN_PLAN" ? (
          <EntitlementNotice error={error} />
        ) : (
          <p role="alert" className="text-[14px]" style={{ color: "var(--color-block)" }}>
            {error.message}
          </p>
        )
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Domain">
          <select value={domainId} onChange={(e) => setDomainId(e.target.value)} required>
            {domains.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Frequency">
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as "WEEKLY" | "MONTHLY")}
          >
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option>
          </select>
        </Field>
        <Field label="Send hour (UTC, 0-23)">
          <input
            type="number"
            min={0}
            max={23}
            value={sendHourUtc}
            onChange={(e) => setSendHourUtc(Number(e.target.value))}
            required
          />
        </Field>
        {frequency === "WEEKLY" ? (
          <Field label="Weekday (0 = Sunday)">
            <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>{d}</option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Day of month (1-28)">
            <input
              type="number"
              min={1}
              max={28}
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(Number(e.target.value))}
              required
            />
          </Field>
        )}
      </div>

      {frequency === "MONTHLY" ? (
        <p className="text-[13px]" style={{ color: "var(--color-ink-3)" }}>
          Capped at the 28th on purpose: every month has one. A digest set for
          the 31st would silently skip February.
        </p>
      ) : null}

      <Field label="Recipients (1-20, comma separated)">
        <input
          type="text"
          value={recipientText}
          onChange={(e) => setRecipientText(e.target.value)}
          placeholder="ops@client.example, cto@client.example"
          required
        />
      </Field>

      <label className="flex items-start gap-2.5 text-[13.5px]" style={{ color: "var(--color-ink-2)" }}>
        <input
          type="checkbox"
          checked={includeForensics}
          disabled={!allowForensics}
          onChange={(e) => setIncludeForensics(e.target.checked)}
        />
        <span>
          Include forensic evidence
          {!allowForensics ? (
            <span style={{ color: "var(--color-ink-3)" }}>
              {" "}— not available on your current plan
            </span>
          ) : null}
        </span>
      </label>

      <button
        type="submit"
        disabled={busy || !domainId || recipients.length === 0 || recipients.length > 20}
        className="mt-1 rounded-[2px] px-5 py-2.5 text-[14.5px] font-semibold"
        style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
      >
        {busy ? "Creating…" : "Create digest"}
      </button>
    </form>
  );
}

export function DigestActions({
  organizationId,
  digest,
}: {
  organizationId: string;
  digest: ReportDigestRow;
}) {
  const router = useRouter();
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={async () => {
          await patchReportDigest(organizationId, digest.id, { enabled: !digest.enabled });
          router.refresh();
        }}
        className="text-[12.5px] underline"
        style={{ color: "var(--color-ink-2)" }}
      >
        {digest.enabled ? "pause" : "resume"}
      </button>
      <button
        type="button"
        onClick={async () => {
          await removeReportDigest(organizationId, digest.id);
          router.refresh();
        }}
        className="text-[12.5px] underline"
        style={{ color: "var(--color-block)" }}
      >
        delete
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      {children}
      <style>{`
        label select, label input[type="number"], label input[type="text"], label input:not([type]) {
          background: var(--color-elevate);
          border: 1px solid var(--color-line-strong);
          border-radius: 2px;
          color: var(--color-ink);
          padding: 7px 10px;
          font-size: 14px;
          outline: none;
        }
      `}</style>
    </label>
  );
}
