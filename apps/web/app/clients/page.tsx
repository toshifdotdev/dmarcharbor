import Link from "next/link";
import { listClients } from "@/lib/api";
import { getWorkspaceEntitlements } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { UpgradePrompt } from "@/components/upgrade-gate";
import { AddDomainForm, CreateClientForm } from "@/components/clients-client";

/**
 * Clients — the top of the workspace → client → domain hierarchy. The data
 * model is the product; this screen builds it. Every domain here links
 * straight into its setup, because a domain nobody can onboard is a domain
 * that never measures anything.
 */
export default async function ClientsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) return null;

  const entitlements = await getWorkspaceEntitlements(active.id).catch(() => null);
  const clients = await listClients(active.id).catch(() => []);

  // A 402 on the create path arrives as a feature-keyed error from the API;
  // when the plan has no client quota the form surfaces it on submit. This
  // pre-check only sets the honest context line above the form.
  const atClientLimit =
    entitlements !== null && clients.length >= entitlements.maxClients;

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Clients</h1>
          <p className="mt-1.5 text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            Every company you monitor, with its domains and where each one
            stands. Create a client first — domains live inside it.
          </p>
        </header>

        {atClientLimit ? (
          <UpgradePrompt
            error={{
              feature: "client",
              message: `This plan covers ${entitlements.maxClients} client${entitlements.maxClients === 1 ? "" : "s"}, and this workspace has ${clients.length}.`,
            }}
            context="The client list is at its plan limit. Plan options show what each step up carries."
          />
        ) : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <CreateClientForm organizationId={active.id} />

          <section
            className="lift rounded-[2px] border"
            style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
          >
            <header className="border-b px-5 py-3.5" style={{ borderColor: "var(--color-line)" }}>
              <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
                Your clients ({clients.length})
              </h2>
            </header>
            {clients.length === 0 ? (
              <p className="px-5 py-10 text-center text-[13.5px]" style={{ color: "var(--color-ink-3)" }}>
                No clients yet. Create the first one to start adding domains.
              </p>
            ) : (
              <ul>
                {clients.map((c) => (
                  <li
                    key={c.id}
                    className="border-b px-5 py-3.5"
                    style={{ borderColor: "rgba(255,255,255,0.055)" }}
                  >
                    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                      <span className="text-[14px] font-semibold" style={{ color: "var(--color-ink)" }}>
                        {c.name}
                      </span>
                      <span className="num text-[11px]" style={{ color: "var(--color-ink-3)" }}>
                        {c.slug}
                      </span>
                      <span
                        className="num ml-auto text-[10.5px] tracking-[0.12em] uppercase"
                        style={{ color: "var(--color-ink-3)" }}
                      >
                        {c.domains.length} domain{c.domains.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    {c.domains.length > 0 ? (
                      <ul className="mt-2 flex flex-wrap gap-1.5">
                        {c.domains.map((d) => (
                          <li key={d.id}>
                            <Link
                              href={`/onboarding/${d.id}`}
                              className="num inline-block rounded-[2px] border px-2.5 py-1 text-[11.5px]"
                              style={{
                                borderColor: "var(--color-line-strong)",
                                color:
                                  d.status === "VERIFIED" ? "var(--color-ink-2)" : "var(--color-unverified)",
                              }}
                            >
                              {d.name}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-[12px]" style={{ color: "var(--color-ink-3)" }}>
                        no domains yet
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {clients.length > 0 ? (
          <AddDomainForm
            organizationId={active.id}
            clientId={clients[clients.length - 1].id}
            clientName={clients[clients.length - 1].name}
          />
        ) : null}
      </div>
    </Shell>
  );
}
