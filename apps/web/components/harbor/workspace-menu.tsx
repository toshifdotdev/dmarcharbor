"use client";

/**
 * workspace-menu.tsx — the root of the location bar.
 *
 * The workspace is the first segment of "where am I", so it is drawn as the
 * first crumb, not as a separate widget: Harbor Dev Agency / Brisenhay Trading
 * / brisenhay-trading.example reads as one address. Switching writes the same
 * `harbor.workspace` cookie every screen reads, then re-renders in place.
 *
 * Many workspaces: the menu's type-ahead jumps by name, and Jump (Ctrl K)
 * searches workspaces by text for the agency with dozens.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { clsx } from "clsx";
import type { WorkspaceAllowance } from "@/lib/api";
import { opsCall } from "@/lib/ops-client";
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
  // Read when the menu first opens, never on every page: whether the plan
  // allows another workspace. Unknown (not read, or the read failed) offers
  // the form, whose page states the allowance and the API decides.
  const [allowance, setAllowance] = useState<WorkspaceAllowance | null>(null);
  const [asked, setAsked] = useState(false);
  const full = allowance !== null && !allowance.allowed;

  function onOpenChange(open: boolean) {
    if (!open || asked) return;
    setAsked(true);
    void opsCall<WorkspaceAllowance>("/api/workspaces/allowance").then((r) => {
      if (r.ok) setAllowance(r.data);
    });
  }

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
    <MenuRoot modal={false} onOpenChange={onOpenChange}>
      <MenuTrigger
        aria-label={`Workspace: ${active.name}. Switch workspace`}
        aria-busy={pending || undefined}
        className={clsx(
          "group flex h-9 min-w-0 items-center gap-1.5 rounded-full px-3 text-left hover:bg-paper-3 data-[state=open]:bg-paper-3",
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
        {/* The only way to reach the create form once a workspace exists. At
            the plan's allowance it says so, and leads to the plan options. */}
        <MenuItem
          onSelect={() => router.push(full ? "/billing" : "/welcome")}
          data-testid="new-workspace"
          data-quota={full ? "workspace" : undefined}
        >
          {full && allowance ? (
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-2 text-fg-3">
                <Plus size={13} /> New workspace
              </span>
              <span className="tnum text-meta text-fg-3">
                {allowance.used} of {allowance.maxWorkspaces} in use: see plan options
              </span>
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Plus size={13} /> New workspace
            </span>
          )}
        </MenuItem>
      </MenuContent>
    </MenuRoot>
  );
}
