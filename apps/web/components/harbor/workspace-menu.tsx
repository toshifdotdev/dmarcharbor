"use client";

/**
 * workspace-menu.tsx — the root of the location bar.
 *
 * The workspace is the first segment of "where am I", so it is drawn as the
 * first crumb, not as a separate widget: Harbor Dev Agency / Northwind Trading
 * / northwind-trading.test reads as one address. Switching writes the same
 * `harbor.workspace` cookie every screen reads, then re-renders in place.
 *
 * Many workspaces: the menu's type-ahead jumps by name, and Jump (Ctrl K)
 * searches workspaces by text for the agency with dozens.
 */

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { clsx } from "clsx";
import type { WorkspaceSummary } from "@/lib/types";
import { ChevronDown, Plus } from "@/components/ui/icons";
import {
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";

export function switchWorkspace(id: string) {
  document.cookie = `harbor.workspace=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax`;
}

export function WorkspaceMenu({
  workspaces,
  active,
  compact,
}: {
  workspaces: WorkspaceSummary[];
  active: WorkspaceSummary;
  compact?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function choose(id: string) {
    if (id === active.id) return;
    switchWorkspace(id);
    // A workspace change invalidates every id in the URL below the root, so
    // the portfolio is the only honest destination.
    start(() => {
      router.push("/");
      router.refresh();
    });
  }

  return (
    <MenuRoot modal={false}>
      <MenuTrigger
        aria-label={`Workspace: ${active.name}. Switch workspace`}
        aria-busy={pending || undefined}
        className={clsx(
          "group flex h-8 min-w-0 items-center gap-1.5 rounded-ctl px-2 text-left hover:bg-paper-3 data-[state=open]:bg-paper-3",
          pending && "opacity-60",
        )}
      >
        <span className={clsx("truncate text-ui font-semibold text-fg", compact ? "max-w-[30vw]" : "max-w-[260px]")}>
          {active.name}
        </span>
        <ChevronDown size={13} className="shrink-0 text-fg-3 transition-transform group-data-[state=open]:rotate-180" />
      </MenuTrigger>
      <MenuContent align="start" className="w-[300px]">
        <MenuLabel>
          {workspaces.length} workspace{workspaces.length === 1 ? "" : "s"} on this account
        </MenuLabel>
        <div className="max-h-[50vh] overflow-y-auto">
          <MenuRadioGroup value={active.id} onValueChange={choose}>
            {workspaces.map((w) => (
              <MenuRadioItem key={w.id} value={w.id} textValue={w.name}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{w.name}</span>
                  <span className="data block truncate text-meta text-fg-3">{w.slug}</span>
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </div>
        <MenuSeparator />
        <MenuItem onSelect={() => router.push("/settings/workspace")}>Workspace settings</MenuItem>
        {/* The only way to reach the create form once a workspace exists. */}
        <MenuItem onSelect={() => router.push("/welcome")} data-testid="new-workspace">
          <span className="flex items-center gap-2">
            <Plus size={13} /> New workspace
          </span>
        </MenuItem>
      </MenuContent>
    </MenuRoot>
  );
}
