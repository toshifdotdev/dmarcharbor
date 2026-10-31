"use client";

/**
 * alert-events.tsx — what fired, and what is still waiting for a person.
 *
 * Read the way the person on call reads it: the state first (open, in
 * someone's hands, or over), then the domain and the rule that fired, the
 * API's own summary of what was observed, who it tells, and how far it has
 * escalated. The reminder ladder is drawn as a strip map (ops-parts.tsx): the
 * first notice and each reminder are stations, the workspace owner is the
 * terminus, and the stops still to come are dashed. Acknowledging stops the
 * reminders; it is the one action here and needs no plan feature.
 *
 * Open events are the default view. Silence is only meaningful when something
 * is watching, so the empty state says which: no events with rules enabled is
 * calm, no events with no rules is nothing to report because nothing looks.
 *
 * After an outage there can be dozens open at once, so the open view also
 * offers "Acknowledge all open", confirmed with the count, through the bulk
 * route: the same acknowledgement per alert, one request. Test hooks:
 * ack-all, ack-all-confirm, ack-all-confirm-button.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { clsx } from "clsx";
import { acknowledgeAlert, acknowledgeAlerts } from "@/lib/ops-client";
import type { EventState } from "@/lib/alert-rules";
import { domainHref } from "@/lib/route-hrefs";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { EscalationLine, StateMark, StateWord } from "./ops-parts";

/** What the bulk route takes in one call. */
const BULK_LIMIT = 100;

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
  /** The client that owns the domain, when the client list was readable. */
  clientName?: string | null;
  /** Who the rule tells, by name. */
  recipientNames?: string[];
  /** Who acknowledged it, when the API recorded a person. */
  handledBy?: string | null;
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
  const router = useRouter();
  const toast = useToast();
  const count = (s: EventState) => events.filter((e) => e.state === s).length;
  const [filter, setFilter] = useState<Filter>(count("open") > 0 || events.length === 0 ? "open" : "all");
  const shown = filter === "all" ? events : events.filter((e) => e.state === filter);
  const open = events.filter((e) => e.state === "open").slice(0, BULK_LIMIT);
  const [confirming, setConfirming] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  async function acknowledgeAllOpen() {
    if (open.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    setBulkError(null);
    const res = await acknowledgeAlerts(
      organizationId,
      open.map((e) => e.id),
    );
    setBulkBusy(false);
    if (!res.ok) {
      setBulkError(res.error.message ?? "The alerts could not be acknowledged. Nothing changed.");
      return;
    }
    const skipped = res.data.skipped.length;
    toast({
      title: `${res.data.acknowledged} alert${res.data.acknowledged === 1 ? "" : "s"} acknowledged`,
      body:
        skipped > 0
          ? `${skipped} had already been acknowledged or had resolved on ${skipped === 1 ? "its" : "their"} own.`
          : undefined,
      tone: "ok",
    });
    setConfirming(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
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
        {filter === "open" && open.length > 1 ? (
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            data-testid="ack-all"
            onClick={() => {
              setBulkError(null);
              setConfirming(true);
            }}
          >
            Acknowledge all open
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={acknowledgeAllOpen}
        title={`Acknowledge ${open.length} open alerts?`}
        body={
          <>
            <p>
              Each one stops sending reminders and stops rolling up to the workspace owner, and its PSA ticket, if it has
              one, gets a note saying who acknowledged it. The rules stay on: anything that crosses a threshold again
              fires a new alert.
            </p>
            {count("open") > open.length ? (
              <p className="mt-2">This takes the first {open.length}; acknowledge the rest after.</p>
            ) : null}
          </>
        }
        confirmLabel={`Acknowledge ${open.length}`}
        busy={bulkBusy}
        error={bulkError}
        testId="ack-all"
      />

      {shown.length === 0 ? (
        <div role="status" data-testid={events.length === 0 ? "state-empty" : undefined} className="border-y border-rule py-6">
          <p className="flex items-center gap-2 text-body font-semibold text-fg">
            <StateMark shape={events.length === 0 && !watching ? "hatch" : "square"} tone={events.length === 0 && !watching ? "void" : "ok"} />
            {filter === "open" && events.length > 0
              ? "Nothing is open."
              : events.length === 0
                ? watching
                  ? "No alert has fired."
                  : "No alert events, because nothing is watching yet."
                : "Nothing in this view."}
          </p>
          <p className="mt-1 max-w-[70ch] pl-[17px] text-ui text-fg-2">
            {events.length === 0 && !watching
              ? "Silence here only means something once a rule is enabled. Start with the report-silence rule suggested under Rules; its events appear here, with who was told and how far each has escalated."
              : events.length === 0
                ? "Every enabled rule is inside its threshold. When one is crossed, the event appears here and its recipients are told."
                : filter === "open"
                  ? "Every event that fired has been acknowledged or has resolved on its own."
                  : "Events appear here as rules fire."}
          </p>
        </div>
      ) : (
        <ol className="flex flex-col border-y border-rule">
          {shown.map((e) => (
            <EventRow key={e.id} organizationId={organizationId} event={e} />
          ))}
        </ol>
      )}
    </div>
  );
}

function EventRow({ event: e, organizationId }: { event: EventView; organizationId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = e.state === "open";
  const exhausted = open && e.maxReminders !== null && e.reminderLevel >= e.maxReminders;
  const told = e.recipientNames ?? [];

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
      className={clsx(
        "grid gap-x-6 gap-y-2.5 border-b border-rule py-3.5 pl-3 pr-1 last:border-b-0",
        "md:grid-cols-[136px_minmax(0,1fr)_auto] xl:grid-cols-[136px_minmax(0,1fr)_minmax(180px,220px)_auto]",
        open && "shadow-[inset_2px_0_0_var(--color-fail)]",
      )}
    >
      {/* State, and the moment that state began. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 md:col-start-1 md:row-span-2 md:row-start-1 md:flex-col md:items-start xl:row-span-1">
        {open ? (
          <StateWord shape="diamond" tone="fail">
            Open
          </StateWord>
        ) : e.state === "acknowledged" ? (
          <StateWord shape="ring" tone="ink">
            Acknowledged
          </StateWord>
        ) : (
          <StateWord shape="square" tone="ok">
            Resolved
          </StateWord>
        )}
        <span className="tnum text-meta text-fg-3">
          {open ? `Fired ${e.firedLabel}` : (e.handledLabel ?? "not recorded")}
        </span>
        {e.state === "acknowledged" && e.handledBy ? <span className="text-meta text-fg-3">by {e.handledBy}</span> : null}
        {e.stale ? (
          <span className="text-meta font-semibold text-fg-3" title="Open long enough to be marked stale by the roll-up">
            Stale
          </span>
        ) : null}
      </div>

      {/* What fired, where. */}
      <div className="min-w-0 md:col-start-2 md:row-start-1">
        <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <Link href={domainHref(e.domainSlug)} className="data text-ui font-semibold text-fg hover:text-act hover:underline">
            {e.domainName}
          </Link>
          <span className="text-ui text-fg-3">{e.ruleName}</span>
        </p>
        <p className="mt-1 max-w-[90ch] text-ui text-fg-2">{e.summary}</p>
        <p className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-meta text-fg-3">
          <span>
            Observed <span className="tnum font-semibold text-fg">{e.observed}</span> against{" "}
            <span className="tnum">{e.threshold}</span>
          </span>
          {!open ? <span className="tnum">Fired {e.firedLabel}</span> : null}
          {e.clientName ? <span>{e.clientName}</span> : null}
          {told.length > 0 ? (
            <span>
              Tells <span className="font-semibold text-fg-2">{told.slice(0, 3).join(", ")}</span>
              {told.length > 3 ? ` and ${told.length - 3} more` : ""}
            </span>
          ) : null}
        </p>
        {error ? (
          <p role="alert" className="mt-1 text-ui font-semibold text-fail">
            {error}
          </p>
        ) : null}
      </div>

      {/* How far it has escalated. */}
      <div className="flex min-w-0 flex-col gap-1 md:col-start-2 md:row-start-2 xl:col-start-3 xl:row-start-1">
        {e.maxReminders !== null ? <EscalationLine level={e.reminderLevel} max={e.maxReminders} state={e.state} /> : null}
        <p className="text-meta text-fg-3">
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
          ) : (
            <>
              Stopped at reminder <span className="tnum">{e.reminderLevel}</span>
              {e.maxReminders !== null ? (
                <>
                  {" "}
                  of <span className="tnum">{e.maxReminders}</span>
                </>
              ) : null}
            </>
          )}
        </p>
      </div>

      {open ? (
        <div className="md:col-start-3 md:row-start-1 md:self-start xl:col-start-4">
          <Button size="sm" onClick={acknowledge} busy={busy} busyLabel="Acknowledging" data-testid={`ack-${e.id}`}>
            Acknowledge
          </Button>
        </div>
      ) : null}
    </li>
  );
}
