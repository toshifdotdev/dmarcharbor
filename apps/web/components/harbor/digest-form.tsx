"use client";

/**
 * digest-form.tsx — a new scheduled digest, and the schedule and recipient
 * fields its edit dialog shares.
 *
 * The schedule is set in the scheduler's own terms (frequency, UTC hour, a
 * weekday or a day of month) and read back as a sentence with the next send
 * worked out by the scheduler's own rule, so "Mondays at 09:00 UTC" never
 * surprises anyone in another timezone: the hour is also shown in the
 * reader's local time. The next send reads the clock, so it is worked out in
 * the browser after hydration only; the server HTML carries the schedule.
 *
 * Recipients are typed or pasted (commas, spaces or new lines), cleaned and
 * deduplicated as they are typed, with anything that is not an address named
 * before save. The API takes 1 to 20.
 *
 * Forensic evidence in a digest needs reports.forensic on the plan; without it
 * the box is shown disabled with the reason.
 */

import { useRouter } from "next/navigation";
import { useId, useState, useSyncExternalStore, type FormEvent } from "react";
import { createReportDigest } from "@/lib/ops-client";
import { DIGEST_LIMITS, WEEKDAYS, nextDigestDue, parseRecipients, scheduleLabel } from "@/lib/digest-schedule";
import { Button } from "@/components/ui/button";
import { Checkbox, Textarea } from "@/components/ui/choice";
import { Field, Select } from "@/components/ui/field";
import { StateMark } from "./ops-parts";
import { ActionRefusal, type ActionError } from "./plan-refusal";

export interface ScheduleValue {
  frequency: "WEEKLY" | "MONTHLY";
  sendHourUtc: number;
  weekday: number;
  dayOfMonth: number;
}

const noop = () => () => {};
/** The reader's own timezone, read in the browser only (never on the server). */
function useLocalZone(): string | null {
  return useSyncExternalStore(noop, () => Intl.DateTimeFormat().resolvedOptions().timeZone, () => null);
}

function localHour(hourUtc: number, zone: string | null): string | null {
  if (!zone || zone === "UTC" || zone === "Etc/UTC") return null;
  const at = new Date(Date.UTC(2026, 0, 5, hourUtc));
  const local = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: zone });
  return `${local} in ${zone.replace(/_/g, " ")}`;
}

function nextLine(value: ScheduleValue): string {
  const next = nextDigestDue({ ...value, lastSentAt: null }, new Date());
  if (next === "now") return "Due now: it goes out on the scheduler's next pass.";
  if (Number.isNaN(next.getTime())) return "";
  return `Next: ${next.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC.`;
}

/** False on the server and during hydration, true after: the clock is read only then. */
function useMounted(): boolean {
  return useSyncExternalStore(noop, () => true, () => false);
}

