"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkspaceSummary } from "@/lib/types";

/**
 * The workspace switcher is ambient chrome (context rule 2). It answers
 * "which workspace am I in" at a glance and changes context without ever
 * standing between the operator and the portfolio.
 */
export function WorkspaceSwitcher({
  workspaces,
  activeWorkspace,
}: {
  workspaces: WorkspaceSummary[];
  activeWorkspace: WorkspaceSummary;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex items-center gap-2 rounded-[2px] border px-3 py-1.5 text-[13.5px]"
        style={{
          borderColor: "var(--color-line-strong)",
          background: "var(--color-surface)",
          color: "var(--color-ink-2)",
        }}
      >
        <span style={{ color: "var(--color-ink)" }}>{activeWorkspace.name}</span>
        <span aria-hidden style={{ color: "var(--color-ink-3)" }}>
          ▾
        </span>
      </button>

      {open ? (
        <ul
          role="listbox"
          className="lift absolute right-0 z-20 mt-1 min-w-[220px] rounded-[2px] border py-1"
          style={{
            background: "var(--color-raised)",
            borderColor: "var(--color-line-strong)",
          }}
        >
          {workspaces.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                role="option"
                aria-selected={w.id === activeWorkspace.id}
                onClick={() => {
                  setOpen(false);
                  document.cookie = `harbor.workspace=${w.id}; path=/; max-age=31536000`;
                  router.refresh();
                }}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-[14px] transition-colors hover:bg-[var(--color-elevate)]"
                style={{
                  color:
                    w.id === activeWorkspace.id
                      ? "var(--color-ink)"
                      : "var(--color-ink-2)",
                }}
              >
                {w.name}
                {w.id === activeWorkspace.id ? (
                  <span className="num text-[11.5px]" style={{ color: "var(--color-ink-3)" }}>
                    current
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
