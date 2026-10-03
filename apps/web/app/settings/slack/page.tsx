import { getSlackDestination } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { SlackForm } from "@/components/slack-client";

export default async function SlackSettingsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) return null;

  const destination = await getSlackDestination(active.id).catch(() => null);

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings · Slack alerts</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            The alerts your rules raise, delivered into a Slack channel. Same
            notifications, no new plan: this is about where the team watches,
            not what the product measures.
          </p>
        </header>
        <SettingsNav current="slack" />
        <SlackForm organizationId={active.id} destination={destination} />
      </div>
    </Shell>
  );
}
