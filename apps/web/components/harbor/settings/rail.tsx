"use client";

/**
 * rail.tsx — the settings sections beside every section, drawn as four short
 * lines of stops.
 *
 * Each group is a line and each section a station on it. The line is a quiet
 * grey; the section you are on is an ink capsule with its name in bold, the
 * way a line diagram marks "you are here". Sections that hold an action nobody
 * can take back carry the hollow diamond, so the person can see before they
 * open one that something there is permanent. The diamond is ink, not red: the
 * rail is for finding, not warning.
 *
 * Narrow screens: the whole list folds into one disclosure that names where
 * you are, because nineteen links above every form push the form off screen.
 */

import Link from "next/link";
import { clsx } from "clsx";
import { SETTINGS_GROUPS, type SettingsKey } from "@/lib/settings-map";
import { ChevronDown } from "@/components/ui/icons";
import { PermanentMark } from "./parts";

function Links({ current, className }: { current: SettingsKey; className?: string }) {
  return (
    <div className={clsx("flex flex-col gap-6", className)}>
      {SETTINGS_GROUPS.map((g) => (
        <div key={g.id}>
          <p className="pb-1.5 text-meta font-bold text-fg">{g.title}</p>
          <div className="relative">
            <span aria-hidden className="absolute bottom-[15px] left-[6px] top-[15px] w-[3px] rounded-full bg-rule-2" />
            <ul>
              {g.sections.map((s) => {
                const on = s.key === current;
                return (
                  <li key={s.key} className="relative">
                    <Link
                      href={s.href}
                      aria-current={on ? "page" : undefined}
                      className={clsx(
                        "group/stop relative flex min-h-[30px] items-center gap-2 py-1 pl-6 pr-1 text-ui transition-colors duration-100",
                        on ? "font-semibold text-fg" : "font-medium text-fg-2 hover:text-fg",
                      )}
                    >
                      <span
                        aria-hidden
                        className={clsx(
                          "absolute top-1/2 z-[1] block -translate-y-1/2 rounded-full bg-paper",
                          on
                            ? "-left-[3.5px] h-[14px] w-[22px] border-[3px] border-fg"
                            : "left-[2.5px] size-[10px] border-2 border-fg-4 transition-colors duration-100 group-hover/stop:border-fg",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate group-hover/stop:underline group-hover/stop:decoration-rule-2 group-hover/stop:underline-offset-[3px]">
                        {s.label}
                      </span>
                      {s.irreversible ? (
                        <PermanentMark size={8} className="text-fg-3" label="Holds an action that cannot be undone" />
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ))}
      <Link href="/settings" className="link self-start text-meta font-semibold">
        All settings, by task
      </Link>
    </div>
  );
}

export function SettingsRail({ current, currentLabel }: { current: SettingsKey; currentLabel: string }) {
  return (
    <>
      <nav aria-label="Settings sections" className="hidden lg:block">
        <div className="sticky top-[117px]">
          <Links current={current} />
        </div>
      </nav>
      <details className="group border-y border-rule lg:hidden">
        <summary
          aria-label={`Settings sections. You are on ${currentLabel}.`}
          className="flex min-h-11 cursor-pointer list-none items-center gap-2.5 py-2 text-ui [&::-webkit-details-marker]:hidden"
        >
          <span className="min-w-0 flex-1 truncate font-semibold text-fg">All settings sections</span>
          <ChevronDown size={14} className="text-fg-3 transition-transform duration-150 group-open:rotate-180" />
        </summary>
        <nav aria-label="Settings sections" className="pb-5 pt-2">
          <Links current={current} className="sm:grid sm:grid-cols-2 sm:gap-x-10" />
        </nav>
      </details>
    </>
  );
}
