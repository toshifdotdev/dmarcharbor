"use client";

/**
 * portfolio.tsx — the screen that matters most.
 *
 * An MSP sees every client and every domain in ONE view: portfolio first,
 * drill down second. The layout answers one question on open: what needs me
 * today. So actionable postures sort to the top and carry a row treatment,
 * and the posture counts ARE the filter chips — no separate stat row.
 *
 * Rule Zero governs the state column. Five postures, never four:
 *   never measured · stale · blocking · unverified · aligned
 * Stale (measured, then quiet) and Not measured (never measured) are
 * different facts and must never read as one. A row whose signals are still
 * loading shows a neutral "signals pending" cell — never a posture, never a
 * pass.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import type { ClientRow, DomainSignals, DomainRow } from "@/lib/types";
import {
  fmtVolume,
  policyLabel,
  POSTURE_ORDER,
  type Posture,
  type ResolvedPosture,
} from "@/lib/posture";
import { PostureBadge } from "@/components/posture";
import { domainHref } from "@/lib/route-hrefs";

export type PortfolioRow = {
  client: ClientRow;
  domain: DomainRow;
  signals: DomainSignals | null;
  resolved: ResolvedPosture | null;
};

const POSTURE_FILTERS: Array<{ key: Posture | "all"; label: string }> = [
  { key: "block", label: "Blocking" },
  { key: "unverified", label: "Unverified" },
  { key: "stale", label: "Stale" },
  { key: "unmeasured", label: "Not measured" },
  { key: "pass", label: "Aligned" },
  { key: "all", label: "All" },
];

/** Row treatment for postures that need a person today. */
const ROW_TREATMENT: Partial<Record<Posture, string>> = {
  block: "var(--color-block)",
  unverified: "var(--color-unverified)",
  stale: "var(--color-unmeasured)",
};

