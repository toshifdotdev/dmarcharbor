import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { listClients } from "@/lib/api";
import { resolveActiveWorkspace } from "@/lib/session";
import type { ClientRow } from "@/lib/types";
import { AppShell } from "@/components/harbor/app-shell";
import { PageHeader } from "@/components/harbor/page-header";
import { SwitchKit } from "@/components/harbor/switch-kit";
import { EmptyState, ErrorState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Switch provider" };

/**
 * /clients/switch — take a client's domains off another DMARC provider.
 *
 * The picker arrives from a client row (`?client=<id>`), so "switch this
 * client's domains" is one click from the client book rather than a client
 * chosen again on the next screen.
 */
export default async function SwitchProviderPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  const [{ client: wantedClient }, clients] = await Promise.all([
    searchParams,
    listClients(active.id).catch(() => null as ClientRow[] | null),
  ]);

  const choices = (clients ?? []).map((client) => ({
    id: client.id,
    name: client.name,
    reportAddress: client.reportAddress,
  }));
  const initialClientId = choices.find((client) => client.id === wantedClient)?.id ?? choices[0]?.id ?? null;

  return (
    <AppShell
      workspaces={workspaces}
      activeWorkspace={active}
      trail={[{ label: "Clients", href: "/clients" }, { label: "Switch provider" }]}
    >
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Switch domains from another provider"
          lede="Add our report address alongside the provider you are leaving, check that reports arrive from each receiver, then cut over. Nothing in DNS changes from this screen."
        />
        {clients === null ? (
          <ErrorState
            what="the client list"
            detail="This is a connection or API problem, not an empty workspace. Nothing was changed."
          />
        ) : clients.length === 0 ? (
          <EmptyState
            title="No clients yet"
            description="Domains live inside a client. Add the client first, then its domains."
            action={{ label: "Go to clients", href: "/clients" }}
          />
        ) : (
          <SwitchKit organizationId={active.id} clients={choices} initialClientId={initialClientId} />
        )}
      </div>
    </AppShell>
  );
}
