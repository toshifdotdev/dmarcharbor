"use client";

/**
 * portfolio-board.tsx — the Portfolio: every domain in the workspace, one view.
 *
 * It answers one question on open: what needs me today. So:
 *
 * - The posture filters carry the counts, grouped the way a technician works
 *   the list: what needs a person (blocking, unverified), what proves nothing
 *   yet (stale, not measured), and what is aligned. No separate stat strip
 *   restating the same counts.
 * - The table sorts by action priority by default (blocking, unverified,
 *   stale, not measured, aligned), and each row says WHY it has its posture in
 *   a line under the domain. A posture without its reason is a verdict without
 *   evidence.
 * - The policy column is a strip map (policy-strip.tsx): how far each domain
 *   has gone from p=none to p=reject, readable down the column at a glance.
 * - "By client" regroups the same rows under their client, the client named
 *   once per group (a ditto, as a printed ledger would), because the buyer is an
 *   agency and a client conversation is a group of domains.
 *
 * Rule Zero holds here as everywhere: a row whose measurement could not be read
 * has no posture at all, never a pass, and is counted apart. Stale and Not
 * measured are different facts with different marks, and a domain that has
 * reported no messages shows no figures, never zeros.
 *
 * Every value arrives computed by the server page (ages, labels, rates), so no
 * clock is read during render and hydration cannot disagree with the HTML.
 * Every tbody row is a domain row: the test suite clicks the first one.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { clsx } from "clsx";
import { POSTURE_META, POSTURE_ORDER, type Posture } from "@/lib/posture";
import { domainHref } from "@/lib/route-hrefs";
import { PostureBadge, PostureMark } from "@/components/ui/badge";
import { Segmented, SearchInput } from "@/components/ui/field";
import { Nil, Table, TBody, Td, TEmptyRow, Th, THead, Tr } from "@/components/ui/table";
import { PolicyStrip, policyStage } from "./policy-strip";

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

/** The filter groups, in the order the work is done. */
const FILTER_GROUPS: Posture[][] = [["block", "unverified"], ["stale", "unmeasured"], ["pass"]];

type SortKey = "posture" | "domain" | "client" | "policy" | "messages" | "failed" | "spf" | "dkim" | "lastReport";
type View = "priority" | "client";

const fmt = (n: number) => n.toLocaleString("en-GB");
/** The API sends pass rates as percentages already (0–100, two decimals). */
const pct = (r: number) => `${r === 100 || r === 0 ? r : r.toFixed(1)}%`;

/** A domain with no reported messages has proved nothing: no figure is shown for it. */
function measured(r: BoardRow): boolean {
  return r.posture !== null && r.posture !== "unmeasured" && r.messages !== null && r.messages > 0;
}

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
    case "policy":
      return policyStage(r.policy) ?? -1;
    case "messages":
      return measured(r) ? (r.messages ?? -1) : -1;
    case "failed":
      return measured(r) ? (r.failed ?? -1) : -1;
    case "spf":
      return r.spfRate ?? -1;
    case "dkim":
      return r.dkimRate ?? -1;
    case "lastReport":
      return r.lastReportAgeDays ?? Number.MAX_SAFE_INTEGER;
  }
}

