/**
 * table.tsx — the table, in the Routes language.
 *
 * Set like a timetable, not a spreadsheet: sentence-case column labels over a
 * firmer rule, hairlines between rows, a hairline to close. No vertical rules,
 * no zebra, no card around it. Every cell sits on the first line's baseline so
 * a domain, a posture word and a figure in the same row line up.
 *
 * Figures are right-aligned in tabular numerals; identifiers (domains, IPs,
 * report ids) are set in the data face. The `numeric` and `mono` props are the
 * only two decisions a caller needs to make per column.
 *
 * No hooks here: a server page renders a static table with these, a client
 * component renders a sortable one with the same parts.
 */

import { clsx } from "clsx";
import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { SortGlyph } from "./icons";

export function Table({
  children,
  className,
  caption,
  dense,
  minWidth,
  ...rest
}: HTMLAttributes<HTMLTableElement> & {
  /** Read by screen readers; visually hidden. Say what the rows are. */
  caption?: string;
  dense?: boolean;
  /** Below this width the table scrolls sideways instead of crushing columns. */
  minWidth?: number;
}) {
  return (
    // Positioned, so the visually hidden labels inside cells (position:
    // absolute) are clipped by this scroller. Without it they are placed
    // against the page instead and a scrolled table widens the whole page.
    <div className="relative overflow-x-auto">
      <table
        data-dense={dense ? "" : undefined}
        className={clsx(
          "group/table w-full border-collapse border-b border-rule text-left text-ui",
          className,
        )}
        style={minWidth ? { minWidth } : undefined}
        {...rest}
      >
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="border-b border-rule-2">{children}</thead>;
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="[&>tr:last-child]:border-b-0">{children}</tbody>;
}

export function Tr({
  className,
  interactive,
  tone,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & {
  /** The whole row opens something: pointer and hover tint. */
  interactive?: boolean;
  /** A left edge mark for rows that need a person: the state colour, 2px. */
  tone?: "fail" | "warn" | "void";
}) {
  return (
    <tr
      className={clsx(
        "border-b border-rule align-baseline",
        interactive && "cursor-pointer transition-colors duration-75 hover:bg-paper-3/70",
        tone === "fail" && "shadow-[inset_2px_0_0_var(--color-fail)]",
        tone === "warn" && "shadow-[inset_2px_0_0_var(--color-warn-mark)]",
        tone === "void" && "shadow-[inset_2px_0_0_var(--color-void)]",
        className,
      )}
      {...rest}
    />
  );
}

type Align = "left" | "right" | "center";

export function Th({
  children,
  numeric,
  align,
  sort,
  className,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & {
  numeric?: boolean;
  align?: Align;
  /** Present on sortable columns. `dir` false = sortable, not sorted. */
  sort?: { dir: "asc" | "desc" | false; onToggle: () => void };
}) {
  const a = align ?? (numeric ? "right" : "left");
  return (
    <th
      scope="col"
      aria-sort={sort ? (sort.dir === "asc" ? "ascending" : sort.dir === "desc" ? "descending" : "none") : undefined}
      className={clsx(
        "legend whitespace-nowrap px-2.5 pb-2 pt-2.5 align-bottom font-semibold group-data-[dense]/table:py-1.5",
        a === "right" && "text-right",
        a === "center" && "text-center",
        className,
      )}
      {...rest}
    >
      {sort ? (
        <button
          type="button"
          onClick={sort.onToggle}
          className={clsx(
            "-mx-1 inline-flex items-center gap-1 rounded-md px-1 hover:text-fg",
            a === "right" && "flex-row-reverse",
            sort.dir && "text-fg",
          )}
        >
          {children}
          <SortGlyph dir={sort.dir} size={12} />
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function Td({
  children,
  numeric,
  mono,
  align,
  muted,
  className,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & {
  numeric?: boolean;
  mono?: boolean;
  align?: Align;
  muted?: boolean;
}) {
  const a = align ?? (numeric ? "right" : "left");
  return (
    <td
      className={clsx(
        "px-2.5 py-2 group-data-[dense]/table:py-1.5",
        numeric && "tnum whitespace-nowrap",
        mono && "data",
        a === "right" && "text-right",
        a === "center" && "text-center",
        muted ? "text-fg-3" : "text-fg",
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

/** The em-dash every empty numeric cell gets, with a name for screen readers. */
export function Nil({ label = "not measured" }: { label?: string }) {
  return (
    <span className="text-fg-4" aria-label={label} title={label}>
      —
    </span>
  );
}

/** The single row a table shows when a filter leaves nothing. */
export function TEmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-10 text-center text-ui text-fg-3">
        {children}
      </td>
    </tr>
  );
}
