import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { listClients } from "@/lib/api";
import { getWorkspaceEntitlements } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import type { ClientRow } from "@/lib/types";
import { AppShell } from "@/components/harbor/app-shell";
import { ClientBook, type ClientView } from "@/components/harbor/client-book";
import { PageHeader } from "@/components/harbor/page-header";
import { RefreshButton } from "@/components/harbor/refresh-button";
import { ErrorState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Clients" };

function dateLabel(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * /clients — the client book: every company this workspace looks after, the
 * domains each one owns, and where each domain stands in setup.
 *
 * What an operator does here, in the order they do it: find a client (the
 * filter), see which of its domains still need DNS work (ownership state per
 * domain, the policy last seen in DNS), add a client or its domains (one, or a
 * pasted list with the ownership records handed back ready to send), and,
 * rarely, remove a client who has left.
 *
 * Posture and report volume live on the Portfolio; this screen is about the
 * structure and the setup work, so it does not repeat measurements.
 *
 * Three states, never two: a failed read is never "no clients yet".
 */
export default async function ClientsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  const [entitlements, clients] = await Promise.all([
    getWorkspaceEntitlements(active.id).catch(() => null),
    listClients(active.id).catch(() => null as ClientRow[] | null),
  ]);

  const views: ClientView[] = (clients ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    trustSlug: c.trustSlug ?? null,
    domains: c.domains.map((d) => ({
      id: d.id,
      slug: d.slug,
      name: d.name,
      status: d.status,
      policy: d.dmarcPolicy,
      addedLabel: dateLabel(d.createdAt),
      scannedLabel: dateLabel(d.lastScanAt),
    })),
  }));

  const domainCount = views.reduce((n, c) => n + c.domains.length, 0);
  const verified = views.reduce((n, c) => n + c.domains.filter((d) => d.status === "VERIFIED").length, 0);
  const waiting = domainCount - verified;

  return (
    <AppShell workspaces={workspaces} activeWorkspace={active} trail={[{ label: "Clients" }]}>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Clients"
          lede={
            clients === null
              ? "The companies whose domains this workspace looks after."
              : clients.length === 0
                ? "The companies whose domains this workspace looks after. Add the first one, then its domains."
                : `${clients.length} client${clients.length === 1 ? "" : "s"}, ${domainCount} domain${domainCount === 1 ? "" : "s"}. ${
                    waiting === 0
                      ? "Every domain has its ownership verified."
                      : `${waiting} still need${waiting === 1 ? "s" : ""} the ownership record published.`
                  }`
          }
          actions={<RefreshButton />}
        />
        {clients === null ? (
          <ErrorState what="the client list" detail="This is a connection or API problem, not an empty workspace." />
        ) : (
          <ClientBook
            organizationId={active.id}
            clients={views}
            limits={
              entitlements
                ? { plan: entitlements.label, maxClients: entitlements.maxClients, maxActiveDomains: entitlements.maxActiveDomains }
                : null
            }
          />
        )}
      </div>
    </AppShell>
  );
}
