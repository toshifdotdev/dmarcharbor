/**
 * portfolio-overview.tsx — the figures above the portfolio table.
 *
 *   Enforcement   how far the whole book has gone towards p=reject: one bar,
 *                 a stretch per policy, the counts beside it. This is the
 *                 number an agency reports to its clients.
 *   Pass rates    DMARC, SPF and DKIM across the book, weighted by mail.
 *   Mail          every domain's daily points added together, drawn by the
 *                 domain page's own volume chart, so the rules are the same:
 *                 passed green, failed red at the base, a day with no report
 *                 from any domain hatched, never zero.
 *
 * Built only from the rows the page already loaded: nothing new is asked of
 * the API. Server-rendered; the chart is the one client component.
 */

import type { TrendPoint } from "@/lib/types";
import { ENFORCEMENT_STAGES, EnforcementBar, enforcementCounts } from "./enforcement-bar";
import type { BoardRow } from "./portfolio-board";
import { DrawOnView } from "./draw-on-view";
import { PassRateChart } from "./pass-rate-chart";
import { VolumeChart } from "./volume-chart";

const RANK: Record<string, number> = { none: 0, quarantine: 1, reject: 2 };

/**
 * Domains whose policy, as receivers saw it, rose or fell in the last 30
 * days: the last step in each domain's history, compared with the one before.
 */
function movesSince(rows: BoardRow[], today: string): { up: number; down: number } {
  const since = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)) - 29 * 86_400_000;
  let up = 0;
  let down = 0;
  for (const r of rows) {
    const steps = r.policyHistory ?? [];
    const last = steps[steps.length - 1];
    const before = steps[steps.length - 2];
    if (!last || !before || Date.parse(`${last.date}T00:00:00Z`) < since) continue;
    const diff = (RANK[last.policy] ?? 0) - (RANK[before.policy] ?? 0);
    if (diff > 0) up += 1;
    else if (diff < 0) down += 1;
  }
  return { up, down };
}

function Head({ name, kind }: { name: string; kind: string }) {
  return (
    <p className="border-b border-rule pb-2 text-ui">
      <span className="font-bold text-fg">{name}</span> <span className="text-fg-3">{kind}</span>
    </p>
  );
}

