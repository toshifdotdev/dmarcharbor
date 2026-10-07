"use client";

/**
 * audit-client.tsx — the audit trail, as something an investigation can read.
 *
 * READ ONLY, and there is no version of this file that is not. The API exposes
 * no update and no delete for an audit row (both answer 404, asserted by the
 * operations suite), so a trail that can be edited is not a trail. Every
 * control here either narrows what was read or asks for it again. Nothing here
 * changes a row, and nothing should be added that does.
 *
 * WHY THIS FILE IS MOSTLY PRESENTATION
 *
 * The rows arrive already written in English and already grouped by day, from
 * buildAuditTimeline on the server. Two reasons, both load bearing:
 *
 *  - "4 minutes ago" computed in the browser is a different string from the one
 *    the server rendered, and React reports that as a hydration mismatch on
 *    every row of the log.
 *  - Day headings are a grouping decision. Made on the server, the structure is
 *    handed down and this component cannot disagree with it about where a day
 *    ends.
 *
 * The filters split into two kinds, and the split is deliberate and visible:
 *
 *  - ACTION and DOMAIN travel to the API. They are the two filters it applies,
 *    so narrowing by them cannot hide a row that is not there.
 *  - OUTCOME is applied here, to the events already loaded. The API has no
 *    outcome filter, so this one narrows a window, and the copy says so rather
 *    than letting "no denied events" read as "nothing was denied".
 *
 * WHY DENIED IS THE ROW WITH A MARK ON IT
 *
 * The trail records two outcomes and one of them is a refusal: an action that
 * was asked for and not permitted. On an audit log that is the row somebody is
 * looking for, and it is a minority of rows, so it gets the bar, the tint and
 * the colour. It is not sorted to the top, because the order the API returned
 * is the order things happened and reordering it would be a claim the log does
 * not support.
 */

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { EmptyState, ErrorState } from "@/components/data-states";
import { auditHref } from "@/lib/route-hrefs";
import { AUDIT_ACTIONS, auditActionLabel } from "@/lib/audit-display";
import type { AuditDay, AuditTimeline, AuditTimelineEntry } from "@/lib/audit-display";

type OutcomeFilter = "ALL" | "SUCCESS" | "DENIED";

export interface AuditDomainOption {
  id: string;
  name: string;
}

const LIMIT_OPTIONS = [25, 50, 100, 200] as const;

