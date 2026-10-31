/**
 * policy-strip.tsx — how far a domain has gone on the way to p=reject, drawn
 * as the steering file's strip map: a 5px line with three small stations at
 * fixed positions, p=none, p=quarantine and p=reject.
 *
 *   travelled     ink, from p=none up to the policy the domain publishes
 *   here          the station it is at, drawn larger, with the literal tag
 *                 set under it the way a map labels a station
 *   ahead         the line in rule grey, its stations hollow
 *   no policy     the line dotted and every station closed: nothing observed
 *                 is never drawn as being at p=none
 *
 * The tag under the station is the row's only policy text, so a reader (or a
 * test) looking for "p=reject" in a row finds the one the domain publishes,
 * and a domain with no observed policy has none at all.
 *
 * No hooks and no motion: a dense list redrawn every morning should be still.
 */

import { clsx } from "clsx";

export type PolicyStage = 0 | 1 | 2;

/** none, quarantine, reject; anything else (unknown, a typo, nothing) is no stage. */
export function policyStage(policy: string | null | undefined): PolicyStage | null {
  switch ((policy ?? "").trim().toLowerCase()) {
    case "none":
      return 0;
    case "quarantine":
      return 1;
    case "reject":
      return 2;
    default:
      return null;
  }
}

const W = 112;
const H = 16;
const Y = 8;
const STATIONS = [7, 56, 105] as const;

export function PolicyStrip({
  policy,
  emptyLabel = "not observed",
  unknownLabel = "no record in DNS",
  inline,
  title,
  className,
}: {
  /** The policy tag value: none, quarantine, reject, unknown, or null. */
  policy: string | null;
  /** Shown when no policy was observed at all. */
  emptyLabel?: string;
  /** Shown for a scan that found no readable DMARC record. */
  unknownLabel?: string;
  /** The tag beside the line rather than under its station: for single-line rows. */
  inline?: boolean;
  title?: string;
  className?: string;
}) {
  const stage = policyStage(policy);
  const raw = (policy ?? "").trim().toLowerCase();
  const label =
    stage !== null ? `p=${raw}` : raw === "unknown" ? unknownLabel : raw ? `p=${raw}` : emptyLabel;

  return (
    <span
      className={clsx(
        "align-baseline",
        inline ? "inline-flex items-baseline gap-2.5" : "inline-flex w-[112px] flex-col gap-0.5",
        className,
      )}
      title={title}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden className="block shrink-0 translate-y-[3px] overflow-visible">
        {stage === null ? (
          <line
            x1={STATIONS[0]}
            y1={Y}
            x2={STATIONS[2]}
            y2={Y}
            stroke="var(--color-rule-2)"
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray="0.01 6"
          />
        ) : (
          <>
            <line x1={STATIONS[0]} y1={Y} x2={STATIONS[2]} y2={Y} stroke="var(--color-rule)" strokeWidth={5} strokeLinecap="round" />
            {stage > 0 ? (
              <line x1={STATIONS[0]} y1={Y} x2={STATIONS[stage]} y2={Y} stroke="var(--color-fg)" strokeWidth={5} strokeLinecap="round" />
            ) : null}
          </>
        )}
        {STATIONS.map((x, i) => {
          const here = stage === i;
          const reached = stage !== null && i <= stage;
          return (
            <circle
              key={x}
              cx={x}
              cy={Y}
              r={here ? 5.5 : 3.75}
              fill="var(--color-paper)"
              stroke={reached ? "var(--color-fg)" : "var(--color-rule-2)"}
              strokeWidth={here ? 3 : 2.5}
            />
          );
        })}
      </svg>
      <span
        className={clsx(
          "block whitespace-nowrap text-meta",
          stage === null ? "text-left text-fg-4" : "data text-fg",
          !inline && "pt-1",
          !inline && stage === 1 && "text-center",
          !inline && stage === 2 && "text-right",
        )}
      >
        {label}
      </span>
    </span>
  );
}
