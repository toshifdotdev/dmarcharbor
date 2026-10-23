"use client";

/**
 * portfolio-board.tsx — the Portfolio: every domain in the workspace, one view.
 *
 * It answers one question on open: what needs me today. So:
 *
 * - The fleet strip is one proportional bar of the five postures, and its
 *   legend IS the filter. No separate stat cards restating the same counts.
 * - The table sorts by action priority by default (blocking, unverified,
 *   stale, not measured, aligned), and each row says WHY it has its posture in
 *   a line under the domain. A posture without its reason is a verdict without
 *   evidence.
 * - "By client" regroups the same rows under their client, the client named
 *   once per group (a ditto, as a printed ledger would), because the buyer is an
 *   agency and a client conversation is a group of domains.
 *
 * Rule Zero holds here as everywhere: a row whose measurement could not be read
 * has no posture at all, never a pass, and is counted apart. Stale and Not
 * measured are different facts with different marks.
 *
 * Every value arrives computed by the server page (ages, labels, rates), so no
 * clock is read during render and hydration cannot disagree with the HTML.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type MouseEvent } from "react";
import { clsx } from "clsx";
import { POSTURE_META, POSTURE_ORDER, type Posture } from "@/lib/posture";
import { domainHref } from "@/lib/route-hrefs";
import { PostureBadge, PostureMark } from "@/components/ui/badge";
import { Segmented, SearchInput } from "@/components/ui/field";
import { Nil, Table, TBody, Td, TEmptyRow, Th, THead, Tr } from "@/components/ui/table";

export interface BoardRow {
  domainId: string;
  slug: string;
  domain: string;
  ownership: "PENDING" | "VERIFIED" | "FAILED";
  clientName: string;
  /** null = the measurement read failed. Never a posture. */
  posture: Posture | null;
  reason: string | null;
  messages: number | null;
  failed: number | null;
  spfRate: number | null;
  dkimRate: number | null;
  policy: string | null;
  lastReportAgeDays: number | null;
  lastReportLabel: string | null;
}

const LEGEND_ORDER: Posture[] = ["block", "unverified", "stale", "unmeasured", "pass"];

const SEGMENT_FILL: Record<Posture, string> = {
  pass: "bg-ok",
  block: "bg-fail",
  unverified: "bg-warn-mark",
  stale: "bg-void/55",
  unmeasured: "void-hatch bg-void-wash",
};

type SortKey = "posture" | "domain" | "client" | "messages" | "failed" | "failShare" | "spf" | "dkim" | "lastReport";
type View = "priority" | "client";

const fmt = (n: number) => n.toLocaleString("en-GB");
/** The API sends pass rates as percentages already (0–100, two decimals). */
const pct = (r: number | null) => (r === null ? null : `${r === 100 || r === 0 ? r : r.toFixed(1)}%`);

function failShare(r: BoardRow): number | null {
  return r.messages && r.failed !== null ? r.failed / r.messages : null;
}

function sortValue(r: BoardRow, key: SortKey): number | string {
  switch (key) {
    case "posture":
      return r.posture ? POSTURE_ORDER[r.posture] : Number.MAX_SAFE_INTEGER;
    case "domain":
      return r.domain;
    case "client":
      return r.clientName.toLowerCase();
    case "messages":
      return r.messages ?? -1;
    case "failed":
      return r.failed ?? -1;
    case "failShare":
      return failShare(r) ?? -1;
    case "spf":
      return r.spfRate ?? -1;
    case "dkim":
      return r.dkimRate ?? -1;
    case "lastReport":
      return r.lastReportAgeDays ?? Number.MAX_SAFE_INTEGER;
  }
}

