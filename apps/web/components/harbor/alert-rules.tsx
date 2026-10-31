"use client";

/**
 * alert-rules.tsx — the rules that are watching, as one table.
 *
 * Each rule reads as a sentence (the condition in its own units), then how it
 * nags (reminder interval and limit), who it tells, and when it last fired.
 * The switch takes effect the moment it is flipped (PATCH enabled), which is
 * why it is a switch and not a checkbox. Editing changes what the API lets a
 * rule change: name, threshold, window, cooldown, reminders and recipients.
 * What a rule measures (domain, metric, operator) is fixed once created; the
 * edit dialog says so instead of offering fields the API ignores.
 *
 * Changing or deleting a rule needs alerts.email on the plan. Without it the
 * controls are disabled with the reason, and the rules stay readable.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LIMITS, METRICS, OPERATORS, conditionLabel, minutesLabel, valueWithUnit } from "@/lib/alert-rules";
import { patchAlertRule, removeAlertRule } from "@/lib/ops-client";
import { domainHref } from "@/lib/route-hrefs";
import type { AlertRuleRow } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/choice";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { KeyValue } from "@/components/ui/notice";
import { RecipientPicker, type MemberChoice } from "./alert-rule-form";
import { StateMark } from "./ops-parts";
import { ActionRefusal, type ActionError } from "./plan-refusal";

export interface RuleView extends AlertRuleRow {
  domainSlug: string | null;
  lastFiredLabel: string | null;
  recipientNames: string[];
  cooldownLabel: string;
  /** The client that owns the domain, when the client list was readable. */
  clientName?: string | null;
}

/** "Fires when report silence is greater than 48h": the rule as a sentence. */
function ruleSentence(r: Pick<AlertRuleRow, "metric" | "operator" | "threshold" | "windowMinutes">): string {
  const meta = METRICS[r.metric];
  if (!meta) return conditionLabel(r);
  const op = OPERATORS.find((o) => o.value === r.operator)?.label ?? r.operator.toLowerCase().replace(/_/g, " ");
  const what = meta.label.charAt(0).toLowerCase() + meta.label.slice(1);
  const over = meta.usesWindow ? `, over ${minutesLabel(r.windowMinutes)}` : "";
  return `Fires when ${what} is ${op} ${valueWithUnit(r.metric, r.threshold)}${over}`;
}

