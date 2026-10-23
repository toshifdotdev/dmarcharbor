/**
 * readout.tsx — figures in a row, divided by hairlines, never boxed.
 *
 * The instrument panel of a screen: each cell is a label, a figure in tabular
 * numerals, and a line saying what the figure is measured over. Cells share a
 * baseline so figures can be compared across the strip at a glance. A figure
 * takes a state colour only when the figure IS a state (failures above zero).
 */

import { clsx } from "clsx";
import type { ReactNode } from "react";
import type { Tone } from "./badge";

export function ReadoutStrip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <dl
      className={clsx(
        "grid grid-cols-2 border-y border-rule sm:grid-cols-3 lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none",
        "[&>div]:border-rule [&>div]:py-3 [&>div]:pr-4 max-lg:[&>div]:border-b lg:[&>div+div]:border-l lg:[&>div+div]:pl-4",
        className,
      )}
    >
      {children}
    </dl>
  );
}

const VALUE_TONE: Partial<Record<Tone, string>> = {
  ok: "text-ok",
  warn: "text-warn",
  fail: "text-fail",
  crit: "text-crit",
  void: "text-void",
};

export function Readout({
  label,
  value,
  unit,
  note,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  note?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="min-w-0">
      <dt className="legend">{label}</dt>
      <dd className="mt-1 flex items-baseline gap-1">
        <span className={clsx("tnum text-h2 font-semibold tracking-[-0.01em]", (tone && VALUE_TONE[tone]) ?? "text-fg")}>
          {value}
        </span>
        {unit ? <span className="text-ui font-medium text-fg-3">{unit}</span> : null}
      </dd>
      {note ? <dd className="mt-0.5 text-meta text-fg-3">{note}</dd> : null}
    </div>
  );
}