export function PortfolioBoard({ rows }: { rows: BoardRow[]; clientCount?: number }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Posture | "all">("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("priority");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "posture", desc: false });

  // Counted over the whole fleet, never the filtered view: a filter's number is
  // a fact about the portfolio, not about the search box.
  const counts = useMemo(() => {
    const c: Record<Posture, number> = { block: 0, unverified: 0, stale: 0, unmeasured: 0, pass: 0 };
    for (const r of rows) if (r.posture) c[r.posture] += 1;
    return c;
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
    setSort((s) =>
      s.key === key ? { key, desc: !s.desc } : { key, desc: key === "messages" || key === "failed" || key === "policy" },
    );
  }
  const dir = (key: SortKey) => (sort.key === key ? (sort.desc ? "desc" : "asc") : false) as "asc" | "desc" | false;

  function openRow(e: MouseEvent<HTMLTableRowElement>, slug: string) {
    // The domain cell is a real link; let it handle its own click.
    if ((e.target as HTMLElement).closest("a,button")) return;
    router.push(domainHref(slug));
  }

  const total = rows.length;
  const filtered = filter !== "all" || query.trim() !== "";

  return (
    <section aria-labelledby="domains-head" className="flex flex-col gap-4">
      <h2 id="domains-head" className="sr-only">
        Domains
      </h2>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div role="group" aria-label="Filter by posture" className="flex flex-wrap items-center gap-y-1">
          {FILTER_GROUPS.map((group, gi) => (
            <Fragment key={group.join("-")}>
              {gi > 0 ? <span aria-hidden className="mx-2 h-5 w-px bg-rule-2" /> : null}
              {group.map((p) => (
                <FilterChip
                  key={p}
                  on={filter === p}
                  onClick={() => setFilter(filter === p ? "all" : p)}
                  title={POSTURE_META[p].meaning}
                  count={counts[p]}
                  mark={<PostureMark posture={p} />}
                >
                  {POSTURE_META[p].label}
                </FilterChip>
              ))}
            </Fragment>
          ))}
          <span aria-hidden className="mx-2 h-5 w-px bg-rule-2" />
          <FilterChip on={filter === "all"} onClick={() => setFilter("all")} count={total}>
            All
          </FilterChip>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto lg:ml-auto">
          <span aria-live="polite" className={clsx("tnum text-meta text-fg-3", !filtered && "sr-only")}>
            {shown.length} of {total} shown
          </span>
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter domains or clients"
            aria-label="Filter domains or clients"
            className="w-full sm:w-64"
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

      <Table caption="Domains in this workspace with their measured posture" minWidth={1040}>
        <THead>
          <tr>
            <Th className="w-[124px]" sort={{ dir: dir("posture"), onToggle: () => toggle("posture") }}>
              Posture
            </Th>
            <Th sort={{ dir: dir("domain"), onToggle: () => toggle("domain") }}>Domain</Th>
            <Th className="w-[168px]" sort={{ dir: dir("client"), onToggle: () => toggle("client") }}>
              Client
            </Th>
            <Th className="w-[140px]" sort={{ dir: dir("policy"), onToggle: () => toggle("policy") }}>
              Policy
            </Th>
            <Th numeric className="w-[96px]" sort={{ dir: dir("messages"), onToggle: () => toggle("messages") }}>
              Messages
            </Th>
            <Th numeric className="w-[112px]" sort={{ dir: dir("failed"), onToggle: () => toggle("failed") }}>
              Failed DMARC
            </Th>
            <Th numeric className="w-[72px]" sort={{ dir: dir("spf"), onToggle: () => toggle("spf") }}>
              SPF
            </Th>
            <Th numeric className="w-[72px]" sort={{ dir: dir("dkim"), onToggle: () => toggle("dkim") }}>
              DKIM
            </Th>
            <Th numeric className="w-[104px]" sort={{ dir: dir("lastReport"), onToggle: () => toggle("lastReport") }}>
              Last report
            </Th>
            <Th className="w-[96px]">Ownership</Th>
          </tr>
        </THead>
        <TBody>
          {shown.map((r, i) => {
            const firstOfClient = view === "client" && (i === 0 || shown[i - 1].clientName !== r.clientName);
            const has = measured(r);
            const share = has ? failShare(r) : null;
            return (
              <Tr
                key={r.domainId}
                data-domain-id={r.domainId}
                interactive
                onClick={(e) => openRow(e, r.slug)}
                tone={r.posture === "block" ? "fail" : r.posture === "unverified" ? "warn" : r.posture === "stale" ? "void" : undefined}
                className={clsx(firstOfClient && i > 0 && "border-t border-t-fg-4")}
              >
                <Td className="whitespace-nowrap pl-3">
                  {r.posture ? (
                    <PostureBadge posture={r.posture} reason={r.reason ?? undefined} />
                  ) : (
                    <span
                      className="text-ui font-semibold text-fg-3"
                      title="The measurement for this domain could not be read just now. It has no posture until it can be."
                    >
                      Not read
                    </span>
                  )}
                </Td>
                <Td className="max-w-[360px]">
                  <Link href={domainHref(r.slug)} className="data block truncate text-ui font-semibold text-fg hover:text-act hover:underline">
                    {r.domain}
                  </Link>
                  <span className="mt-0.5 block truncate text-meta text-fg-3" title={r.reason ?? undefined}>
                    {r.reason ?? "measurement unavailable: no posture is claimed"}
                  </span>
                </Td>
                <Td className="max-w-[168px] truncate whitespace-nowrap" title={r.clientName}>
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
                <Td>
                  <PolicyStrip
                    policy={r.policy}
                    title={
                      !r.policy
                        ? "No DMARC policy has been observed for this domain yet."
                        : policyStage(r.policy) === null
                          ? "The last DNS scan found no readable DMARC record."
                          : undefined
                    }
                  />
                </Td>
                <Td numeric>{has && r.messages !== null ? fmt(r.messages) : <Nil label="no messages reported" />}</Td>
                <Td numeric>
                  {!has || r.failed === null ? (
                    <Nil />
                  ) : r.failed === 0 ? (
                    <span className="text-fg-3">0</span>
                  ) : (
                    <>
                      <span className="font-semibold text-fail">{fmt(r.failed)}</span>
                      {share !== null ? (
                        <span className="mt-0.5 block text-meta text-fg-3">
                          {share < 0.001 ? "<0.1%" : `${(share * 100).toFixed(1)}%`} of mail
                        </span>
                      ) : null}
                    </>
                  )}
                </Td>
                <Td numeric muted>
                  {r.spfRate === null ? <Nil /> : pct(r.spfRate)}
                </Td>
                <Td numeric muted>
                  {r.dkimRate === null ? <Nil /> : pct(r.dkimRate)}
                </Td>
                <Td numeric title={r.lastReportLabel ?? "no aggregate report received"}>
                  {r.lastReportAgeDays === null ? (
                    <span className="text-fg-4">never</span>
                  ) : r.lastReportAgeDays === 0 ? (
                    <span className="text-fg-2">today</span>
                  ) : (
                    <span className={r.lastReportAgeDays > 5 ? "font-semibold text-fg" : "text-fg-2"}>
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
            <TEmptyRow colSpan={10}>
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

      <p className="max-w-[110ch] text-meta text-fg-3">
        Figures are each measured over that domain&rsquo;s own report window. Failed DMARC counts messages where both SPF
        and DKIM failed alignment; SPF and DKIM are pass rates. The policy line runs from p=none through p=quarantine to
        p=reject, inked as far as the domain has gone; a dotted line means no policy could be read. No report for more
        than 5 days reads as Stale; a domain with no reported messages reads as Not measured and shows no figures. Neither
        is ever counted as aligned.
      </p>
    </section>
  );
}

function FilterChip({
  on,
  onClick,
  count,
  mark,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  count: number;
  mark?: ReactNode;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={title}
      className={clsx(
        "inline-flex h-8 items-center gap-2 rounded-full border-[1.5px] px-3 text-ui transition-colors duration-150",
        on ? "border-fg text-fg" : "border-transparent text-fg hover:bg-paper-3",
      )}
    >
      {mark}
      <span className={clsx("font-semibold", count === 0 && !on && "text-fg-4")}>{children}</span>
      <span className={clsx("tnum font-semibold", count === 0 && !on ? "text-fg-4" : "text-fg-3")}>{count}</span>
    </button>
  );
}

/**
 * Ownership, quiet when it is the normal case. A verified domain is the
 * expected state and should not compete with the posture column; a pending or
 * removed record is the exception, so it takes its state colour and shape.
 */
function Ownership({ status }: { status: BoardRow["ownership"] }) {
  if (status === "VERIFIED") return <span className="whitespace-nowrap text-meta text-fg-3">Verified</span>;
  if (status === "FAILED")
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-meta font-semibold text-fail" title="The ownership TXT check failed">
        <span aria-hidden className="block size-[7px] rotate-45 bg-fail" />
        Failed
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-meta font-semibold text-warn" title="Ownership not verified yet">
      <span aria-hidden className="block size-2 rounded-full border-2 border-warn-mark" />
      Pending
    </span>
  );
}
