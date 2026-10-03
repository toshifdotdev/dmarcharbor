import Link from "next/link";
import { listClients } from "@/lib/api";
import { getWorkspaceEntitlements } from "@/lib/api-ops";
import { listCompliancePacks as listPacksPhase7 } from "@/lib/api-phase7";
import { complianceHref } from "@/lib/route-hrefs";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { CompliancePackPanel } from "@/components/compliance-client";

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
  if (!active) return null;

  const { client: wantedClient } = await searchParams;
  const [clients, entitlements] = await Promise.all([
    listClients(active.id).catch(() => []),
    getWorkspaceEntitlements(active.id).catch(() => null),
  ]);

  const selected =
    clients.find((c) => c.id === wantedClient) ?? clients[0] ?? null;

  let packs: Awaited<ReturnType<typeof listPacksPhase7>> = { packs: [] };
  if (selected) {
    packs = await listPacksPhase7(active.id, selected.id).catch(() => ({ packs: [] }));
  }

  const allowCompliance = entitlements?.features["reports.compliancePack"] === true;
  const allowTrust = entitlements?.features["trust.center"] === true;

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

        {clients.length === 0 ? (
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
              allowCompliance ? (
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

            <section
              className="lift rounded-[2px] border p-5"
              style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
              data-feature="trust.center"
            >
              <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
                Trust Center{selected ? `: ${selected.name}` : ""}
              </h2>
              {allowTrust ? (
                <p className="mt-2 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                  The Trust Center is published per client from the client
                  workspace. Issuing a link gives {selected?.name} an
                  unguessable public address an auditor opens with no account:
                  withdrawing the link takes the page down immediately.
                </p>
              ) : (
                <>
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
                </>
              )}
            </section>
          </>
        )}
      </div>
    </Shell>
  );
}