export function ScheduleFields({ value, onChange }: { value: ScheduleValue; onChange: (v: ScheduleValue) => void }) {
  const zone = useLocalZone();
  const mounted = useMounted();
  const local = localHour(value.sendHourUtc, zone);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Frequency">
          <Select
            value={value.frequency}
            onChange={(e) => onChange({ ...value, frequency: e.target.value as ScheduleValue["frequency"] })}
            className="w-full"
          >
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option>
          </Select>
        </Field>
        <Field label="Send hour (UTC)" hint={local ?? undefined}>
          <Select value={String(value.sendHourUtc)} onChange={(e) => onChange({ ...value, sendHourUtc: Number(e.target.value) })} className="w-full">
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={String(h)}>
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {value.frequency === "WEEKLY" ? (
        <Field label="Weekday">
          <Select value={String(value.weekday)} onChange={(e) => onChange({ ...value, weekday: Number(e.target.value) })} className="w-full">
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={String(i)}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <Field
          label="Day of month"
          hint="Capped at the 28th on purpose: every month has one. A digest set for the 31st would silently skip February."
        >
          <Select value={String(value.dayOfMonth)} onChange={(e) => onChange({ ...value, dayOfMonth: Number(e.target.value) })} className="w-full">
            {Array.from({ length: DIGEST_LIMITS.dayOfMonth }, (_, i) => (
              <option key={i + 1} value={String(i + 1)}>
                {i + 1}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {/* The schedule read back as a departure: when it leaves, and the next one. */}
      <div className="flex items-start gap-3 border-t border-rule pt-3" aria-live="polite">
        <svg width="34" height="16" viewBox="0 0 34 16" aria-hidden className="mt-[2px] shrink-0">
          <path d="M8 8H26" stroke="var(--color-fg)" strokeWidth="5" strokeLinecap="round" />
          <circle cx="8" cy="8" r="5.5" fill="var(--color-paper)" stroke="var(--color-fg)" strokeWidth="3" />
          <rect x="22" y="1.5" width="10" height="13" rx="5" fill="var(--color-paper)" stroke="var(--color-fg)" strokeWidth="3" />
        </svg>
        <p className="text-ui text-fg-2">
          <span className="font-semibold text-fg">{scheduleLabel(value)}.</span> {mounted ? nextLine(value) : null}
        </p>
      </div>
    </div>
  );
}

export function RecipientsField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const id = useId();
  const { valid, invalid } = parseRecipients(value);
  const over = valid.length > DIGEST_LIMITS.recipients;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-meta font-semibold text-fg-2">
        Recipients
      </label>
      <Textarea
        id={id}
        rows={3}
        mono
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="it@client.example, you@agency.example"
        spellCheck={false}
        autoCapitalize="none"
        aria-invalid={invalid.length > 0 || over || undefined}
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="text-meta text-fg-3" aria-live="polite">
        {valid.length === 0 && invalid.length === 0 ? (
          "Up to 20 addresses, separated by commas, spaces or new lines."
        ) : (
          <>
            <span className={over ? "tnum font-semibold text-fail" : "tnum font-semibold text-fg-2"}>{valid.length}</span> of{" "}
            {DIGEST_LIMITS.recipients}
            {over ? <span className="text-fail">: too many</span> : null}
            {invalid.length > 0 ? (
              <span className="text-warn">
                {" "}
                · not an address: <span className="data">{invalid.slice(0, 3).join(", ")}</span>
                {invalid.length > 3 ? "…" : ""}
              </span>
            ) : null}
          </>
        )}
      </p>
    </div>
  );
}

export function recipientsOk(raw: string): boolean {
  const { valid, invalid } = parseRecipients(raw);
  return valid.length >= 1 && valid.length <= DIGEST_LIMITS.recipients && invalid.length === 0;
}

export function DigestForm({
  organizationId,
  domainGroups,
  forensicsOnPlan,
}: {
  organizationId: string;
  domainGroups: Array<{ clientName: string; domains: Array<{ id: string; name: string }> }>;
  forensicsOnPlan: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const first = domainGroups[0]?.domains[0] ?? null;
  const [domainId, setDomainId] = useState(first?.id ?? "");
  const [schedule, setSchedule] = useState<ScheduleValue>({ frequency: "WEEKLY", sendHourUtc: 9, weekday: 1, dayOfMonth: 1 });
  const [recipients, setRecipients] = useState("");
  const [forensics, setForensics] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const ok = Boolean(domainId) && recipientsOk(recipients);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    setCreated(null);
    const res = await createReportDigest(organizationId, {
      domainId,
      ...schedule,
      recipientEmails: parseRecipients(recipients).valid,
      includeForensics: forensicsOnPlan && forensics,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const name = domainGroups.flatMap((g) => g.domains).find((d) => d.id === domainId)?.name ?? "the domain";
    setCreated(`${scheduleLabel(schedule)} for ${name}.`);
    setRecipients("");
    router.refresh();
  }

  if (!first) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="display text-h3 text-fg">New digest</h2>
        <p className="text-ui text-fg-3">A digest summarises one domain. Add a domain on Clients first.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby={`${id}-head`} className="flex flex-col gap-3">
      <div>
        <h2 id={`${id}-head`} className="display text-h3 text-fg">
          New digest
        </h2>
        <p className="mt-0.5 text-meta text-fg-3">One domain&rsquo;s summary, to the people who should read it.</p>
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
        <ScheduleFields value={schedule} onChange={setSchedule} />
        <RecipientsField value={recipients} onChange={setRecipients} />
        <Checkbox
          checked={forensicsOnPlan && forensics}
          disabled={!forensicsOnPlan}
          onChange={(e) => setForensics(e.target.checked)}
          label="Include forensic evidence"
          hint={
            forensicsOnPlan
              ? "Adds failure detail from individual messages. Every recipient sees it."
              : "Forensic evidence is not available on your current plan."
          }
        />
        <ActionRefusal error={error} />
        {created ? (
          <p role="status" className="flex items-baseline gap-2 text-ui font-semibold text-ok">
            <span className="relative top-[1px]">
              <StateMark shape="square" tone="ok" />
            </span>
            Scheduled: {created}
          </p>
        ) : null}
        <Button type="submit" variant="primary" size="lg" busy={busy} busyLabel="Scheduling" disabled={!ok} className="self-start">
          Schedule digest
        </Button>
      </form>
    </section>
  );
}
