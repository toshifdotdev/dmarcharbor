"use client";

/**
 * alert-rule-form.tsx — a new alert rule, with all nine fields the API takes.
 *
 * Each field says what it does in the units the API uses, so nobody types
 * "24" into a minutes box meaning a day: windows and cooldowns are entered in
 * minutes (the API's unit) with the duration read back beside them, and the
 * threshold names its unit for the chosen metric. Choosing a metric offers a
 * sensible starting threshold until the threshold is edited, and says plainly
 * when the window does not apply (silence and new-source rules measure their
 * own span).
 *
 * Under the fields the rule is drawn as the route it will run (ops-parts.tsx
 * RouteList): the domain it watches, the station where it fires and who it
 * tells, each reminder still to come dashed, and the workspace owner at the
 * end, where an event nobody acknowledges rolls up. Level 1 is the first
 * notice; each reminder adds one, up to the max level (the API's own ladder,
 * alert.service.ts evaluateAlertRules).
 *
 * Only the three operators the API accepts are offered. The new-source metric
 * needs alerts.spoofing; when the plan lacks it the option is shown disabled
 * with the reason, not hidden.
 */

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { DEFAULTS, LIMITS, METRIC_ORDER, METRICS, OPERATORS, minutesLabel } from "@/lib/alert-rules";
import { createAlertRule } from "@/lib/ops-client";
import type { AlertMetric, AlertOperator } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { Field, Input, Select } from "@/components/ui/field";
import { RouteList, StateMark } from "./ops-parts";
import { ActionRefusal, type ActionError } from "./plan-refusal";

export interface MemberChoice {
  userId: string;
  label: string;
  email: string | null;
  role: string;
}

export function RecipientPicker({
  members,
  value,
  onChange,
  legend = "Recipients",
}: {
  members: MemberChoice[];
  value: string[];
  onChange: (next: string[]) => void;
  legend?: string;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-meta font-semibold text-fg-2">{legend}</legend>
      {members.length === 0 ? (
        <p className="text-meta text-fg-3">No workspace members could be listed.</p>
      ) : (
        <div className="flex max-h-[176px] flex-col gap-2.5 overflow-y-auto rounded-ctl border border-rule-2 bg-paper px-3 py-2.5">
          {members.map((m) => (
            <Checkbox
              key={m.userId}
              checked={value.includes(m.userId)}
              onChange={(e) => onChange(e.target.checked ? [...value, m.userId] : value.filter((v) => v !== m.userId))}
              label={m.label}
              hint={[m.email && m.email !== m.label ? m.email : null, m.role].filter(Boolean).join(" · ")}
            />
          ))}
        </div>
      )}
      <p className="text-meta text-fg-3">
        {value.length === 0 ? (
          <span className="text-warn">Choose at least one person.</span>
        ) : (
          "Each gets the email and the in-app notification, subject to their own quiet hours."
        )}
      </p>
    </fieldset>
  );
}

function minutesHint(raw: string): string {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < LIMITS.minutes.min || n > LIMITS.minutes.max) {
    return `${LIMITS.minutes.min} to ${LIMITS.minutes.max.toLocaleString("en-GB")} minutes (30 days).`;
  }
  return `= ${minutesLabel(n)}`;
}

