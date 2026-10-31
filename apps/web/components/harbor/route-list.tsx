/**
 * route-list.tsx — a short process drawn as one vertical line of stations,
 * for the side of a setup screen (the first domain, a provider switch).
 *
 *   reached   stations before `here`: ink, joined by a solid ink line
 *   here      the station the reader is at: ink, drawn larger
 *   ahead     stations after it, joined by a planned segment (dashed ink),
 *             because each step is ready and not yet taken
 *   terminus  the last station, a capsule, where the process delivers
 *
 * Each station is labelled the way the map labels one: a bold name, then a
 * lighter line saying what happens there. Static: no hooks, no motion.
 */

import { clsx } from "clsx";

export function RouteList({
  steps,
  here = 0,
  className,
}: {
  steps: Array<{ name: string; kind: string }>;
  /** The index of the station the reader is at; -1 when none is reached. */
  here?: number;
  className?: string;
}) {
  return (
    <ol className={clsx("flex flex-col", className)}>
      {steps.map((step, i) => {
        const isHere = i === here;
        const terminus = i === steps.length - 1;
        const travelled = i < here;
        return (
          <li key={step.name} aria-current={isHere ? "step" : undefined} className="relative grid grid-cols-[32px_minmax(0,1fr)] pb-5 last:pb-0">
            {!terminus ? (
              <span
                aria-hidden
                className={clsx(
                  "absolute bottom-[-4px] left-[11.5px] top-[14px] border-l-[3px] border-fg",
                  travelled ? "border-solid" : "border-dashed",
                )}
              />
            ) : null}
            <span aria-hidden className="relative flex h-[18px] items-center">
              <span
                className={clsx(
                  // Every mark is centred on the line, 13px in.
                  "block border-fg",
                  travelled ? "bg-fg" : "bg-paper",
                  terminus
                    ? "h-[14px] w-[26px] rounded-full border-[3px]"
                    : isHere
                      ? "ml-[4px] size-[18px] rounded-full border-4"
                      : "ml-[6px] size-[14px] rounded-full border-[3px]",
                )}
              />
            </span>
            <span className="min-w-0">
              <span className={clsx("block text-ui leading-[18px] text-fg", isHere || terminus ? "font-bold" : "font-semibold")}>
                {step.name}
                {isHere ? <span className="sr-only"> (you are here)</span> : null}
              </span>
              <span className="mt-0.5 block text-meta text-fg-2">{step.kind}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
