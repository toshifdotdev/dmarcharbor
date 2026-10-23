"use client";

/**
 * tabs.tsx — the WAI-ARIA tabs pattern, automatic activation.
 *
 * Arrow keys move and select, Home/End jump, Tab leaves the list for the panel.
 * The selected tab is written to the URL hash so an operator can send a
 * colleague straight to "Sources" on a domain, and a hash on arrival selects it.
 *
 * Every panel stays in the DOM, inactive ones `hidden`: a server-rendered panel
 * costs nothing to keep, find-in-page still finds it after it is selected, and
 * nothing is fetched again on switching.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { clsx } from "clsx";

export interface TabSpec {
  id: string;
  label: ReactNode;
  /** A count shown beside the label. null = not known (never shown as 0). */
  count?: number | null;
  panel: ReactNode;
}

export function Tabs({
  tabs,
  label,
  defaultTab,
  syncHash = true,
  className,
}: {
  tabs: TabSpec[];
  /** Accessible name for the tab list. */
  label: string;
  defaultTab?: string;
  syncHash?: boolean;
  className?: string;
}) {
  const base = useId();
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.id);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!syncHash) return;
    const fromHash = window.location.hash.slice(1);
    if (fromHash && tabs.some((t) => t.id === fromHash)) setActive(fromHash);
    // Mount only: the hash is read once on arrival.
  }, []);

  function select(id: string, focus = false) {
    setActive(id);
    if (syncHash) window.history.replaceState(null, "", `#${id}`);
    if (focus) refs.current[tabs.findIndex((t) => t.id === id)]?.focus();
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = tabs.findIndex((t) => t.id === active);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next >= 0) {
      e.preventDefault();
      select(tabs[next].id, true);
    }
  }

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKey}
        className="flex gap-5 overflow-x-auto border-b border-rule"
      >
        {tabs.map((t, i) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${t.id}`}
              aria-selected={on}
              aria-controls={`${base}-panel-${t.id}`}
              tabIndex={on ? 0 : -1}
              onClick={() => select(t.id)}
              className={clsx(
                "relative -mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 text-ui font-semibold transition-colors duration-100",
                on ? "border-act text-fg" : "border-transparent text-fg-3 hover:text-fg",
              )}
            >
              {t.label}
              {t.count !== undefined && t.count !== null ? (
                <span className={clsx("tnum text-meta font-medium", on ? "text-fg-2" : "text-fg-4")}>{t.count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={t.id !== active}
          tabIndex={0}
          className="focus-visible:outline-offset-4"
        >
          {t.panel}
        </div>
      ))}
    </div>
  );
}
