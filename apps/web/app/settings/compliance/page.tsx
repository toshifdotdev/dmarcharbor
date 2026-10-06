import { redirect } from "next/navigation";
import Link from "next/link";
import { listClients } from "@/lib/api";
import { getWorkspaceEntitlements, trustCenterStatus } from "@/lib/api-ops";
import { listCompliancePacks as listPacksPhase7 } from "@/lib/api-phase7";
import { complianceHref } from "@/lib/route-hrefs";
import { requestOrigin } from "@/lib/metadata-origin";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { CompliancePackPanel } from "@/components/compliance-client";
import { TrustCenterPanel } from "@/components/trust-center-client";
import { ErrorState } from "@/components/data-states";
import type { TrustSlugStatus } from "@/lib/types";

/**
 * Compliance packs and the Trust Center, per client — the artefacts an MSP
 * sends and publishes. The Trust Center page and the /verify verifier already
 * exist; this is where they are issued from.
 *
 * Every identifier in a URL here follows the id-in-URL policy: route params
 * stay on the API's ids until the server-side slug lands, and nothing is
 * invented client-side.
 */
export default async function ComplianceSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  const { client: wantedClient } = await searchParams;
  // A failed client load must not read as "create a client first": the two are
  // different facts and only one of them is true at a time.
  const [clientsResult, entitlements] = await Promise.all([
    listClients(active.id)
      .then((rows) => ({ clients: rows, failed: false }))
      .catch(() => ({ clients: [], failed: true })),
    getWorkspaceEntitlements(active.id).catch(() => null),
  ]);
  const clients = clientsResult.clients;
  const clientsFailed = clientsResult.failed;

  const selected =
    clients.find((c) => c.id === wantedClient) ?? clients[0] ?? null;

  let packs: Awaited<ReturnType<typeof listPacksPhase7>> = { packs: [] };
  let packsFailed = false;
  if (selected) {
    const loaded = await listPacksPhase7(active.id, selected.id)
      .then((r) => ({ packs: r, failed: false }))
      .catch(() => ({ packs: { packs: [] } as Awaited<ReturnType<typeof listPacksPhase7>>, failed: true }));
    packs = loaded.packs;
    packsFailed = loaded.failed;
  }

  const allowCompliance = entitlements?.features["reports.compliancePack"] === true;
  const allowTrust = entitlements?.features["trust.center"] === true;
  const origin = await requestOrigin();

  // The Trust Center status is per client and read server-side: the panel is
  // publish/revoke state, not a description of it.
  let trustStatus: TrustSlugStatus = { url: null, slug: null };
  if (selected) {
    trustStatus = await trustCenterStatus(active.id, selected.id).catch(() => ({
      url: null,
      slug: null,
    }));
  }

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings · Compliance</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            The two artefacts a procurement team asks for: the signed
            compliance pack with its published fingerprint, and the public
            Trust Center an auditor opens with no account.
          </p>
        </header>
        <SettingsNav current="compliance" />

        {clientsFailed ? (
          <ErrorState
            what="the client list"
            detail="Packs are issued per client, so nothing can be issued or shown until this loads. This is a connection or API problem, not an empty workspace."
          />
        ) : clients.length === 0 ? (
          <p className="text-[13.5px]" style={{ color: "var(--color-ink-3)" }}>
            Create a client first: packs are issued per client.{" "}
            <Link href="/clients" className="underline" style={{ color: "var(--color-ink)" }}>
              Open clients
            </Link>
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="label">Client</span>
              {clients.map((c) => (
                <Link
                  key={c.id}
                  href={complianceHref(c.id)}
                  className="rounded-[2px] border px-3 py-1.5 text-[12px] font-medium"
                  style={{
                    borderColor: c.id === selected?.id ? "var(--color-accent)" : "var(--color-line-strong)",
                    background: c.id === selected?.id ? "var(--color-accent-soft)" : "transparent",
                    color: c.id === selected?.id ? "var(--color-ink)" : "var(--color-ink-3)",
                  }}
                >
                  {c.name}
                </Link>
              ))}
            </div>

            {selected ? (
              packsFailed ? (
                <ErrorState
                  what={`the compliance packs for ${selected.name}`}
                  detail="The issued packs could not be listed. An empty list here would read as none issued, which is a different claim entirely."
                />
              ) : allowCompliance ? (
                <CompliancePackPanel
                  organizationId={active.id}
                  clientId={selected.id}
                  clientName={selected.name}
                  packs={packs.packs ?? []}
                />
              ) : (
                <section
                  className="lift rounded-[2px] border p-5"
                  style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
                  data-feature="reports.compliancePack"
                >
                  <h2 className="text-[16px] font-semibold tracking-[-0.012em]">Compliance packs</h2>
                  <p className="mt-2 text-[13.5px]" style={{ color: "var(--color-ink-2)" }}>
                    Compliance pack issuance is not included in your current plan.
                  </p>
                  <Link
                    href="/billing"
                    className="mt-2 inline-block text-[13px] font-semibold underline"
                    style={{ color: "var(--color-ink)" }}
                  >
                    See plan options
                  </Link>
                </section>
              )
            ) : null}

            {selected && allowTrust ? (
              <TrustCenterPanel
                organizationId={active.id}
                clientId={selected.id}
                clientName={selected.name}
                initial={trustStatus}
                origin={origin}
              />
            ) : selected ? (
              <section
                className="lift rounded-[2px] border p-5"
                style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
                data-feature="trust.center"
              >
                <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
                  Trust Center: {selected.name}
                </h2>
                <p className="mt-2 text-[13.5px]" style={{ color: "var(--color-ink-2)" }}>
                  The public Trust Center is not included in your current plan.
                </p>
                <Link
                  href="/billing"
                  className="mt-2 inline-block text-[13px] font-semibold underline"
                  style={{ color: "var(--color-ink)" }}
                >
                  See plan options
                </Link>
              </section>
            ) : null}
          </>
        )}
      </div>
    </Shell>
  );
}
