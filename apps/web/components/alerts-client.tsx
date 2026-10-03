"use client";

/**
 * alerts-client.tsx — the alert rule form and event actions.
 *
 * The create form carries ALL NINE required fields the API demands
 * (domainId, name, metric, operator, threshold, windowMinutes, cooldownMinutes,
 * maxReminderLevel, recipientUserIds — note recipientUserIds, not recipients).
 * A field the API requires is never optional here.
 *
 * Operators: only the three the live API accepts
 * (GREATER_THAN, GREATER_THAN_OR_EQUAL, LESS_THAN). LESS_THAN_OR_EQUAL and
 * EQUAL return 400 "A complete alert rule definition is required." — verified
 * against the running API, not assumed from docs.
 *
 * REPORT_SILENCE carries the same honesty as the postures: the metric option
 * is labelled so a stopped feed reads as silence, not health.
 */

import { ActionButton } from "@/components/action-button";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { EntitlementNotice } from "@/components/entitlement-gate";
import {
  acknowledgeAlert,
  createAlertRule,
  patchAlertRule,
  removeAlertRule,
} from "@/lib/ops-client";
import type { AlertRuleRow, ApiErrorBody, WorkspaceMemberRow } from "@/lib/types";

const METRICS: Array<{ key: string; label: string; note?: string }> = [
  { key: "FAILURE_COUNT", label: "Failed messages (count)" },
  { key: "FAILURE_RATE", label: "Failed messages (% of volume)" },
  { key: "SOURCE_IP_VOLUME", label: "Source IP volume" },
  { key: "FORENSIC_FAILURES", label: "Forensic failures" },
  {
    key: "REPORT_SILENCE",
    label: "Report silence",
    note: "a feed that stopped is not quiet and not healthy — this rule names the silence",
  },
  { key: "NEW_UNAUTHENTICATED_SOURCE", label: "New unauthenticated source" },
];

const OPERATORS: Array<{ key: string; label: string }> = [
  { key: "GREATER_THAN", label: "greater than" },
  { key: "GREATER_THAN_OR_EQUAL", label: "greater than or equal" },
  { key: "LESS_THAN", label: "less than" },
];

export function AlertRuleForm({
  organizationId,
  domains,
  members,
}: {
  organizationId: string;
  domains: Array<{ id: string; name: string }>;
  members: WorkspaceMemberRow[];
}) {
  const router = useRouter();
  const [domainId, setDomainId] = useState(domains[0]?.id ?? "");
  const [name, setName] = useState("");
  const [metric, setMetric] = useState("FAILURE_COUNT");
  const [operator, setOperator] = useState("GREATER_THAN");
  const [threshold, setThreshold] = useState(10);
  const [windowMinutes, setWindowMinutes] = useState(1440);
  const [cooldownMinutes, setCooldownMinutes] = useState(1440);
  const [maxReminderLevel, setMaxReminderLevel] = useState(3);
  const [recipients, setRecipients] = useState<string[]>([
    members[0]?.userId ?? "",
  ]);
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedMetric = METRICS.find((m) => m.key === metric);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (recipients.filter(Boolean).length === 0) return;
    setBusy(true);
    setError(null);
    const res = await createAlertRule(organizationId, {
      domainId,
      name,
      metric,
      operator,
      threshold,
      windowMinutes,
      cooldownMinutes,
      maxReminderLevel,
      recipientUserIds: recipients.filter(Boolean),
    });
    setBusy(false);
    if (!res.ok) setError(res.error);
    else {
      setName("");
      router.refresh();
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="lift flex flex-col gap-4 rounded-[2px] border p-5"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
    >
      <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">New alert rule</h2>

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
        <Field label="Rule name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={3}
            maxLength={100}
            placeholder="Reject spike on acmefreight.com"
          />
        </Field>
        <Field label="Metric">
          <select value={metric} onChange={(e) => setMetric(e.target.value)}>
            {METRICS.map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Operator">
          <select value={operator} onChange={(e) => setOperator(e.target.value)}>
            {OPERATORS.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
        </Field>
        <Field label={metric === "FAILURE_RATE" ? "Threshold (percent)" : "Threshold"}>
          <input
            type="number"
            min={0}
            max={1000000}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            required
          />
        </Field>
        <Field label="Window (minutes)">
          <input
            type="number"
            min={5}
            max={43200}
            value={windowMinutes}
            onChange={(e) => setWindowMinutes(Number(e.target.value))}
            required
          />
        </Field>
        <Field label="Cooldown (minutes)">
          <input
            type="number"
            min={5}
            max={43200}
            value={cooldownMinutes}
            onChange={(e) => setCooldownMinutes(Number(e.target.value))}
            required
          />
        </Field>
        <Field label="Max reminder level (1-5)">
          <input
            type="number"
            min={1}
            max={5}
            value={maxReminderLevel}
            onChange={(e) => setMaxReminderLevel(Number(e.target.value))}
            required
          />
        </Field>
      </div>

      <Field label="Recipients">
        <div className="flex flex-col gap-1.5">
          {members.map((m) => {
            const uid = m.userId ?? m.user?.id ?? m.id;
            const on = recipients.includes(uid);
            return (
              <label key={m.id} className="flex items-center gap-2 text-[13.5px]" style={{ color: "var(--color-ink-2)" }}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    setRecipients((prev) =>
                      on ? prev.filter((r) => r !== uid) : [...prev, uid],
                    )
                  }
                />
                {m.user?.name ?? m.user?.email ?? uid}
                <span className="num text-[11.5px] tracking-[0.12em] uppercase" style={{ color: "var(--color-ink-3)" }}>
                  {m.role}
                </span>
              </label>
            );
          })}
        </div>
      </Field>

      {selectedMetric?.note ? (
        <p className="text-[13px]" style={{ color: "var(--color-unmeasured)" }}>
          {selectedMetric.note}
        </p>
      ) : null}

      <ActionButton
        type="submit"
        label={"Create alert rule"}
        loadingLabel={"Creating…"}
        busy={busy}
        disabled={!domainId}
        style={{ marginTop: 4 }}
      />
    </form>
  );
}

export function AlertRuleActions({
  organizationId,
  rule,
}: {
  organizationId: string;
  rule: AlertRuleRow;
}) {
  const router = useRouter();
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={async () => {
          await patchAlertRule(organizationId, rule.id, { enabled: !rule.enabled });
          router.refresh();
        }}
        className="text-[12.5px] underline"
        style={{ color: "var(--color-ink-2)" }}
      >
        {rule.enabled ? "disable" : "enable"}
      </button>
      <button
        type="button"
        onClick={async () => {
          await removeAlertRule(organizationId, rule.id);
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

export function AcknowledgeButton({
  organizationId,
  eventId,
}: {
  organizationId: string;
  eventId: string;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await acknowledgeAlert(organizationId, eventId);
        router.refresh();
      }}
      className="rounded-[2px] border px-3 py-1.5 text-[12.5px] font-semibold"
      style={{ borderColor: "var(--color-line-strong)", color: "var(--color-ink-2)" }}
    >
      Acknowledge
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
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
