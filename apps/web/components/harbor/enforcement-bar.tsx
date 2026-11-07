/**
 * enforcement-bar.tsx — how far a set of domains has gone towards p=reject,
 * as one bar with a stretch per policy.
 *
 * The colour of each stretch is chosen for what it means:
 *   reject      the line in service: green
 *   quarantine  on the way: a lighter green
 *   none        watching, enforcing nothing: quiet grey
 *   missing     no DMARC record in DNS: work waiting on a person (amber mark)
 *   unseen      no policy observed yet: hatched, the "not measured" mark
 *
 * Plain elements, no SVG and no ids, so many bars can share a page.
 */

import { clsx } from "clsx";
import type { CSSProperties } from "react";
import { DrawOnView } from "./draw-on-view";

export type EnforcementStage = "reject" | "quarantine" | "none" | "missing" | "unseen";

export const ENFORCEMENT_STAGES: Array<{ key: EnforcementStage; label: string; fill: string }> = [
  { key: "reject", label: "at p=reject", fill: "bg-done" },
  { key: "quarantine", label: "at p=quarantine", fill: "bg-[color-mix(in_oklab,var(--color-done)_42%,white)]" },
  { key: "none", label: "at p=none", fill: "bg-rule-2" },
  { key: "missing", label: "with no DMARC record", fill: "bg-warn-mark" },
  { key: "unseen", label: "no policy observed yet", fill: "void-hatch" },
];

export function enforcementStage(policy: string | null): EnforcementStage {
  switch ((policy ?? "").toLowerCase()) {
    case "reject":
      return "reject";
    case "quarantine":
      return "quarantine";
    case "none":
      return "none";
    case "unknown":
      return "missing";
    default:
      return "unseen";
  }
}

export function enforcementCounts(policies: Array<string | null>): Map<EnforcementStage, number> {
  const counts = new Map<EnforcementStage, number>(ENFORCEMENT_STAGES.map((s) => [s.key, 0]));
  for (const p of policies) {
    const k = enforcementStage(p);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

export function EnforcementBar({
  policies,
  className,
  thin,
}: {
  policies: Array<string | null>;
  className?: string;
  /** 6px for a row in a list; 14px otherwise. */
  thin?: boolean;
}) {
  const counts = enforcementCounts(policies);
  const parts = ENFORCEMENT_STAGES.filter((s) => (counts.get(s.key) ?? 0) > 0);
  const label = parts.map((s) => `${counts.get(s.key)} ${s.label}`).join(", ");
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-draw
      className={clsx("flex overflow-hidden rounded-full", thin ? "h-[6px] gap-px" : "h-[14px] gap-[2px]", className)}
    >
      <DrawOnView />
      {parts.map((s, i) => (
        <span
          key={s.key}
          className={clsx("hb-grow-x block h-full min-w-[3px]", s.fill, s.key === "unseen" && "border border-rule-2")}
          // Shares by flex-grow, not percentage widths: the gaps come out of
          // the stretches, so a one-domain stretch at the end is never pushed
          // out of the rounded bar, and stays at least 3px wide.
          style={{ flex: `${counts.get(s.key) ?? 0} 1 0`, "--i": i } as CSSProperties}
        />
      ))}
    </span>
  );
}