export function AuditTrail({
  timeline,
  domains,
  domainsIncomplete,
  loadFailed,
  ignoredAction,
  capped,
  selectedAction,
  selectedDomain,
  selectedLimit,
}: {
  /** Already grouped by day and written in English, by buildAuditTimeline. */
  timeline: AuditTimeline;
  /** The workspace's domains, for the domain filter. */
  domains: AuditDomainOption[];
  /** True when the client list failed, so this list is known to be short. */
  domainsIncomplete: boolean;
  /** A failed read. Never rendered as an empty trail. */
  loadFailed: boolean;
  /** A ?action= value that is not in the API's enum and was therefore dropped. */
  ignoredAction: string | null;
  /** The API returned exactly the limit, and it has no cursor to go further. */
  capped: boolean;
  selectedAction: string;
  selectedDomain: string;
  selectedLimit: number;
}) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<OutcomeFilter>("ALL");

  function go(next: { action?: string; domain?: string; limit?: number }) {
    router.replace(
      auditHref({
        action: next.action ?? selectedAction,
        domain: next.domain ?? selectedDomain,
        limit: next.limit ?? selectedLimit,
      }),
    );
  }

  const filtered = filterDays(timeline.days, outcome);
  const filteredTotal = filtered.reduce((sum, day) => sum + day.entries.length, 0);
  const filteredDenied = filtered.reduce(
    (sum, day) => sum + day.entries.filter((entry) => entry.denied).length,
    0,
  );

  return (
    <section
      className="lift rounded-[2px] border"
      style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      data-testid="audit-trail"
    >
      <header
        className="flex flex-wrap items-baseline gap-x-4 gap-y-2 border-b px-5 py-3.5"
        style={{ borderColor: "var(--color-line)" }}
      >
        <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">
          {/*
           * A count above a failure is the lie this page exists to avoid. When
           * the read did not answer, the number is not zero: it is unknown, and
           * it is written as unknown.
           */}
          {loadFailed ? "Audit trail" : `${filteredTotal} event${filteredTotal === 1 ? "" : "s"}`}
        </h2>
        <p
          className="num text-[12.5px]"
          style={{ color: loadFailed ? "var(--color-block)" : "var(--color-ink-3)" }}
        >
          {loadFailed
            ? "could not be read"
            : filteredDenied === 0
              ? "none refused in this view"
              : `${filteredDenied} refused in this view`}
        </p>
        {capped ? (
          <p className="num text-[12.5px]" style={{ color: "var(--color-unverified)" }}>
            showing the newest {selectedLimit}: the API returns no older page
          </p>
        ) : null}
      </header>

      <div
        className="flex flex-wrap items-end gap-x-5 gap-y-3 border-b px-5 py-3.5"
        style={{ borderColor: "var(--color-line)" }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="label">Action</span>
          <select
            value={selectedAction}
            onChange={(e) => go({ action: e.target.value })}
            data-testid="audit-action-filter"
            style={SELECT_STYLE}
          >
            <option value="">Every action</option>
            {AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {auditActionLabel(action)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="label">Domain</span>
          <select
            value={selectedDomain}
            onChange={(e) => go({ domain: e.target.value })}
            disabled={domains.length === 0}
            data-testid="audit-domain-filter"
            style={SELECT_STYLE}
          >
            <option value="">Every domain</option>
            {domains.map((domain) => (
              <option key={domain.id} value={domain.id}>
                {domain.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="label">Outcome</span>
          <select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as OutcomeFilter)}
            data-testid="audit-outcome-filter"
            style={SELECT_STYLE}
          >
            <option value="ALL">Every outcome</option>
            <option value="SUCCESS">Recorded only</option>
            <option value="DENIED">Refused only</option>
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="label">Rows</span>
          <select
            value={selectedLimit}
            onChange={(e) => go({ limit: Number(e.target.value) })}
            data-testid="audit-limit-filter"
            style={SELECT_STYLE}
          >
            {LIMIT_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>

        {selectedAction || selectedDomain || outcome !== "ALL" ? (
          <button
            type="button"
            onClick={() => {
              setOutcome("ALL");
              router.replace(
                auditHref({
                  action: "",
                  domain: "",
                  limit: selectedLimit,
                }),
              );
            }}
            className="text-[12px] underline"
            style={{ color: "var(--color-ink-2)" }}
            data-testid="audit-clear-filters"
          >
            clear filters
          </button>
        ) : null}
      </div>

      {ignoredAction ? (
        <p
          role="status"
          className="border-b px-5 py-2.5 text-[12.5px]"
          style={{ borderColor: "var(--color-line)", color: "var(--color-unverified)" }}
          data-testid="audit-unknown-action"
        >
          That action is not one the API records, so the filter was dropped and the
          whole trail is shown.
        </p>
      ) : null}

      {domainsIncomplete ? (
        <p
          role="status"
          className="border-b px-5 py-2.5 text-[12.5px]"
          style={{ borderColor: "var(--color-line)", color: "var(--color-unverified)" }}
        >
          The domain list did not load, so the domain filter is missing some
          domains. The trail below is unaffected.
        </p>
      ) : null}

      {!loadFailed && outcome !== "ALL" ? (
        <p
          role="status"
          className="border-b px-5 py-2.5 text-[12.5px]"
          style={{ borderColor: "var(--color-line)", color: "var(--color-ink-3)" }}
        >
          Filtering by outcome narrows the {timeline.total} events already loaded.
          It is not a request to the API, which has no outcome filter.
        </p>
      ) : null}

      <div className="px-5 py-4">
        {loadFailed ? (
          <ErrorState
            what="the audit trail"
            detail="Nothing here is evidence until it loads. An empty trail would read as a workspace where nothing sensitive ever happened, which is a different claim and not one this page can make."
          />
        ) : filteredTotal === 0 ? (
          <EmptyStateForTrail
            filtered={outcome !== "ALL" || Boolean(selectedAction) || Boolean(selectedDomain)}
            outcome={outcome}
            total={timeline.total}
          />
        ) : (
          <div className="flex flex-col gap-6">
            {filtered.map((day) => (
              <DaySection key={day.key} day={day} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Two empty states that must never be confused.
 *
 * The API answered and there is genuinely nothing: either nothing has happened
 * yet, or the filter is looking for something that was never recorded. Both are
 * EmptyState, and both say which one they are. The third state, a failed read,
 * is ErrorState above and looks nothing like either.
 */
function EmptyStateForTrail({
  filtered,
  outcome,
  total,
}: {
  filtered: boolean;
  outcome: OutcomeFilter;
  total: number;
}) {
  if (!filtered) {
    return (
      <EmptyState
        title="Nothing recorded yet"
        description="No action has been written to this workspace's trail. It fills in as soon as someone changes something sensitive: a share link, an API key, an erasure, a sign-in."
      />
    );
  }
  if (outcome !== "ALL" && total > 0) {
    return (
      <EmptyState
        title={`No ${outcome === "DENIED" ? "refused" : "recorded"} events in the ${total} loaded`}
        description={`These ${total} events are all the API returned, and none of them had that outcome. Older events are not loaded, so this is a statement about the window above and nothing more.`}
      />
    );
  }
  return (
    <EmptyState
      title="Nothing matches this filter"
      description="The trail loaded and no row in it matches. A filter that matches nothing is a real answer, and it is not the same answer as an empty trail."
    />
  );
}

/** One day, with the count that day deserves: how many, and how many refused. */
function DaySection({ day }: { day: AuditDay }) {
  const denied = day.entries.filter((entry) => entry.denied).length;
  return (
    <section data-testid="audit-day">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b pb-2">
        <h3 className="text-[13.5px] font-semibold" style={{ color: "var(--color-ink)" }}>
          {day.label}
        </h3>
        <span className="num text-[11.5px]" style={{ color: "var(--color-ink-3)" }}>
          {day.entries.length} event{day.entries.length === 1 ? "" : "s"}
        </span>
        {denied > 0 ? (
          <span
            className="num text-[11.5px]"
            style={{ color: "var(--color-block)" }}
            data-testid="audit-day-denied"
          >
            {denied} refused
          </span>
        ) : null}
      </header>
      <ul>
        {day.entries.map((entry) => (
          <AuditRow key={entry.id} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

/**
 * One event: who, what, when, against what, and what else the row carried.
 *
 * A refused row is tinted and barred. The tint is faint on purpose: enough to
 * find every refusal by scanning the column, not enough to read a page of them
 * as an emergency.
 */
function AuditRow({ entry }: { entry: AuditTimelineEntry }) {
  return (
    <li
      className="flex flex-wrap items-start gap-x-5 gap-y-2 border-b py-3"
      style={{
        borderColor: "rgba(255,255,255,0.055)",
        background: entry.denied ? "var(--color-block-soft)" : undefined,
        boxShadow: entry.denied ? "inset 3px 0 0 var(--color-block)" : undefined,
        paddingLeft: entry.denied ? 12 : 0,
      }}
      data-testid={entry.denied ? "audit-row-denied" : "audit-row"}
      data-action={entry.action}
    >
      <div className="min-w-0 flex-1">
        <div
          className="text-[14px] font-medium"
          style={{ color: entry.denied ? "var(--color-block)" : "var(--color-ink)" }}
        >
          {entry.actionLabel}
        </div>
        <div className="text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
          {entry.actor}
          {entry.actorDetail ? (
            <span style={{ color: "var(--color-ink-3)" }}> · {entry.actorDetail}</span>
          ) : null}
          <span style={{ color: "var(--color-ink-3)" }}> · on {entry.targetLabel}</span>
          {entry.targetId ? (
            <span className="num break-all" style={{ color: "var(--color-ink-3)" }}>
              {" "}
              {entry.targetId}
            </span>
          ) : null}
          {entry.domainName ? (
            <span style={{ color: "var(--color-ink-3)" }}> · {entry.domainName}</span>
          ) : null}
        </div>
        <div className="num text-[11.5px]" style={{ color: "var(--color-ink-3)" }}>
          {entry.absoluteTime} · {entry.relativeTime}
          {entry.requestId ? (
            <span className="break-all"> · request {entry.requestId}</span>
          ) : null}
        </div>
        {entry.detailRows.length > 0 ? <DetailRows rows={entry.detailRows} /> : null}
      </div>

      <span
        className="num text-[10.5px] tracking-[0.12em] uppercase"
        style={{ color: entry.denied ? "var(--color-block)" : "var(--color-pass)" }}
      >
        {entry.outcome.toLowerCase()}
      </span>
    </li>
  );
}

/**
 * The `detail` JSON, as rows.
 *
 * The keys are read out of the value rather than reformatted from a template:
 * `effectiveAt: "cycle_end"` becomes "effective at: cycle end" and a nested
 * object becomes more rows, which is what makes a billing or a quota change
 * legible. A value too long for a row is shortened with the whole one on the
 * title attribute, so nothing is lost to a line break.
 */
function DetailRows({ rows }: { rows: AuditTimelineEntry["detailRows"] }) {
  return (
    <dl
      className="mt-2 grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-0.5"
      data-testid="audit-detail"
    >
      {rows.map((row, index) => (
        <Fragment key={`${row.key}-${index}`}>
          <dt className="num text-[11px]" style={{ color: "var(--color-ink-3)" }}>
            {row.key}
          </dt>
          <dd
            className="num break-words text-[11.5px]"
            style={{ color: "var(--color-ink-2)" }}
            title={row.full ?? undefined}
          >
            {row.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Narrows the loaded days, preserving the order the API returned them in. */
function filterDays(days: AuditDay[], outcome: OutcomeFilter): AuditDay[] {
  if (outcome === "ALL") return days;
  return days
    .map((day) => ({
      ...day,
      entries: day.entries.filter((entry) =>
        outcome === "DENIED" ? entry.denied : !entry.denied,
      ),
    }))
    .filter((day) => day.entries.length > 0);
}

const SELECT_STYLE = {
  background: "var(--color-elevate)",
  border: "1px solid var(--color-line-strong)",
  borderRadius: 2,
  color: "var(--color-ink)",
  padding: "7px 10px",
  fontSize: 13.5,
} as const;
