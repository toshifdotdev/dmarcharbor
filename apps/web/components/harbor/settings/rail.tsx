"use client";

/**
 * rail.tsx — the settings sections, grouped by the job, beside every section.
 *
 * Desktop: a quiet column of group headings and section names, the current one
 * marked with the accent bar every other navigation in the app uses. Sections
 * that hold an action nobody can take back carry a small diamond (the fail
 * shape), so the person can see before they open it that something there is
 * permanent. A diamond, not a red label: the rail is for finding, not warning.
 *
 * Narrow screens: the whole list folds into one disclosure that names where
 * you are, because fifteen links above every form pushes the form off screen.
 */

import Link from "next/link";
import { clsx } from "clsx";
import { SETTINGS_GROUPS, type SettingsKey } from "@/lib/settings-map";
import { ChevronDown } from "@/components/ui/icons";

function Links({ current }: { current: SettingsKey }) {
  return (
    <div className="flex flex-col gap-5">
      {SETTINGS_GROUPS.map((g) => (
        <div key={g.id}>
          <p className="legend px-2.5 pb-1">{g.title}</p>
          <ul className="flex flex-col">
            {g.sections.map((s) => {
              const on = s.key === current;
              return (
                <li key={s.key}>
                  <Link
                    href={s.href}
                    aria-current={on ? "page" : undefined}
                    className={clsx(
                      "relative flex items-center gap-2 rounded-ctl px-2.5 py-[5px] text-ui transition-colors duration-75",
                      on ? "bg-paper-3 font-semibold text-fg" : "font-medium text-fg-2 hover:bg-paper-3/60 hover:text-fg",
                      on && "before:absolute before:inset-y-1 before:left-0 before:w-[2px] before:bg-act",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{s.label}</span>
                    {s.irreversible ? (
                      <span
                        className="size-[7px] shrink-0 rotate-45 border border-fail/70"
                        title="Holds an action that cannot be undone"
                        aria-label="holds an action that cannot be undone"
                        role="img"
                      />
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <Link href="/settings" className="link px-2.5 text-meta">
        All settings, by task
      </Link>
    </div>
  );
}

export function SettingsRail({ current, currentLabel }: { current: SettingsKey; currentLabel: string }) {
  return (
    <>
      <nav aria-label="Settings sections" className="hidden lg:block">
        <div className="sticky top-[104px]">
          <Links current={current} />
        </div>
      </nav>
      <details className="group border-y border-rule lg:hidden">
        <summary className="flex cursor-pointer list-none items-center gap-2 py-2.5 text-ui [&::-webkit-details-marker]:hidden">
          <span className="legend">Settings</span>
          <span className="min-w-0 flex-1 truncate font-semibold text-fg">{currentLabel}</span>
          <span className="text-meta font-semibold text-fg-3">All sections</span>
          <ChevronDown size={14} className="text-fg-3 transition-transform group-open:rotate-180" />
        </summary>
        <nav aria-label="Settings sections" className="pb-4 pt-1 [animation:hb-rise_160ms_ease-out]">
          <Links current={current} />
        </nav>
      </details>
    </>
  );
}
