"use client";

/**
 * audit.tsx — who changed what, when, and whether it was allowed.
 *
 * Read like a logbook: newest day first, one line per event written as a
 * sentence ("Revoked an API key"), the person, the time to the minute, and a
 * refused attempt marked in the fail colour, because a refusal is usually the
 * row someone came here to find. The detail the API recorded opens in place.
 *
 * Filters are the API's own (action, domain, a time window); "only refused"
 * narrows what is loaded, since the API has no outcome filter, and says so.
 * The API returns at most 200 events with no paging, so a full window says
 * that older events exist and how to reach them.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { clsx } from "clsx";
import type { AuditTimeline } from "@/lib/audit-display";
import { auditHref } from "@/lib/route-hrefs";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/choice";
import { Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";

const WINDOWS = [
  { hours: 24, label: "Last 24 hours" },
  { hours: 168, label: "Last 7 days" },
  { hours: 720, label: "Last 30 days" },
  { hours: 2160, label: "Last 90 days" },
  { hours: 0, label: "Any time" },
];

export function AuditTrail({
  timeline,
  actions,
  domains,
  selected,
  capped,
  limit,
  ignoredAction,
}: {
  timeline: AuditTimeline;
  actions: Array<{ value: string; label: string }>;
  domains: Array<{ id: string; name: string }>;
  selected: { action: string; domain: string; withinHours: number };
  capped: boolean;
  limit: number;
  ignoredAction: string | null;
}) {
  const router = useRouter();
  const [onlyRefused, setOnlyRefused] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const go = (next: Partial<typeof selected>) => {
    const f = { ...selected, ...next };
    router.push(auditHref({ action: f.action || undefined, domain: f.domain || undefined, withinHours: f.withinHours || undefined }));
  };

  const days = timeline.days
    .map((d) => ({ ...d, entries: onlyRefused ? d.entries.filter((e) => e.denied) : d.entries }))
    .filter((d) => d.entries.length > 0);
  const filtered = Boolean(selected.action || selected.domain || selected.withinHours);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3 border-b border-fg pb-3">
        <label className="flex flex-col gap-1">
          <span className="text-meta font-semibold text-fg-2">What happened</span>
          <Select value={selected.action} onChange={(e) => go({ action: e.target.value })} className="min-w-[240px]">
            <option value="">Everything</option>
            {actions.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-meta font-semibold text-fg-2">Domain</span>
          <Select value={selected.domain} onChange={(e) => go({ domain: e.target.value })} className="min-w-[200px]">
            <option value="">Any domain</option>
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-meta font-semibold text-fg-2">When</span>
          <Select value={String(selected.withinHours)} onChange={(e) => go({ withinHours: Number(e.target.value) })}>
            {WINDOWS.map((w) => (
              <option key={w.hours} value={w.hours}>
                {w.label}
              </option>
            ))}
          </Select>
        </label>
        <span className="pb-1.5">
          <Checkbox checked={onlyRefused} onChange={(e) => setOnlyRefused(e.target.checked)} label="Only refused attempts" />
        </span>
        {filtered ? (
          <button type="button" className="link mb-2 text-meta" onClick={() => router.push(auditHref())}>
            Clear filters
          </button>
        ) : null}
      </div>

      <p className="text-meta text-fg-3">
        <span className="tnum font-semibold text-fg-2">{timeline.total}</span> event{timeline.total === 1 ? "" : "s"} shown
        {timeline.denied > 0 ? (
          <>
            , <span className="tnum font-semibold text-fail">{timeline.denied}</span> refused
          </>
        ) : null}
. The trail cannot be edited or deleted from here{onlyRefused ? "; the refused filter narrows only what is loaded" : ""}.
      </p>
      {ignoredAction ? <Notice tone="warn" title={`"${ignoredAction}" is not an event type, so that filter was dropped.`} /> : null}
      {capped ? (
        <Notice tone="info" title={`Showing the newest ${limit} events`}>
          Older ones exist. Narrow by type, domain or time to reach them.
        </Notice>
      ) : null}

      {days.length === 0 ? (
        <p className="border-y border-rule py-8 text-center text-ui text-fg-3">
          {onlyRefused ? "No refused attempt in what is loaded." : filtered ? "Nothing matches these filters." : "Nothing has been recorded yet."}
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {days.map((d) => (
            <section key={d.key} aria-labelledby={`day-${d.key}`}>
              <h2 id={`day-${d.key}`} className="legend sticky top-[96px] z-[1] bg-paper py-1">
                {d.label}
              </h2>
              <ol className="mt-1 border-t border-rule">
                {d.entries.map((e) => {
                  const expanded = open === e.id;
                  const hasDetail = e.detailRows.length > 0 || e.requestId;
                  return (
                    <li
                      key={e.id}
                      data-action={e.action}
                      className={clsx("border-b border-rule", e.denied && "shadow-[inset_2px_0_0_var(--color-fail)]")}
                    >
                      <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 py-2 pl-2 sm:grid-cols-[72px_minmax(0,1fr)_auto]">
                        <time className="tnum pt-px text-meta text-fg-3" title={e.absoluteTime}>
                          {e.absoluteTime.split(", ").pop()}
                        </time>
                        <div className="min-w-0">
                          <p className="text-ui text-fg">
                            <span className="font-semibold">{e.actor}</span>{" "}
                            <span className={e.denied ? "text-fail" : "text-fg-2"}>
                              {e.denied ? "tried to: " : ""}
                              {e.actionLabel.charAt(0).toLowerCase() + e.actionLabel.slice(1)}
                            </span>
                          </p>
                          <p className="mt-0.5 flex flex-wrap gap-x-3 text-meta text-fg-3">
                            <span>{e.targetLabel}</span>
                            {e.domainName ? <span className="data">{e.domainName}</span> : null}
                            {e.actorDetail ? <span className="data">{e.actorDetail}</span> : null}
                            <span>{e.relativeTime}</span>
                          </p>
                        </div>
                        <div className="col-start-2 flex items-center gap-3 sm:col-start-auto">
                          {e.denied ? <Badge tone="fail">Refused</Badge> : null}
                          {hasDetail ? (
                            <button
                              type="button"
                              className="link text-meta"
                              aria-expanded={expanded}
                              onClick={() => setOpen(expanded ? null : e.id)}
                            >
                              {expanded ? "Hide detail" : "Detail"}
                            </button>
                          ) : null}
                        </div>
                      </div>
                      {expanded ? (
                        <dl className="mb-2 ml-[76px] grid grid-cols-[minmax(0,160px)_minmax(0,1fr)] gap-x-4 gap-y-0.5 rounded-ctl bg-paper-3 px-3 py-2 text-meta [animation:hb-fade_120ms_ease-out] sm:ml-[84px]">
                          {e.detailRows.map((r) => (
                            <div key={r.key} className="contents">
                              <dt className="text-fg-3">{r.key}</dt>
                              <dd className="data break-all text-fg" title={r.full ?? undefined}>
                                {r.value}
                              </dd>
                            </div>
                          ))}
                          {e.requestId ? (
                            <div className="contents">
                              <dt className="text-fg-3">Request</dt>
                              <dd className="data break-all text-fg-2">{e.requestId}</dd>
                            </div>
                          ) : null}
                        </dl>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
