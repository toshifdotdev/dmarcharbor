import type { Metadata } from "next";
import { listClients } from "@/lib/api";
import { getWorkspaceEntitlements, trustCenterStatus } from "@/lib/api-ops";
import { listCompliancePacks } from "@/lib/api-phase7";
import { featureOf } from "@/lib/entitlements";
import { instantLabel } from "@/lib/instant";
import { requestOrigin } from "@/lib/metadata-origin";
import { settingsContext } from "@/lib/settings-context";
import { mayChange } from "@/lib/settings-map";
import { PlanUnknown } from "@/components/harbor/plan-refusal";
import { ComplianceBoard, CompliancePicker, type PackView } from "@/components/harbor/settings/compliance";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { EmptyState, ErrorState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Trust Center and evidence packs" };

/** /settings/compliance?client=<id> — one client at a time. */
export default async function CompliancePage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const ctx = await settingsContext();
  const { client: wanted } = await searchParams;
  const [clients, entitlements, origin] = await Promise.all([
    listClients(ctx.active.id).catch(() => null),
    getWorkspaceEntitlements(ctx.active.id).catch(() => null),
    requestOrigin(),
  ]);
  const selected = clients?.find((c) => c.id === wanted) ?? clients?.[0] ?? null;

  const [packs, trust] = selected
    ? await Promise.all([
        listCompliancePacks(ctx.active.id, selected.id).catch(() => null),
        trustCenterStatus(ctx.active.id, selected.id).catch(() => null),
      ])
    : [null, null];

  const packViews: PackView[] | null = packs
    ? packs.packs.map((p) => ({
        id: p.id,
        reference: p.reference,
        hash: p.hash,
        issuedLabel: instantLabel(p.issuedAt),
        asOfLabel: instantLabel(p.asOf),
        superseded: p.superseded,
      }))
    : null;
  const trustUrl = trust?.url ? (trust.url.startsWith("http") ? trust.url : `${origin}${trust.url}`) : null;

  return (
    <SettingsFrame
      ctx={ctx}
      section="compliance"
      lede="What you give a client's auditor or insurer: a public page about how their data is held, and a fingerprinted PDF of their DMARC evidence that anyone can check."
      actions={clients && clients.length > 1 && selected ? <CompliancePicker clients={clients.map((c) => ({ id: c.id, name: c.name }))} selected={selected.id} /> : null}
    >
      {entitlements === null ? <PlanUnknown what="the Trust Center and compliance packs" /> : null}
      {clients === null ? (
        <ErrorState what="the client list" detail="Packs and Trust Centers are per client, so the page needs it." />
      ) : !selected ? (
        <EmptyState
          title="No client yet"
          description="Trust Centers and evidence packs are issued per client. Add a client and its domains first."
          action={{ label: "Add a client", href: "/clients" }}
        />
      ) : (
        <ComplianceBoard
          key={selected.id}
          organizationId={ctx.active.id}
          clientId={selected.id}
          clientName={selected.name}
          packs={packViews}
          trustUrl={trustUrl}
          packFeature={featureOf(entitlements, "reports.compliancePack")}
          trustFeature={featureOf(entitlements, "trust.center")}
          canManage={ctx.role === null ? true : mayChange(ctx.role, "admin")}
        />
      )}
    </SettingsFrame>
  );
}
