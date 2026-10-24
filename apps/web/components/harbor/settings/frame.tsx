/**
 * frame.tsx — the frame every settings section sits in.
 *
 * The app shell, the grouped rail, and a header that answers three things
 * before any control: which group this belongs to (so a person who arrived by
 * search knows where they are), what is decided here, and whether YOUR role can
 * change it. The last one matters most in settings: a viewer who fills a form
 * the API will refuse has been misled by the page, not by the API.
 */

import type { ReactNode } from "react";
import type { SettingsContext } from "@/lib/settings-context";
import { mayChange, settingsGroupOf, settingsSection, type SettingsKey, type Who } from "@/lib/settings-map";
import { AppShell } from "@/components/harbor/app-shell";
import { SettingsRail } from "./rail";

const ROLE_NOUN: Record<string, string> = {
  owner: "an owner",
  admin: "an admin",
  analyst: "an analyst",
  viewer: "a viewer",
  portal: "a portal contact",
};

function whoLine(who: Who, role: string | null): { text: string; can: boolean | null } {
  if (who === "anyone") return { text: "", can: true };
  if (role === null) {
    return {
      text: "Your role here could not be read, so the controls are shown and the API decides when you use them.",
      can: null,
    };
  }
  const can = mayChange(role, who);
  const noun = ROLE_NOUN[role] ?? `"${role}"`;
  if (who === "owner") {
    return can
      ? { text: "Only an owner can change this, and you are one.", can }
      : { text: `Only the workspace owner can change this. You are ${noun}, so it is shown for reference.`, can };
  }
  return can
    ? { text: `Owners and admins can change this. You are ${noun}.`, can }
    : { text: `Owners and admins can change this. You are ${noun}, so it is read-only for you.`, can };
}

export function SettingsFrame({
  ctx,
  section,
  lede,
  who,
  status,
  actions,
  children,
}: {
  ctx: SettingsContext;
  section: SettingsKey;
  /** Overrides the one-line decision from the map when a page needs more. */
  lede?: ReactNode;
  /** Overrides the map's permission when the page states its own. */
  who?: Who;
  status?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const meta = settingsSection(section);
  const group = settingsGroupOf(section);
  const line = whoLine(who ?? meta.who, ctx.role);
  return (
    <AppShell
      workspaces={ctx.workspaces}
      activeWorkspace={ctx.active}
      trail={[{ label: "Settings", href: "/settings" }, { label: meta.label }]}
    >
      <div className="grid gap-x-12 gap-y-5 lg:grid-cols-[216px_minmax(0,1fr)]">
        <SettingsRail current={section} currentLabel={meta.label} />
        <div className="flex min-w-0 max-w-[1040px] flex-col gap-8">
          <header className="flex flex-col gap-2 [animation:hb-rise_200ms_ease-out]">
            <p className="legend">{group.title}</p>
            <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
              <div className="min-w-[min(100%,26rem)] flex-1">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <h1 className="wide text-h1 font-bold tracking-[-0.02em] text-fg">{meta.label}</h1>
                  {status}
                </div>
                <p className="mt-1.5 max-w-[72ch] text-body text-fg-2">{lede ?? meta.does}</p>
                {line.text ? (
                  <p
                    data-testid="settings-who"
                    data-can-change={line.can === null ? "unknown" : String(line.can)}
                    className="mt-2 flex items-baseline gap-2 text-meta text-fg-3"
                  >
                    <span
                      aria-hidden
                      className={line.can === false ? "size-2 shrink-0 rounded-full border-2 border-fg-4" : "size-2 shrink-0 rounded-full bg-act"}
                    />
                    {line.text}
                  </p>
                ) : null}
              </div>
              {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
            </div>
          </header>
          {children}
        </div>
      </div>
    </AppShell>
  );
}