export function PortfolioGrid({ rows }: { rows: PortfolioRow[] }) {
  const router = useRouter();
  // Default sort is action priority: what needs a person today rises.
  const [sorting, setSorting] = useState<SortingState>([
    { id: "posture", desc: false },
  ]);
  const [postureFilter, setPostureFilter] = useState<Posture | "all">("all");
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  // Counts answer "what needs me today" and ARE the filters. Counted over the
  // full fleet, never over the query-filtered view: a chip's number is a fact
  // about the portfolio.
  const counts = useMemo(() => {
    const c: Record<Posture, number> = {
      block: 0,
      unverified: 0,
      stale: 0,
      unmeasured: 0,
      pass: 0,
    };
    let pending = 0;
    for (const r of rows) {
      if (r.resolved) c[r.resolved.posture] += 1;
      else pending += 1;
    }
    return { ...c, pending, total: rows.length };
  }, [rows]);

  const columns = useMemo<ColumnDef<PortfolioRow>[]>(
    () => [
      {
        id: "client",
        header: "Client",
        accessorFn: (r) => r.client.name,
        cell: (info) => (
          <span className="font-medium" style={{ color: "var(--color-ink)" }}>
            {info.row.original.client.name}
          </span>
        ),
      },
      {
        id: "domain",
        header: "Domain",
        accessorFn: (r) => r.domain.name,
        cell: (info) => (
          <span className="num text-[14px]" style={{ color: "var(--color-ink)" }}>
            {info.row.original.domain.name}
          </span>
        ),
      },
      {
        id: "posture",
        header: "Posture",
        accessorFn: (r) =>
          r.resolved ? POSTURE_ORDER[r.resolved.posture] : Number.MAX_SAFE_INTEGER,
        cell: (info) => {
          const { resolved } = info.row.original;
          if (!resolved) {
            // Signals not yet known. Rule Zero: never a posture, never a pass.
            return (
              <span
                className="num text-[11.5px] tracking-[0.12em] uppercase"
                style={{ color: "var(--color-ink-3)" }}
                title="Measurement signals have not loaded for this domain yet."
              >
                Signals pending
              </span>
            );
          }
          return <PostureBadge posture={resolved.posture} reason={resolved.reason} />;
        },
      },
      {
        id: "messages",
        header: "Messages (window)",
        accessorFn: (r) => r.signals?.messageCount ?? -1,
        cell: (info) => {
          const s = info.row.original.signals;
          if (!s)
            return (
              <span style={{ color: "var(--color-ink-3)" }} aria-label="no measurement">
                —
              </span>
            );
          return (
            <span className="num text-[13.5px]" style={{ color: "var(--color-ink-2)" }}>
              {fmtVolume(s.messageCount)}
            </span>
          );
        },
      },
      {
        id: "failed",
        header: "Failed",
        accessorFn: (r) => r.signals?.failedMessages ?? -1,
        cell: (info) => {
          const s = info.row.original.signals;
          if (!s)
            return (
              <span style={{ color: "var(--color-ink-3)" }} aria-label="no measurement">
                —
              </span>
            );
          return (
            <span
              className="num text-[13.5px]"
              style={{
                color: s.failedMessages > 0 ? "var(--color-block)" : "var(--color-ink-2)",
              }}
            >
              {fmtVolume(s.failedMessages)}
            </span>
          );
        },
      },
      {
        id: "policy",
        header: "DMARC policy",
        accessorFn: (r) => policyLabel(r.domain.dmarcPolicy, r.signals?.reportedPolicy ?? null),
        cell: (info) => {
          const label = policyLabel(
            info.row.original.domain.dmarcPolicy,
            info.row.original.signals?.reportedPolicy ?? null,
          );
          const observed = label !== "not observed";
          return (
            <span className="num text-[13px]" style={{ color: observed ? "var(--color-ink-2)" : "var(--color-ink-3)" }}>
              {observed ? `p=${label}` : label}
            </span>
          );
        },
      },
      {
        id: "lastReport",
        header: "Last report",
        accessorFn: (r) => r.signals?.lastReportAt ?? "",
        cell: (info) => {
          const at = info.row.original.signals?.lastReportAt;
          if (!at)
            return (
              <span style={{ color: "var(--color-ink-3)" }} aria-label="never">
                never
              </span>
            );
          const days = Math.floor((Date.now() - new Date(at).getTime()) / 86_400_000);
          return (
            <span className="num text-[13px]" style={{ color: "var(--color-ink-2)" }}>
              {days === 0 ? "today" : `${days}d ago`}
            </span>
          );
        },
      },
    ],
    [],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (postureFilter !== "all") {
        if (!r.resolved) return false;
        if (r.resolved.posture !== postureFilter) return false;
      }
      if (!q) return true;
      return (
        r.domain.name.toLowerCase().includes(q) ||
        r.client.name.toLowerCase().includes(q)
      );
    });
  }, [rows, query, postureFilter]);

  const table = useReactTable({
    data: filtered,
    columns,
    state: {
      sorting,
      columnVisibility: Object.fromEntries([...hidden].map((id) => [id, false])),
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide());

  return (
    <div className="flex flex-col gap-3">
      {/*
        The toolbar: one compact block. The counts ARE the filters — five chips
        plus All replace the old headline, subhead and 5-figure stat row.
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {POSTURE_FILTERS.map((f) => {
            const on = postureFilter === f.key;
            const n = f.key === "all" ? counts.total : counts[f.key];
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setPostureFilter(f.key)}
                aria-pressed={on}
                className="rounded-[2px] border px-3 py-1.5 text-[13px] font-medium transition-colors"
                style={{
                  borderColor: on ? "var(--color-accent)" : "var(--color-line-strong)",
                  background: on ? "var(--color-accent-soft)" : "transparent",
                  color: on ? "var(--color-ink)" : "var(--color-ink-3)",
                }}
              >
                {f.label}{" "}
                <span className="num" style={{ color: on ? "var(--color-ink-2)" : "var(--color-ink-3)" }}>
                  {n}
                </span>
              </button>
            );
          })}
          {counts.pending > 0 ? (
            <span className="num text-[11.5px] tracking-[0.12em] uppercase" style={{ color: "var(--color-ink-3)" }}>
              {counts.pending} signals pending
            </span>
          ) : null}
        </div>

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter domains or clients…"
          aria-label="Filter domains or clients"
          className="w-64 rounded-[2px] border px-3.5 py-2 text-[13.5px] outline-none"
          style={{
            background: "var(--color-surface)",
            borderColor: "var(--color-line-strong)",
            color: "var(--color-ink)",
          }}
        />

        {/* Columns — one popover, so control chrome doesn't outweigh data. */}
        <details className="relative ml-auto">
          <summary
            className="cursor-pointer list-none rounded-[2px] border px-3 py-2 text-[13px] font-medium"
            style={{
              borderColor: "var(--color-line-strong)",
              color: "var(--color-ink-2)",
            }}
          >
            Columns ({hideable.length - hidden.size})
          </summary>
          <div
            className="lift absolute right-0 z-20 mt-1 min-w-[190px] rounded-[2px] border py-1.5"
            style={{
              background: "var(--color-raised)",
              borderColor: "var(--color-line-strong)",
            }}
          >
            {hideable.map((col) => {
              const on = col.getIsVisible();
              return (
                <label
                  key={col.id}
                  className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[13px] hover:bg-[var(--color-elevate)]"
                  style={{ color: on ? "var(--color-ink-2)" : "var(--color-ink-3)" }}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => {
                      setHidden((prev) => {
                        const next = new Set(prev);
                        if (next.has(col.id)) next.delete(col.id);
                        else next.add(col.id);
                        return next;
                      });
                    }}
                  />
                  {col.id}
                </label>
              );
            })}
          </div>
        </details>
      </div>

      <div className="lift overflow-hidden rounded-[2px] border" style={{ borderColor: "var(--color-line)" }}>
        <table className="w-full border-collapse">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    className="label border-b px-4 py-2.5 text-left"
                    style={{ borderColor: "var(--color-line)" }}
                  >
                    {h.isPlaceholder ? null : (
                      <button
                        type="button"
                        onClick={h.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1.5"
                        style={{
                          cursor: h.column.getCanSort() ? "pointer" : "default",
                        }}
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        {h.column.getIsSorted() ? (
                          <span aria-hidden style={{ color: "var(--color-ink-3)" }}>
                            {h.column.getIsSorted() === "asc" ? "↑" : "↓"}
                          </span>
                        ) : null}
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const posture = row.original.resolved?.posture;
              const accent = posture ? ROW_TREATMENT[posture] : undefined;
              return (
                <tr
                  key={row.id}
                  data-domain-id={row.original.domain.id}
                  onClick={() => router.push(domainHref(row.original.domain.id))}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") router.push(domainHref(row.original.domain.id));
                  }}
                  className="cursor-pointer transition-colors hover:bg-[var(--color-surface)]"
                  style={
                    accent
                      ? {
                          boxShadow: `inset 2px 0 0 ${accent}`,
                          background: "rgba(255,255,255,0.02)",
                        }
                      : undefined
                  }
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="border-b px-4 py-2.5 text-[14px]"
                      style={{
                        borderColor: "rgba(255,255,255,0.055)",
                        color: "var(--color-ink-2)",
                      }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-12 text-center text-[14px]"
                  style={{ color: "var(--color-ink-3)" }}
                >
                  {rows.length === 0
                    ? "No clients or domains yet. Add a client to start measuring."
                    : "No rows match this filter."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="num text-[12px]" style={{ color: "var(--color-ink-3)" }}>
        {table.getRowModel().rows.length} of {rows.length} domains · sorted by
        what needs action · precedence: never measured → stale → blocking →
        unverified → aligned
      </p>
    </div>
  );
}