export function AlertRuleForm({
  organizationId,
  domainGroups,
  members,
  defaultRecipient,
  spoofing,
}: {
  organizationId: string;
  domainGroups: Array<{ clientName: string; domains: Array<{ id: string; name: string }> }>;
  members: MemberChoice[];
  defaultRecipient: string | null;
  spoofing: boolean | null;
}) {
  const router = useRouter();
  const id = useId();
  const firstDomain = domainGroups[0]?.domains[0] ?? null;
  const [domainId, setDomainId] = useState(firstDomain?.id ?? "");
  const [metric, setMetric] = useState<AlertMetric>("FAILURE_COUNT");
  const [operator, setOperator] = useState<AlertOperator>(METRICS.FAILURE_COUNT.suggested.operator);
  const [threshold, setThreshold] = useState(String(METRICS.FAILURE_COUNT.suggested.threshold));
  const [thresholdTouched, setThresholdTouched] = useState(false);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [windowMinutes, setWindow] = useState(String(DEFAULTS.windowMinutes));
  const [cooldown, setCooldown] = useState(String(DEFAULTS.cooldownMinutes));
  const [reminders, setReminders] = useState(String(DEFAULTS.maxReminderLevel));
  const [recipients, setRecipients] = useState<string[]>(
    defaultRecipient && members.some((m) => m.userId === defaultRecipient) ? [defaultRecipient] : members[0] ? [members[0].userId] : [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const meta = METRICS[metric];
  const domainName = domainGroups.flatMap((g) => g.domains).find((d) => d.id === domainId)?.name ?? "";
  const clientName = domainGroups.find((g) => g.domains.some((d) => d.id === domainId))?.clientName ?? null;
  const toldNames = members.filter((m) => recipients.includes(m.userId)).map((m) => m.label);
  const toldLabel =
    toldNames.length === 0 ? "nobody yet" : toldNames.length <= 2 ? toldNames.join(" and ") : `${toldNames[0]} and ${toldNames.length - 1} others`;
  const suggestedName = domainName ? `${meta.label} on ${domainName}` : meta.label;
  const effectiveName = nameTouched ? name : suggestedName.slice(0, LIMITS.name.max);

  const n = (v: string) => Number(v);
  const valid =
    Boolean(domainId) &&
    effectiveName.trim().length >= LIMITS.name.min &&
    Number.isInteger(n(threshold)) &&
    n(threshold) >= LIMITS.threshold.min &&
    n(threshold) <= LIMITS.threshold.max &&
    [windowMinutes, cooldown].every((v) => Number.isInteger(n(v)) && n(v) >= LIMITS.minutes.min && n(v) <= LIMITS.minutes.max) &&
    Number.isInteger(n(reminders)) &&
    n(reminders) >= LIMITS.reminders.min &&
    n(reminders) <= LIMITS.reminders.max &&
    recipients.length >= 1 &&
    !(metric === "NEW_UNAUTHENTICATED_SOURCE" && spoofing === false);

  function chooseMetric(next: AlertMetric) {
    setMetric(next);
    if (!thresholdTouched) {
      setThreshold(String(METRICS[next].suggested.threshold));
      setOperator(METRICS[next].suggested.operator);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    setCreated(null);
    const res = await createAlertRule(organizationId, {
      domainId,
      name: effectiveName.trim(),
      metric,
      operator,
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
    setCreated(effectiveName.trim());
    // A confirmation, not a state: the rules list is the record from here on.
    setTimeout(() => setCreated(null), 6000);
    setName("");
    setNameTouched(false);
    router.refresh();
  }

  if (!firstDomain) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="display text-h3 text-fg">New alert rule</h2>
        <p className="text-ui text-fg-3">A rule watches one domain. Add a domain on Clients first.</p>
      </section>
    );
  }

  const op = OPERATORS.find((o) => o.value === operator);
  const unit = n(threshold) === 1 ? meta.unit.one : meta.unit.many;

  return (
    <section aria-labelledby={`${id}-head`} className="flex flex-col gap-3">
      <div>
        <h2 id={`${id}-head`} className="display text-h3 text-fg">
          New alert rule
        </h2>
        <p className="mt-0.5 text-meta text-fg-3">One domain, one condition, and who it wakes.</p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <Field label="Domain">
          <Select value={domainId} onChange={(e) => setDomainId(e.target.value)} className="w-full">
            {domainGroups.map((g) => (
              <optgroup key={g.clientName} label={g.clientName}>
                {g.domains.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>

        <Field label="Metric" hint={meta.measures}>
          <Select value={metric} onChange={(e) => chooseMetric(e.target.value as AlertMetric)} className="w-full">
            {METRIC_ORDER.map((m) => (
              <option key={m} value={m} disabled={METRICS[m].feature === "alerts.spoofing" && spoofing === false}>
                {METRICS[m].label}
                {METRICS[m].feature === "alerts.spoofing" && spoofing === false ? " (not on this plan)" : ""}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-3">
          <Field label="Operator">
            <Select value={operator} onChange={(e) => setOperator(e.target.value as AlertOperator)} className="w-full">
              {OPERATORS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Threshold" hint={meta.unit.suffix ? `In ${meta.unit.many === "%" ? "whole percent" : meta.unit.many}.` : `In ${meta.unit.many}.`}>
            <Input
              type="number"
              inputMode="numeric"
              min={LIMITS.threshold.min}
              max={LIMITS.threshold.max}
              step={1}
              value={threshold}
              onChange={(e) => {
                setThreshold(e.target.value);
                setThresholdTouched(true);
              }}
              className="tnum"
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Window (minutes)" hint={meta.usesWindow ? minutesHint(windowMinutes) : "Not used by this metric."}>
            <Input
              type="number"
              inputMode="numeric"
              min={LIMITS.minutes.min}
              max={LIMITS.minutes.max}
              step={1}
              value={windowMinutes}
              onChange={(e) => setWindow(e.target.value)}
              className="tnum"
            />
          </Field>
          <Field label="Cooldown (minutes)" hint={minutesHint(cooldown)}>
            <Input
              type="number"
              inputMode="numeric"
              min={LIMITS.minutes.min}
              max={LIMITS.minutes.max}
              step={1}
              value={cooldown}
              onChange={(e) => setCooldown(e.target.value)}
              className="tnum"
            />
          </Field>
        </div>

        <Field label="Max reminder level" hint="Notices in all, counting the first. After the last one an open event only rolls up. 1 to 5.">
          <Select value={reminders} onChange={(e) => setReminders(e.target.value)} className="w-full">
            {[1, 2, 3, 4, 5].map((v) => (
              <option key={v} value={String(v)}>
                {v === 1 ? "1: the first notice only" : `${v}: the first notice and ${v - 1} reminder${v === 2 ? "" : "s"}`}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Rule name" hint={nameTouched ? "3 to 100 characters." : "Suggested from the metric and domain. Edit it if you like."}>
          <Input
            value={effectiveName}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            minLength={LIMITS.name.min}
            maxLength={LIMITS.name.max}
            placeholder="Reject spike on example.com"
          />
        </Field>

        <RecipientPicker members={members} value={recipients} onChange={setRecipients} />

        {/* The rule as it will run, drawn as its route: watched, fired, each
            reminder still to come dashed, and the owner at the end. */}
        <div className="flex flex-col gap-2 border-t border-rule pt-3.5" aria-live="polite">
          <p className="text-meta font-semibold text-fg-2">How it will run</p>
          <RouteList
            label="How this rule will run"
            stops={[
              { key: "watch", shape: "origin", name: <span className="data">{domainName}</span>, kind: clientName ?? "watched" },
              {
                key: "fire",
                shape: "station",
                name: "Fires",
                kind: (
                  <>
                    when {meta.label.charAt(0).toLowerCase() + meta.label.slice(1)} is {op?.label}{" "}
                    <span className="tnum font-semibold text-fg-2">
                      {threshold || "?"}
                      {meta.unit.suffix ? meta.unit.suffix : ` ${unit}`}
                    </span>
                    {meta.usesWindow && Number(windowMinutes) > 0 ? ` over ${minutesLabel(Number(windowMinutes))}` : ""}, and
                    tells {toldLabel} at once
                  </>
                ),
              },
              ...Array.from({ length: Math.max(0, Number(reminders) - 1) }, (_, i) => ({
                key: `r${i + 2}`,
                shape: "station" as const,
                planned: true,
                name: `Reminder ${i + 2}`,
                kind: `after ${minutesLabel(Number(cooldown) * (i + 1))}, if nobody has acknowledged it`,
              })),
              {
                key: "owner",
                shape: "terminus",
                planned: true,
                name: "Workspace owner",
                kind: Number(reminders) > 1 ? "the open event rolls up after the last reminder" : "the open event rolls up if nobody acknowledges it",
              },
            ]}
          />
        </div>

        <ActionRefusal error={error} />
        {created ? (
          <p role="status" className="flex items-center gap-2 text-ui font-semibold text-ok">
            <StateMark shape="square" tone="ok" />
            &ldquo;{created}&rdquo; is watching.
          </p>
        ) : null}

        <Button type="submit" variant="primary" size="lg" busy={busy} busyLabel="Creating the rule" disabled={!valid} className="self-start">
          Create alert rule
        </Button>
      </form>
    </section>
  );
}