export function AlertRules({
  organizationId,
  rules,
  members,
  editable,
  unwatched,
}: {
  organizationId: string;
  rules: RuleView[];
  members: MemberChoice[];
  editable: boolean;
  /** Domains no enabled rule watches, by name. */
  unwatched?: string[];
}) {
  const router = useRouter();
  const [toggling, setToggling] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; error: ActionError } | null>(null);
  const [editing, setEditing] = useState<RuleView | null>(null);
  const [deleting, setDeleting] = useState<RuleView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function toggle(rule: RuleView, next: boolean) {
    setToggling(rule.id);
    setRowError(null);
    const res = await patchAlertRule(organizationId, rule.id, { enabled: next });
    setToggling(null);
    if (!res.ok) {
      setRowError({ id: rule.id, error: res.error });
      return;
    }
    router.refresh();
  }

  async function remove() {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    const res = await removeAlertRule(organizationId, deleting.id);
    setDeleteBusy(false);
    if (!res.ok) {
      setDeleteError(res.error.message ?? "The rule could not be deleted.");
      return;
    }
    setDeleting(null);
    router.refresh();
  }

  if (rules.length === 0) {
    return (
      <div role="status" className="border-y border-rule py-6">
        <p className="flex items-center gap-2 text-body font-semibold text-fg">
          <StateMark shape="hatch" tone="void" />
          No alert rules yet
        </p>
        <p className="mt-1 max-w-[64ch] pl-[17px] text-ui text-fg-2">
          Nothing is watching. A first rule worth having on every domain: report silence over 48 hours, so a feed that
          stops is noticed rather than mistaken for a quiet week.
        </p>
        {editable ? (
          <p className="mt-2 max-w-[64ch] pl-[17px] text-meta text-fg-3">
            In the form: pick the domain, set Metric to <span className="font-semibold text-fg-2">Report silence</span>{" "}
            and keep <span className="font-semibold text-fg-2">greater than 48</span>. Then do the same for the next domain.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <>
      {!editable ? (
        <p className="text-meta text-fg-3">Rules are read-only here: changing them needs alerting on the plan.</p>
      ) : null}
      <ul className="flex flex-col border-y border-rule">
        {rules.map((r) => (
          <li
            key={r.id}
            data-rule-id={r.id}
            className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 border-b border-rule py-3.5 last:border-b-0 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
          >
            <div className="pt-[1px]">
              <Switch
                checked={r.enabled}
                onChange={(next) => toggle(r, next)}
                label={`${r.enabled ? "Pause" : "Resume"} ${r.name}`}
                busy={toggling === r.id}
                disabled={!editable}
              />
            </div>
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                <span className={r.enabled ? "text-ui font-semibold text-fg" : "text-ui font-semibold text-fg-3"}>{r.name}</span>
                {r.domainSlug ? (
                  <Link href={domainHref(r.domainSlug)} className="data text-meta text-fg-3 hover:text-act hover:underline">
                    {r.domain.name}
                  </Link>
                ) : (
                  <span className="data text-meta text-fg-3">{r.domain.name}</span>
                )}
                {r.clientName ? <span className="text-meta text-fg-3">{r.clientName}</span> : null}
                {!r.enabled ? <span className="text-meta font-semibold text-fg-3">Paused</span> : null}
              </p>
              <p className={r.enabled ? "mt-0.5 text-ui text-fg-2" : "mt-0.5 text-ui text-fg-3"}>{ruleSentence(r)}</p>
              <p className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-meta text-fg-3">
                {r.recipientNames.length ? (
                  <span>
                    Wakes <span className="font-semibold text-fg-2">{r.recipientNames.join(", ")}</span>
                  </span>
                ) : (
                  <span className="font-semibold text-warn" data-testid="rule-no-recipients">
                    No recipients: it records events, but nobody is told{editable ? ". Edit to add someone." : "."}
                  </span>
                )}
                <span>
                  Reminds every {r.cooldownLabel} until acknowledged, {r.maxReminderLevel} notice{r.maxReminderLevel === 1 ? "" : "s"} at most
                </span>
                <span className="tnum">{r.lastFiredLabel ? `Last fired ${r.lastFiredLabel}` : "Has not fired"}</span>
              </p>
              {rowError?.id === r.id ? <ActionRefusal error={rowError.error} className="mt-2" /> : null}
            </div>
            <div className="col-start-2 flex items-start gap-1 sm:col-start-3">
              <Button size="sm" variant="ghost" onClick={() => setEditing(r)} disabled={!editable}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDeleteError(null);
                  setDeleting(r);
                }}
                disabled={!editable}
                data-testid={`delete-rule-${r.id}`}
              >
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {unwatched && unwatched.length > 0 ? (
        <p className="flex items-baseline gap-2 text-meta text-fg-3" data-testid="rules-unwatched">
          <span className="relative top-[1px]">
            <StateMark shape="hatch" tone="void" />
          </span>
          <span>
            <span className="font-semibold text-fg-2">
              {unwatched.length} domain{unwatched.length === 1 ? " has" : "s have"} no enabled rule:
            </span>{" "}
            <span className="data">{unwatched.slice(0, 8).join(", ")}</span>
            {unwatched.length > 8 ? ` and ${unwatched.length - 8} more` : ""}. A report-silence rule is the one every
            domain should have.
          </span>
        </p>
      ) : null}

      <EditRule organizationId={organizationId} rule={editing} members={members} onClose={() => setEditing(null)} />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        busy={deleteBusy}
        error={deleteError}
        danger
        testId="delete-rule"
        title={`Delete "${deleting?.name ?? ""}"?`}
        confirmLabel="Delete rule"
        body="The domain stops being watched for this condition. Events it already raised stay on record. To stop it for a while instead, pause it with its switch."
      />
    </>
  );
}

function EditRule({
  organizationId,
  rule,
  members,
  onClose,
}: {
  organizationId: string;
  rule: RuleView | null;
  members: MemberChoice[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [shownFor, setShownFor] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [threshold, setThreshold] = useState("");
  const [windowMinutes, setWindow] = useState("");
  const [cooldown, setCooldown] = useState("");
  const [reminders, setReminders] = useState("");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);

  // Load the rule's values each time a different rule is opened.
  if (rule && rule.id !== shownFor) {
    setShownFor(rule.id);
    setName(rule.name);
    setThreshold(String(rule.threshold));
    setWindow(String(rule.windowMinutes));
    setCooldown(String(rule.cooldownMinutes));
    setReminders(String(rule.maxReminderLevel));
    setRecipients(rule.recipients.map((r) => r.userId).filter((id) => members.some((m) => m.userId === id)));
    setError(null);
  }

  const n = Number;
  const valid =
    name.trim().length >= LIMITS.name.min &&
    Number.isInteger(n(threshold)) &&
    n(threshold) >= 0 &&
    n(threshold) <= LIMITS.threshold.max &&
    [windowMinutes, cooldown].every((v) => Number.isInteger(n(v)) && n(v) >= LIMITS.minutes.min && n(v) <= LIMITS.minutes.max) &&
    recipients.length > 0;

  async function save() {
    if (!rule || !valid || busy) return;
    setBusy(true);
    setError(null);
    const res = await patchAlertRule(organizationId, rule.id, {
      name: name.trim(),
      threshold: n(threshold),
      windowMinutes: n(windowMinutes),
      cooldownMinutes: n(cooldown),
      maxReminderLevel: n(reminders),
      recipientUserIds: recipients,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onClose();
    router.refresh();
  }

  const meta = rule ? METRICS[rule.metric] : null;

  return (
    <Dialog
      open={rule !== null}
      onClose={busy ? () => {} : onClose}
      title={rule ? `Edit "${rule.name}"` : ""}
      testId="edit-rule"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!valid} busy={busy} busyLabel="Saving">
            Save changes
          </Button>
        </>
      }
    >
      {rule && meta ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="flex flex-col gap-3.5"
        >
          <KeyValue
            labelWidth={90}
            rows={[
              ["Domain", <span key="d" className="data">{rule.domain.name}</span>],
              ["Fires when", conditionLabel({ ...rule, threshold: n(threshold) || 0, windowMinutes: n(windowMinutes) || 0 })],
            ]}
          />
          <p className="-mt-1 text-meta text-fg-3">
            What a rule measures is fixed once it exists. For a different metric or operator, create a new rule.
          </p>
          <Field label="Rule name">
            <Input value={name} onChange={(e) => setName(e.target.value)} minLength={3} maxLength={100} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Threshold" hint={`In ${meta.unit.many === "%" ? "whole percent" : meta.unit.many}.`}>
              <Input type="number" min={0} max={LIMITS.threshold.max} step={1} value={threshold} onChange={(e) => setThreshold(e.target.value)} className="tnum" />
            </Field>
            <Field label="Max reminder level">
              <Select value={reminders} onChange={(e) => setReminders(e.target.value)} className="w-full">
                {[1, 2, 3, 4, 5].map((v) => (
                  <option key={v} value={String(v)}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Window (minutes)" hint={meta.usesWindow ? `= ${minutesLabel(n(windowMinutes))}` : "Not used by this metric."}>
              <Input type="number" min={5} max={43200} step={1} value={windowMinutes} onChange={(e) => setWindow(e.target.value)} className="tnum" />
            </Field>
            <Field label="Cooldown (minutes)" hint={`= ${minutesLabel(n(cooldown))}`}>
              <Input type="number" min={5} max={43200} step={1} value={cooldown} onChange={(e) => setCooldown(e.target.value)} className="tnum" />
            </Field>
          </div>
          <RecipientPicker members={members} value={recipients} onChange={setRecipients} />
          <ActionRefusal error={error} />
        </form>
      ) : null}
    </Dialog>
  );
}
