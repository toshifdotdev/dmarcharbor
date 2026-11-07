/**
 * sender-share.tsx — who carries this domain's mail, as one bar.
 *
 * A stretch per line on the route map, in that line's own colour, so the bar
 * and the map name the same sender the same way (one colour, one service).
 * The forged line is red with the dash the map gives it. Each stretch is
 * labelled below with its share; a stretch too narrow to see is still named.
 * No hooks: it renders on the server with the map.
 */

import type { RouteLine } from "./domain-routes";

function share(n: number, total: number): string {
  const p = (n / total) * 100;
  if (p > 0 && p < 0.1) return "<0.1%";
  return `${p >= 99.95 ? 100 : Math.round(p * 10) / 10}%`;
}

export function SenderShare({ lines }: { lines: RouteLine[] }) {
  const total = lines.reduce((n, l) => n + l.total, 0);
  if (total === 0 || lines.length === 0) return null;
  const ordered = [...lines].sort((a, b) => Number(a.forged) - Number(b.forged) || b.total - a.total);
  const label = ordered.map((l) => `${l.name} ${share(l.total, total)}`).join(", ");

  return (
    <div className="flex flex-col gap-2" data-testid="sender-share">
      <p className="text-meta">
        <span className="font-bold text-fg">Who sends</span> <span className="text-fg-3">each line&rsquo;s share of the mail</span>
      </p>
      <span role="img" aria-label={label} className="flex h-[10px] gap-[2px] overflow-hidden rounded-full">
        {ordered.map((l) => (
          <span
            key={l.key}
            className="block h-full min-w-[3px]"
            // flex-grow by share, so the gaps never push the last (forged)
            // stretch out of the bar, however small it is.
            style={{
              flex: `${l.total} 1 0`,
              background: l.forged
                ? `repeating-linear-gradient(90deg, ${l.colour} 0 7px, color-mix(in oklab, ${l.colour} 35%, white) 7px 11px)`
                : l.colour,
            }}
          />
        ))}
      </span>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-meta">
        {ordered.map((l) => (
          <li key={l.key} className="inline-flex min-w-0 max-w-full items-center gap-1.5">
            <span aria-hidden className="block h-[5px] w-3 shrink-0 rounded-full" style={{ background: l.colour }} />
            <span className={`truncate font-semibold ${l.forged ? "text-fail" : "text-fg"} ${l.mono ? "data" : ""}`}>{l.name}</span>
            <span className="tnum text-fg-3">{share(l.total, total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
