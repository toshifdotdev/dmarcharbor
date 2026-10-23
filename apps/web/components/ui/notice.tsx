/**
 * notice.tsx — an inline statement about the state of something, beside it.
 *
 * Not a toast, not a banner: a notice sits next to the thing it is about and
 * stays until the condition ends. Every tone carries its posture shape as
 * well as its colour, so nothing is said in colour alone.
 *
 * kv.tsx-style key/value lists live here too: the settings and evidence
 * screens all need "label, value" rows set on a shared baseline.
 */

import { clsx } from "clsx";
import type { ReactNode } from "react";

type NoticeTone = "info" | "ok" | "warn" | "fail";

const FRAME: Record<NoticeTone, string> = {
  info: "border-rule-2 bg-paper-2",
  ok: "border-ok/35 bg-ok-wash/70",
  warn: "border-warn/35 bg-warn-wash/80",
  fail: "border-fail/35 bg-fail-wash/80",
};

function Mark({ tone }: { tone: NoticeTone }) {
  return (
    <span aria-hidden className="mt-[5px] grid size-2.5 shrink-0 place-items-center">
      {tone === "ok" ? <span className="block size-2 bg-ok" /> : null}
      {tone === "fail" ? <span className="block size-2 rotate-45 bg-fail" /> : null}
      {tone === "warn" ? <span className="block size-2.5 rounded-full border-2 border-warn-mark" /> : null}
      {tone === "info" ? <span className="block size-2 rounded-full bg-act" /> : null}
    </span>
  );
}

export function Notice({
  tone = "info",
  title,
  children,
  action,
  role,
  className,
  testId,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  /** "alert" for a failure the person must act on; "status" otherwise. */
  role?: "alert" | "status";
  className?: string;
  testId?: string;
}) {
  return (
    <div
      role={role ?? (tone === "fail" ? "alert" : "status")}
      data-testid={testId}
      className={clsx("flex flex-wrap items-start gap-x-3 gap-y-2 rounded-ctl border px-3 py-2.5", FRAME[tone], className)}
    >
      <Mark tone={tone} />
      <div className="min-w-0 flex-1 text-ui">
        {title ? <p className="font-semibold text-fg">{title}</p> : null}
        {children ? <div className={clsx("text-fg-2", title && "mt-0.5")}>{children}</div> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

/**
 * Label/value rows on hairlines. `align="end"` right-aligns values, for
 * figures that should line up down the column.
 */
export function KeyValue({
  rows,
  align = "start",
  labelWidth = 160,
  className,
}: {
  rows: Array<[ReactNode, ReactNode] | null | false>;
  align?: "start" | "end";
  labelWidth?: number;
  className?: string;
}) {
  return (
    <dl className={clsx("border-t border-rule", className)}>
      {rows.filter(Boolean).map((row, i) => {
        const [k, v] = row as [ReactNode, ReactNode];
        return (
          <div
            key={i}
            className="grid items-baseline gap-x-4 border-b border-rule py-2"
            style={{ gridTemplateColumns: `minmax(0,${labelWidth}px) minmax(0,1fr)` }}
          >
            <dt className="text-meta font-semibold text-fg-3">{k}</dt>
            <dd className={clsx("min-w-0 text-ui text-fg", align === "end" && "text-right")}>{v}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/** A keyboard key, as it is printed on the key. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={clsx(
        "inline-grid h-[18px] min-w-[18px] place-items-center rounded-[3px] border border-rule-2 bg-paper-2 px-1 font-ui text-[10.5px] font-semibold text-fg-3 shadow-[0_1px_0_var(--color-rule-2)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
