"use client";

/**
 * alert-events.tsx — what fired, and what is still waiting for a person.
 *
 * Open events come first and are the default view: each one shows the API's
 * own summary of what was observed, the domain (linked to its evidence), when
 * it fired, how far it has escalated ("reminder 2 of 3") and when the next
 * reminder can go out. Acknowledging stops the reminders; it is the one action
 * here and needs no plan feature.
 *
 * Silence is only meaningful when something is watching, so the empty state
 * says which: no events with rules enabled is calm, no events with no rules is
 * nothing to report because nothing is looking.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { clsx } from "clsx";
import { acknowledgeAlert } from "@/lib/ops-client";
import type { EventState } from "@/lib/alert-rules";
import { domainHref } from "@/lib/route-hrefs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/field";

export interface EventView {
  id: string;
  ruleName: string;
  domainName: string;
  domainSlug: string;
  summary: string;
  observed: string;
  threshold: string;
  state: EventState;
  firedLabel: string;
  handledLabel: string | null;
  stale: boolean;
  reminderLevel: number;
  maxReminders: number | null;
  nextReminderLabel: string | null;
}

type Filter = EventState | "all";

export function AlertEvents({
  organizationId,
  events,
  truncated,
  watching,
}: {
  organizationId: string;
  events: EventView[];
  truncated: boolean;
  watching: boolean;
}) {
  const count = (s: EventState) => events.filter((e) => e.state === s).length;
  const [filter, setFilter] = useState<Filter>(count("open") > 0 || events.length === 0 ? "open" : "all");
  const shown = filter === "all" ? events : events.filter((e) => e.state === filter);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Which events"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "open", label: `Open ${count("open")}` },
            { value: "acknowledged", label: `Acknowledged ${count("acknowledged")}` },
            { value: "resolved", label: `Resolved ${count("resolved")}` },
            { value: "all", label: `All ${events.length}` },
          ]}
        />
        {truncated ? <span className="text-meta text-fg-3">Showing the latest {events.length}.</span> : null}
      </div>

      {shown.length === 0 ? (
        <div role="status" data-testid={events.length === 0 ? "state-empty" : undefined} className="border-y border-rule py-6">
          <p className="text-body font-semibold text-fg">
            {filter === "open" && events.length > 0
              ? "Nothing is open."
              : events.length === 0
                ? watching
                  ? "No alert has fired."
                  : "No alert events, because nothing is watching yet."
                : "Nothing in this view."}
          </p>
          <p className="mt-1 max-w-[70ch] text-ui text-fg-2">
            {events.length === 0 && !watching
              ? "Silence here only means something once a rule is enabled. Add one beside the rules list, and its events appear here."
              : filter === "open"
                ? "Every event that fired has been acknowledged or has resolved on its own."
                : "Events appear here as rules fire."}
          </p>
        </div>
      ) : (
        <ol className="hb-stagger flex flex-col border-y border-rule">
          {shown.map((e, i) => (
            <EventRow key={e.id} index={i} organizationId={organizationId} event={e} />
          ))}
        </ol>
      )}
    </div>
  );
}

function EventRow({ event: e, organizationId, index }: { event: EventView; organizationId: string; index: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = e.state === "open";
  const exhausted = open && e.maxReminders !== null && e.reminderLevel >= e.maxReminders;

  async function acknowledge() {
    setBusy(true);
    setError(null);
    const res = await acknowledgeAlert(organizationId, e.id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error.message ?? "It could not be acknowledged.");
      return;
    }
    router.refresh();
  }

  return (
    <li
      data-event-id={e.id}
      data-event-state={e.state}
      style={{ "--i": Math.min(index, 10) } as React.CSSProperties}
      className={clsx(
        "grid gap-x-6 gap-y-2 border-b border-rule py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto]",
        open && "shadow-[inset_2px_0_0_var(--color-fail)] pl-3",
      )}
    >
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link href={domainHref(e.domainSlug)} className="data text-ui font-semibold text-fg hover:text-act hover:underline">
            {e.domainName}
          </Link>
          <span className="text-ui font-semibold text-fg-2">{e.ruleName}</span>
          {open ? (
            <Badge tone="fail">Open</Badge>
          ) : e.state === "acknowledged" ? (
            <Badge tone="neutral">Acknowledged {e.handledLabel}</Badge>
          ) : (
            <Badge tone="ok">Resolved {e.handledLabel}</Badge>
          )}
          {e.stale ? <Badge tone="void" title="Open long enough to be marked stale by the roll-up">Stale</Badge> : null}
        </p>
        <p className="mt-1 max-w-[90ch] text-ui text-fg-2">{e.summary}</p>
        <p className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-meta text-fg-3">
          <span>Fired {e.firedLabel}</span>
          <span>
            Observed <span className="tnum font-semibold text-fg-2">{e.observed}</span> against{" "}
            <span className="tnum">{e.threshold}</span>
          </span>
          {open ? (
            <span className={exhausted ? "font-semibold text-fail" : undefined}>
              Reminder <span className="tnum">{e.reminderLevel}</span>
              {e.maxReminders !== null ? (
                <>
                  {" "}
                  of <span className="tnum">{e.maxReminders}</span>
                </>
              ) : null}
              {exhausted
                ? ": no more reminders; it rolls up to the workspace owner"
                : e.nextReminderLabel
                  ? `; next not before ${e.nextReminderLabel}`
                  : ""}
            </span>
          ) : null}
        </p>
        {error ? (
          <p role="alert" className="mt-1 text-ui font-semibold text-fail">
            {error}
          </p>
        ) : null}
      </div>
      {open ? (
        <div className="self-center">
          <Button size="sm" onClick={acknowledge} busy={busy} busyLabel="Acknowledging" data-testid={`ack-${e.id}`}>
            Acknowledge
          </Button>
        </div>
      ) : null}
    </li>
  );
}