function Enforcement({ rows, today }: { rows: BoardRow[]; today: string }) {
  const policies = rows.map((r) => r.policy);
  const counts = enforcementCounts(policies);
  const total = rows.length;
  const atReject = counts.get("reject") ?? 0;
  const moves = movesSince(rows, today);

  return (
    <figure className="m-0 flex min-w-0 flex-col gap-3" data-testid="portfolio-enforcement">
      <Head name="Enforcement" kind={`${total} domain${total === 1 ? "" : "s"}, by the policy each publishes`} />
      <p className="text-ui text-fg-2">
        <span className="tnum text-[28px] font-[740] leading-none tracking-[-0.02em] text-fg">{atReject}</span>{" "}
        <span className="text-fg-3">of {total} at p=reject</span>
      </p>
      <EnforcementBar policies={policies} />
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-meta">
        {ENFORCEMENT_STAGES.map((s) => {
          const n = counts.get(s.key) ?? 0;
          if (n === 0 && (s.key === "missing" || s.key === "unseen")) return null;
          return (
            <li key={s.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={`block size-2.5 rounded-[2px] ${s.fill} ${s.key === "unseen" ? "border border-rule-2" : ""}`} />
              <span className="tnum font-bold text-fg">{n}</span>
              <span className="text-fg-3">{s.label}</span>
            </li>
          );
        })}
      </ul>
      {moves.up > 0 || moves.down > 0 ? (
        <p className="text-meta text-fg-2" data-testid="portfolio-moves">
          {moves.up > 0 ? (
            <span className="font-semibold text-ok">
              {moves.up} domain{moves.up === 1 ? "" : "s"} moved towards p=reject
            </span>
          ) : null}
          {moves.up > 0 && moves.down > 0 ? ", " : null}
          {moves.down > 0 ? (
            <span className="font-semibold text-warn">
              {moves.down} stepped back
            </span>
          ) : null}{" "}
          in the last 30 days, as receivers saw it published.
        </p>
      ) : null}
    </figure>
  );
}

/**
 * Pass rates across the book, weighted by each domain's messages, each with a
 * meter filled to its share. Green while the rate is one a domain could
 * enforce on; amber below 95%, the point where enforcing would start to stop
 * real mail. Only measured domains count; with none, no figure is shown.
 */
function Rates({ rows }: { rows: BoardRow[] }) {
  const measured = rows.filter((r) => r.messages !== null && r.messages > 0 && r.posture && r.posture !== "unmeasured");
  const total = measured.reduce((n, r) => n + (r.messages ?? 0), 0);
  if (total === 0) return null;
  const weighted = (pick: (r: BoardRow) => number | null) => {
    let w = 0;
    let n = 0;
    for (const r of measured) {
      const v = pick(r);
      if (v === null) continue;
      w += v * (r.messages ?? 0);
      n += r.messages ?? 0;
    }
    return n > 0 ? w / n : null;
  };
  const failed = measured.reduce((n, r) => n + (r.failed ?? 0), 0);
  const items: Array<{ name: string; kind: string; value: number | null }> = [
    { name: "DMARC", kind: "passed", value: ((total - failed) / total) * 100 },
    { name: "SPF", kind: "aligned", value: weighted((r) => r.spfRate) },
    { name: "DKIM", kind: "aligned", value: weighted((r) => r.dkimRate) },
  ];

  return (
    <dl className="grid grid-cols-3 gap-x-6 border-t border-rule pt-4" data-testid="portfolio-rates" data-draw>
      <DrawOnView />
      {items.map((it) => (
        <div key={it.name} className="min-w-0">
          <dt className="text-meta">
            <span className="font-bold text-fg">{it.name}</span> <span className="text-fg-3">{it.kind}</span>
          </dt>
          <dd className="mt-1">
            {it.value === null ? (
              <span className="text-ui text-fg-4">not measured</span>
            ) : (
              <>
                <span className="tnum text-[20px] font-[740] leading-none tracking-[-0.01em] text-fg">
                  {it.value >= 99.95 ? "100" : it.value.toFixed(1)}%
                </span>
                <span aria-hidden className="mt-2 block h-[5px] w-full rounded-full bg-rule">
                  <span
                    className={`hb-grow-x block h-full rounded-full ${it.value >= 95 ? "bg-done" : "bg-warn-mark"}`}
                    style={{ width: `${Math.max(2, Math.min(100, it.value))}%` }}
                  />
                </span>
              </>
            )}
          </dd>
        </div>
      ))}
      <p className="col-span-3 mt-3 text-meta text-fg-3">
        Across {measured.length} measured domain{measured.length === 1 ? "" : "s"}, weighted by their mail. Amber below 95%.
      </p>
    </dl>
  );
}

function sumPoints(rows: BoardRow[]): TrendPoint[] {
  const byDay = new Map<string, TrendPoint>();
  for (const r of rows) {
    for (const p of r.trend ?? []) {
      const key = p.date.slice(0, 10);
      const day = byDay.get(key) ?? { date: key, reportsReceived: 0, messagesObserved: 0, failedMessages: 0, spfPassMessages: 0, dkimPassMessages: 0 };
      day.reportsReceived += p.reportsReceived;
      day.messagesObserved += p.messagesObserved;
      day.failedMessages += p.failedMessages;
      day.spfPassMessages = (day.spfPassMessages ?? 0) + (p.spfPassMessages ?? 0);
      day.dkimPassMessages = (day.dkimPassMessages ?? 0) + (p.dkimPassMessages ?? 0);
      byDay.set(key, day);
    }
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function PortfolioOverview({ rows, today }: { rows: BoardRow[]; today: string }) {
  const points = sumPoints(rows);
  const last = points.length > 0 ? points[points.length - 1]!.date : null;
  const ages = rows.map((r) => r.lastReportAgeDays).filter((d): d is number => d !== null);
  const freshest = ages.length > 0 ? Math.min(...ages) : null;

  return (
    <div className="grid gap-x-16 gap-y-10 min-[1100px]:grid-cols-[minmax(0,0.74fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-6">
        <Enforcement rows={rows} today={today} />
        <Rates rows={rows} />
      </div>
      <section className="flex min-w-0 flex-col gap-3" data-testid="portfolio-volume">
        <Head name="Mail across the portfolio" kind="every domain added together, last 30 days" />
        <VolumeChart
          points={points}
          spikes={[]}
          days={30}
          today={today}
          lastReportAt={last ? `${last}T00:00:00.000Z` : null}
          daysWithoutReport={freshest}
          domainName="the portfolio"
        />
        {points.length > 0 ? (
          <div className="mt-4 flex flex-col gap-3">
            <Head name="Pass rates across the portfolio" kind="every domain added together, by day" />
            <PassRateChart points={points} days={30} today={today} subject="the portfolio" />
          </div>
        ) : null}
      </section>
    </div>
  );
}
