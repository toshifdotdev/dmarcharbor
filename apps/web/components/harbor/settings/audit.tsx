"use client";

/**
 * audit.tsx — who changed what, when, and whether it was allowed.
 *
 * Read like a logbook drawn as the product draws everything else: each day is
 * one line, each event a station on it, newest first. An event that was
 * allowed is an ordinary station; a refused attempt is a short red bar across
 * the line, the map's mark for "turned away here", with the word "Refused"
 * beside it, because a refusal is usually the row someone came to find. Each
 * row leads with what happened ("API key revoked"), then who, the time in
 * tabular figures, and the detail the API recorded opens in place.
 *
 * Filters are the API's own (action, domain, a time window); "only refused"
 * narrows what is loaded, since the API has no outcome filter, and says so.
 * The API returns at most 200 events with no paging, so a full window says
 * that older events exist and how to reach them.
 *
 * Kept: data-action on every row, the filter labels, "Detail" / "Hide detail".
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
import { Readout, ReadoutStrip } from "@/components/ui/readout";

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
  const people = new Set(timeline.days.flatMap((d) => d.entries.map((e) => e.actor))).size;
  const windowLabel = WINDOWS.find((w) => w.hours === selected.withinHours)?.label ?? `Last ${selected.withinHours} hours`;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-meta font-semibold text-fg-2">What happened</span>
          <Select value={selected.action} onChange={(e) => go({ action: e.target.value })} className="min-w-[240px] max-sm:w-full">
            <option value="">Everything</option>
            {actions.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-meta font-semibold text-fg-2">Domain</span>
          <Select value={selected.domain} onChange={(e) => go({ domain: e.target.value })} className="min-w-[200px] max-sm:w-full">
            <option value="">Any domain</option>
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-meta font-semibold text-fg-2">When</span>
          <Select value={String(selected.withinHours)} onChange={(e) => go({ withinHours: Number(e.target.value) })}>
            {WINDOWS.map((w) => (
              <option key={w.hours} value={w.hours}>
                {w.label}
              </option>
            ))}
          </Select>
        </label>
        <span className="pb-2">
          <Checkbox checked={onlyRefused} onChange={(e) => setOnlyRefused(e.target.checked)} label="Only refused attempts" />
        </span>
        {filtered ? (
          <button type="button" className="link mb-2.5 text-meta" onClick={() => router.push(auditHref())}>
            Clear filters
          </button>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <ReadoutStrip>
          <Readout label="Events shown" value={timeline.total} note={capped ? `The newest ${limit}.` : "Everything in the window."} />
          <Readout
            label="Refused attempts"
            value={timeline.denied}
            tone={timeline.denied > 0 ? "fail" : undefined}
            note={timeline.denied > 0 ? "Marked in red on the line." : "None in what is shown."}
          />
          <Readout label="People and tasks" value={people} note="Who made the changes shown." />
          <Readout label="Window" value={<span className="text-h3">{windowLabel}</span>} note={selected.action || selected.domain ? "Narrowed by the filters above." : "Every type of event."} />
        </ReadoutStrip>
        <p className="text-meta text-fg-3">
          The trail cannot be edited or deleted from here{onlyRefused ? "; the refused filter narrows only what is loaded" : ""}.
        </p>
      </div>

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
        <div className="flex flex-col gap-8">
          {days.map((d) => {
            const refused = d.entries.filter((e) => e.denied).length;
            return (
              <section key={d.key} aria-labelledby={`day-${d.key}`}>
                <h2
                  id={`day-${d.key}`}
                  className="sticky top-[96px] z-[1] flex flex-wrap items-baseline gap-x-2 border-b border-rule bg-paper pb-1.5 pt-1"
                >
                  <span className="text-ui font-bold text-fg">{d.label}</span>
                  <span className="tnum text-meta text-fg-3">
                    {d.entries.length} event{d.entries.length === 1 ? "" : "s"}
                    {refused > 0 ? (
                      <>
                        {" · "}
                        <span className="font-semibold text-fail">{refused} refused</span>
                      </>
                    ) : null}
                  </span>
                </h2>
                <ol className="pt-1">
                  {d.entries.map((e, i) => {
                    const expanded = open === e.id;
                    const hasDetail = e.detailRows.length > 0 || e.requestId;
                    const first = i === 0;
                    const last = i === d.entries.length - 1;
                    return (
                      <li key={e.id} data-action={e.action} className="relative">
                        {/* The day's line, through every station on it. */}
                        <span
                          aria-hidden
                          className={clsx(
                            "absolute left-[61px] w-[3px] bg-fg sm:left-[69px]",
                            first ? "top-[18px]" : "top-0",
                            last ? "h-[18px]" : "bottom-0",
                            first && last && "hidden",
                          )}
                        />
                        {e.denied ? (
                          <span aria-hidden className="absolute left-[53px] top-[16px] h-[7px] w-[19px] rounded-full bg-fail sm:left-[61px]" />
                        ) : (
                          <span aria-hidden className="absolute left-[56px] top-[13px] size-[13px] rounded-full border-[3px] border-fg bg-paper sm:left-[64px]" />
                        )}
                        <div className="grid grid-cols-[48px_minmax(0,1fr)] gap-x-[38px] py-2 sm:grid-cols-[56px_minmax(0,1fr)_auto]">
                          <time className="tnum pt-px text-right text-meta font-semibold text-fg-2" title={e.absoluteTime}>
                            {e.absoluteTime.split(", ").pop()}
                          </time>
                          <div className="min-w-0">
                            <p className="text-ui text-fg">
                              {e.denied ? (
                                <span className="font-semibold text-fail">{e.actionLabel}: refused</span>
                              ) : (
                                <span className="font-semibold">{e.actionLabel}</span>
                              )}{" "}
                              <span className="text-fg-3">{e.denied ? "tried by" : "by"}</span>{" "}
                              <span className="font-medium text-fg-2">{e.actor}</span>
                            </p>
                            <p className="mt-0.5 flex flex-wrap gap-x-3 text-meta text-fg-3">
                              <span>{e.targetLabel}</span>
                              {e.domainName ? <span className="data">{e.domainName}</span> : null}
                              {e.actorDetail ? <span className="data">{e.actorDetail}</span> : null}
                              <span>{e.relativeTime}</span>
                            </p>
                          </div>
                          <div className="col-start-2 flex items-center gap-3 pt-1 sm:col-start-auto sm:pt-0">
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
                          <dl className="mb-3 ml-[86px] grid grid-cols-[minmax(0,160px)_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-ctl bg-paper-3 px-3 py-2.5 text-meta sm:ml-[94px]">
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
            );
          })}
        </div>
      )}
    </div>
  );
}
