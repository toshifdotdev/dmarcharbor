import type { Metadata } from "next";
import { settingsContext } from "@/lib/settings-context";
import { AppShell } from "@/components/harbor/app-shell";
import { PageHeader } from "@/components/harbor/page-header";
import { SettingsDirectory } from "@/components/harbor/settings/directory";

export const metadata: Metadata = { title: "Settings" };

const ROLE_SENTENCE: Record<string, string> = {
  owner: "You are an owner of this workspace, so every section here is yours to change.",
  admin: "You are an admin here: you can change everything except billing, issuing API keys, erasure and deleting the workspace, which are the owner's.",
  analyst: "You are an analyst here. Most sections are read-only for you; your own devices, the audit trail and data export are not.",
  viewer: "You are a viewer here. Most sections are read-only for you; your own devices, the audit trail and data export are not.",
};

/**
 * /settings — a directory, not a wall of forms.
 *
 * Fifteen sections in four groups named for the job, with a search over the
 * phrases people actually use. Each entry carries who can change it, so the
 * person knows before opening a section whether it is theirs to change.
 */
export default async function SettingsIndex() {
  const ctx = await settingsContext();
  return (
    <AppShell workspaces={ctx.workspaces} activeWorkspace={ctx.active} trail={[{ label: "Settings" }]}>
      <div className="flex max-w-[1180px] flex-col gap-8">
        <PageHeader
          title="Settings"
          lede={
            ctx.role
              ? (ROLE_SENTENCE[ctx.role] ?? "Each section says who can change it.")
              : "Your role here could not be read just now. Each section still says who can change it, and the API decides."
          }
        />
        <SettingsDirectory role={ctx.role} />
      </div>
    </AppShell>
  );
}
