/**
 * frame.tsx — the frame every settings section sits in.
 *
 * The app shell, the rail of sections, and a header that answers three things
 * before any control: which group this belongs to (so a person who arrived by
 * search knows where they are), what is decided here, and whether YOUR role can
 * change it. The last one matters most in settings: a viewer who fills a form
 * the API will refuse has been misled by the page, not by the API.
 *
 * The permission line is drawn the way the map draws a stop: an open station
 * (white, ink ring) when the section is yours to change, a closed one (hollow,
 * grey) when it is shown for reference. The words say it as well.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import type { SettingsContext } from "@/lib/settings-context";
import { mayChange, settingsGroupOf, settingsSection, type SettingsKey, type Who } from "@/lib/settings-map";
import { AppShell } from "@/components/harbor/app-shell";
import { SettingsRail } from "./rail";
import { StateMark } from "./parts";

const ROLE_NOUN: Record<string, string> = {
  owner: "an owner",
  admin: "an admin",
  analyst: "an analyst",
  viewer: "a viewer",
  portal: "a portal contact",
};

function whoLine(who: Who, role: string | null): { lead: string; rest: string; can: boolean | null } | null {
  if (who === "anyone") return null;
  if (role === null) {
    return {
      lead: "Your role here could not be read,",
      rest: "so the controls are shown and the API decides when you use them.",
      can: null,
    };
  }
  const can = mayChange(role, who);
  const noun = ROLE_NOUN[role] ?? `"${role}"`;
  if (who === "owner") {
    return can
      ? { lead: "Only an owner", rest: "can change this, and you are one.", can }
      : { lead: "Only the workspace owner", rest: `can change this. You are ${noun}, so it is shown for reference.`, can };
  }
  return can
    ? { lead: "Owners and admins", rest: `can change this. You are ${noun}.`, can }
    : { lead: "Owners and admins", rest: `can change this. You are ${noun}, so it is read-only for you.`, can };
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
      <div className="grid gap-x-12 gap-y-6 lg:grid-cols-[212px_minmax(0,1fr)] xl:gap-x-16">
        <SettingsRail current={section} currentLabel={meta.label} />
        <div className="flex min-w-0 max-w-[1040px] flex-col gap-12">
          <header className="flex flex-col gap-2.5">
            <p className="text-meta text-fg-3">
              <Link href="/settings" className="font-semibold text-fg-2 hover:text-fg hover:underline">
                Settings
              </Link>
              <span aria-hidden className="px-1.5 text-fg-4">
                /
              </span>
              {group.title}
            </p>
            <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
              <div className="min-w-[min(100%,26rem)] flex-1">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <h1 className="display text-h1 text-fg [text-wrap:balance]">{meta.label}</h1>
                  {status}
                </div>
                <p className="mt-2 max-w-[68ch] text-body text-fg-2">{lede ?? meta.does}</p>
              </div>
              {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
            </div>
            {line ? (
              <p
                data-testid="settings-who"
                data-can-change={line.can === null ? "unknown" : String(line.can)}
                className="flex max-w-[72ch] items-baseline gap-2 text-ui text-fg-2"
              >
                <span className="relative top-[1px] self-start pt-[3px]">
                  <StateMark shape={line.can === false ? "closed" : "open"} tone="ink" size={11} />
                </span>
                <span>
                  <span className="font-semibold text-fg">{line.lead}</span> {line.rest}
                </span>
              </p>
            ) : null}
          </header>
          {children}
        </div>
      </div>
    </AppShell>
  );
}