export function PortfolioBoard({ rows, clientCount }: { rows: BoardRow[]; clientCount: number }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Posture | "all">("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("priority");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "posture", desc: false });

  // Counted over the whole fleet, never the filtered view: a legend number is a
  // fact about the portfolio, not about the search box.
  const counts = useMemo(() => {
    const c: Record<Posture, number> = { block: 0, unverified: 0, stale: 0, unmeasured: 0, pass: 0 };
    let unread = 0;
    for (const r of rows) {
      if (r.posture) c[r.posture] += 1;
      else unread += 1;
    }
    return { ...c, unread };
  }, [rows]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = rows.filter((r) => {
      if (filter !== "all" && r.posture !== filter) return false;
      if (!q) return true;
      return r.domain.toLowerCase().includes(q) || r.clientName.toLowerCase().includes(q);
    });
    const dir = sort.desc ? -1 : 1;
    const cmp = (a: BoardRow, b: BoardRow) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      const primary = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return primary * dir || a.domain.localeCompare(b.domain);
    };
    if (view === "client") {
      return out.sort((a, b) => a.clientName.localeCompare(b.clientName) || cmp(a, b));
    }
    return out.sort(cmp);
  }, [rows, filter, query, sort, view]);

  function toggle(key: SortKey) {
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key === "messages" || key === "failed" || key === "failShare" }));
  }
  const dir = (key: SortKey) => (sort.key === key ? (sort.desc ? "desc" : "asc") : false) as "asc" | "desc" | false;

  function openRow(e: MouseEvent<HTMLTableRowElement>, slug: string) {
    // The domain cell is a real link; let it handle its own click.
    if ((e.target as HTMLElement).closest("a,button")) return;
    router.push(domainHref(slug));
  }

  const total = rows.length;

  return (
    <div className="flex flex-col gap-6">
      {/* ── Fleet posture ─────────────────────────────────────────────── */}
      <section aria-labelledby="fleet-head" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="fleet-head" className="legend">
            Fleet posture
          </h2>
          <p className="tnum text-meta text-fg-3">
            {total} domain{total === 1 ? "" : "s"} across {clientCount} client{clientCount === 1 ? "" : "s"}
            {counts.unread > 0 ? ` · ${counts.unread} could not be read` : ""}
          </p>
        </div>

        <div className="flex h-3 w-full overflow-hidden border border-fg/80 bg-paper-2" aria-hidden>
          {LEGEND_ORDER.map((p) =>
            counts[p] > 0 ? (
              <span
                key={p}
                className={clsx("h-full border-r border-paper-2 last:border-r-0", SEGMENT_FILL[p])}
                style={{ width: `${(counts[p] / total) * 100}%` }}
              />
            ) : null,
          )}
          {counts.unread > 0 ? (
            <span className="h-full bg-paper-3" style={{ width: `${(counts.unread / total) * 100}%` }} />
          ) : null}
        </div>

        <div role="group" aria-label="Filter by posture" className="flex flex-wrap items-stretch gap-x-1 gap-y-1">
          {LEGEND_ORDER.map((p) => {
            const on = filter === p;
            return (
              <button
                key={p}
                type="button"
                aria-pressed={on}
                onClick={() => setFilter(on ? "all" : p)}
                title={POSTURE_META[p].meaning}
                className={clsx(
                  "flex items-baseline gap-2 rounded-[2px] border px-2.5 py-1.5 text-left transition-colors duration-75",
                  on ? "border-act bg-paper-2 shadow-[inset_0_-2px_0_var(--color-act)]" : "border-transparent hover:border-rule-2 hover:bg-paper-2",
                  counts[p] === 0 && !on && "[&>span]:text-fg-3",
                )}
              >
                <PostureMark posture={p} />
                <span className="text-ui font-semibold text-fg">{POSTURE_META[p].label}</span>
                <span className="tnum text-ui font-semibold text-fg-2">{counts[p]}</span>
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
            className={clsx(
              "flex items-baseline gap-2 rounded-[2px] border px-2.5 py-1.5 transition-colors duration-75",
              filter === "all" ? "border-act bg-paper-2 shadow-[inset_0_-2px_0_var(--color-act)]" : "border-transparent hover:border-rule-2 hover:bg-paper-2",
            )}
          >
            <span className="text-ui font-semibold text-fg">All</span>
            <span className="tnum text-ui font-semibold text-fg-2">{total}</span>
          </button>
        </div>
      </section>

      {/* ── Domains ───────────────────────────────────────────────────── */}
      <section aria-labelledby="domains-head" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="domains-head" className="text-h3 font-bold tracking-[-0.01em]">
            Domains
          </h2>
          <span className="tnum text-meta text-fg-3" aria-live="polite">
            {shown.length === total ? `${total} shown` : `${shown.length} of ${total} shown`}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <SearchInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter domains or clients"
              aria-label="Filter domains or clients"
              className="w-60"
            />
            <Segmented<View>
              label="Arrange rows"
              value={view}
              onChange={setView}
              options={[
                { value: "priority", label: "By priority" },
                { value: "client", label: "By client" },
              ]}
            />
          </div>
        </div>

        <Table caption="Domains in this workspace with their measured posture" minWidth={1080}>
          <THead>
            <tr>
              <Th className="w-[118px]" sort={{ dir: dir("posture"), onToggle: () => toggle("posture") }}>
                Posture
              </Th>
              <Th sort={{ dir: dir("domain"), onToggle: () => toggle("domain") }}>Domain</Th>
              <Th sort={{ dir: dir("client"), onToggle: () => toggle("client") }}>Client</Th>
              <Th>Policy</Th>
              <Th numeric sort={{ dir: dir("messages"), onToggle: () => toggle("messages") }}>
                Messages
              </Th>
              <Th numeric sort={{ dir: dir("failed"), onToggle: () => toggle("failed") }}>
                Failed
              </Th>
              <Th sort={{ dir: dir("failShare"), onToggle: () => toggle("failShare") }}>Share</Th>
              <Th numeric sort={{ dir: dir("spf"), onToggle: () => toggle("spf") }}>
                SPF
              </Th>
              <Th numeric sort={{ dir: dir("dkim"), onToggle: () => toggle("dkim") }}>
                DKIM
              </Th>
              <Th numeric sort={{ dir: dir("lastReport"), onToggle: () => toggle("lastReport") }}>
                Report
              </Th>
              <Th>Owner</Th>
            </tr>
          </THead>
          <TBody>
            {shown.map((r, i) => {
              const firstOfClient = view === "client" && (i === 0 || shown[i - 1].clientName !== r.clientName);
              const share = failShare(r);
              return (
                <Tr
                  key={r.domainId}
                  data-domain-id={r.domainId}
                  interactive
                  onClick={(e) => openRow(e, r.slug)}
                  tone={r.posture === "block" ? "fail" : r.posture === "unverified" ? "warn" : r.posture === "stale" ? "void" : undefined}
                  className={clsx(firstOfClient && i > 0 && "border-t border-t-fg-4")}
                >
                  <Td>
                    {r.posture ? (
                      <PostureBadge posture={r.posture} reason={r.reason ?? undefined} />
                    ) : (
                      <span className="text-ui font-semibold text-fg-3" title="The measurement for this domain could not be read just now. It has no posture until it can be.">
                        Not read
                      </span>
                    )}
                  </Td>
                  <Td className="max-w-[230px]">
                    <Link href={domainHref(r.slug)} className="data block truncate text-ui font-semibold text-fg hover:text-act hover:underline">
                      {r.domain}
                    </Link>
                    <span className="mt-0.5 block truncate text-meta text-fg-3">
                      {r.reason ?? "measurement unavailable: no posture is claimed"}
                    </span>
                  </Td>
                  <Td className="max-w-[150px] truncate whitespace-nowrap" title={r.clientName}>
                    {view === "client" && !firstOfClient ? (
                      <>
                        <span aria-hidden className="text-fg-4">
                          〃
                        </span>
                        <span className="sr-only">{r.clientName}</span>
                      </>
                    ) : (
                      <span className="font-medium text-fg-2">{r.clientName}</span>
                    )}
                  </Td>
                  <Td mono={!!r.policy} muted={!r.policy} className="whitespace-nowrap">
                    {r.policy ? `p=${r.policy}` : <span className="text-meta">not observed</span>}
                  </Td>
                  <Td numeric>{r.messages === null ? <Nil /> : fmt(r.messages)}</Td>
                  <Td numeric className={r.failed ? "font-semibold text-fail" : undefined}>
                    {r.failed === null ? <Nil /> : fmt(r.failed)}
                  </Td>
                  <Td>
                    <ShareBar share={share} />
                  </Td>
                  <Td numeric muted>
                    {r.spfRate === null ? <Nil /> : pct(r.spfRate)}
                  </Td>
                  <Td numeric muted>
                    {r.dkimRate === null ? <Nil /> : pct(r.dkimRate)}
                  </Td>
                  <Td numeric muted title={r.lastReportLabel ?? "no aggregate report received"}>
                    {r.lastReportAgeDays === null ? (
                      <span className="text-fg-4">never</span>
                    ) : r.lastReportAgeDays === 0 ? (
                      "today"
                    ) : (
                      <span className={r.lastReportAgeDays > 5 ? "font-semibold text-void" : undefined}>
                        {r.lastReportAgeDays}d ago
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Ownership status={r.ownership} />
                  </Td>
                </Tr>
              );
            })}
            {shown.length === 0 ? (
              <TEmptyRow colSpan={11}>
                No domain matches {query ? <>&ldquo;{query}&rdquo;</> : "this filter"}
                {filter !== "all" ? <> with posture {POSTURE_META[filter].label}</> : null}.{" "}
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setFilter("all");
                    setQuery("");
                  }}
                >
                  Clear filters
                </button>
              </TEmptyRow>
            ) : null}
          </TBody>
        </Table>

        <p className="text-meta text-fg-3">
          Figures are each measured over that domain&rsquo;s own report window. Failed counts messages where SPF or
          DKIM did not pass; SPF and DKIM are pass rates. No report for more than 5 days reads as Stale; a domain with
          no reported messages reads as Not measured. Neither is ever counted as aligned.
        </p>
      </section>
    </div>
  );
}

/**
 * Failed share of observed volume, as a bar the eye can compare down the
 * column. No volume means no bar at all: a hatch, never an empty "0%" bar.
 */
function ShareBar({ share }: { share: number | null }) {
  if (share === null) {
    return (
      <span className="flex items-center gap-2" title="no messages measured">
        <span className="void-hatch block h-1.5 w-10 border border-rule-2" aria-hidden />
        <span className="sr-only">not measured</span>
      </span>
    );
  }
  const label = share === 0 ? "0%" : share < 0.001 ? "<0.1%" : `${(share * 100).toFixed(1)}%`;
  return (
    <span className="flex items-center gap-2">
      <span className="relative block h-1.5 w-10 bg-ok/25" aria-hidden>
        <span className="absolute inset-y-0 left-0 bg-fail" style={{ width: `${Math.max(share > 0 ? 4 : 0, share * 100)}%` }} />
      </span>
      <span className={clsx("tnum text-meta", share > 0 ? "font-semibold text-fail" : "text-fg-3")}>{label}</span>
    </span>
  );
}

function Ownership({ status }: { status: BoardRow["ownership"] }) {
  if (status === "VERIFIED") return <span className="whitespace-nowrap text-meta font-semibold text-ok">Verified</span>;
  if (status === "FAILED")
    return (
      <span className="whitespace-nowrap text-meta font-semibold text-fail" title="The ownership TXT check failed">
        Failed
      </span>
    );
  return (
    <span className="whitespace-nowrap text-meta font-semibold text-fg-3" title="Ownership not verified yet">
      Pending
    </span>
  );
}
