import type { Metadata } from "next";
import { getOnboardingState, listClients } from "@/lib/api";
import { getWorkspaceEntitlements, listDomainForensics, OpsError } from "@/lib/api-ops";
import { featureOf } from "@/lib/entitlements";
import { instantLabel } from "@/lib/instant";
import { settingsContext } from "@/lib/settings-context";
import { PlanUnknown } from "@/components/harbor/plan-refusal";
import { ForensicsBoard, type DomainChoice, type SampleView } from "@/components/harbor/settings/forensics";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { EmptyState, ErrorState, PermissionState, UpgradeNotice } from "@/components/ui/states";

export const metadata: Metadata = { title: "Forensic reports" };

/**
 * /settings/forensics?domain=&cursor= — reports.forensic gates the section;
 * reports.forensicNamed gates only the names control, never the section.
 */
export default async function ForensicsPage({ searchParams }: { searchParams: Promise<{ domain?: string; cursor?: string }> }) {
  const ctx = await settingsContext();
  const sp = await searchParams;
  const [entitlements, clients] = await Promise.all([
    getWorkspaceEntitlements(ctx.active.id).catch(() => null),
    listClients(ctx.active.id).catch(() => null),
  ]);
  const forensic = featureOf(entitlements, "reports.forensic");
  const named = featureOf(entitlements, "reports.forensicNamed");

  const domains: DomainChoice[] = (clients ?? [])
    .flatMap((c) => c.domains.map((d) => ({ id: d.id, name: d.name, slug: d.slug, clientName: c.name })))
    .sort((a, b) => a.name.localeCompare(b.name));
  const domain = domains.find((d) => d.id === sp.domain) ?? domains[0] ?? null;

  const [listed, onboarding] =
    domain && forensic !== false
      ? await Promise.all([
          listDomainForensics(ctx.active.id, domain.id, { limit: 25, cursor: sp.cursor }).catch((e: unknown) =>
            e instanceof OpsError && e.status === 403 ? ("forbidden" as const) : e instanceof OpsError && e.status === 402 ? ("plan" as const) : null,
          ),
          getOnboardingState(ctx.active.id, domain.id).catch(() => null),
        ])
      : [null, null];

  const samples: SampleView[] | null =
    listed && typeof listed === "object"
      ? listed.items.map((f) => ({
          id: f.id,
          receivedLabel: instantLabel(f.receivedAt ?? f.arrivedAt),
          sourceIp: f.sourceIp,
          spf: f.spfResult,
          dkim: f.dkimResult,
          disposition: f.disposition,
          recipients: f.recipientCount,
          identity: f.piiWithheld ? "withheld" : f.piiAvailable ? "stored" : "pseudonymous",
        }))
      : null;

  const role = ctx.role;
  const unknown = role === null;
  return (
    <SettingsFrame
      ctx={ctx}
      section="forensics"
      who="admin"
      lede="Samples of individual messages that failed DMARC, sent by some receivers. Useful for finding who is sending as a domain; they can hold personal data, so collecting, naming and deleting them are decided here."
    >
      {entitlements === null ? <PlanUnknown what="forensic reporting" /> : null}
      {forensic === false || listed === "plan" ? (
        <UpgradeNotice
          message="Forensic reporting is not included in this workspace's plan."
          feature="reports.forensic"
          context="Aggregate reports, which cover every message without naming anyone, are on every plan."
        />
      ) : listed === "forbidden" ? (
        <PermissionState
          what="forensic samples"
          detail="Owners, admins and analysts can read them, because they can hold personal data about people outside your workspace."
          back={{ label: "All settings", href: "/settings" }}
        />
      ) : clients === null ? (
        <ErrorState what="the domain list" detail="Samples are per domain, so the page needs it." />
      ) : !domain ? (
        <EmptyState title="No domain yet" description="Forensic samples arrive per domain. Add a client and a domain first." action={{ label: "Add a client", href: "/clients" }} />
      ) : (
        <ForensicsBoard
          key={domain.id}
          organizationId={ctx.active.id}
          domains={domains}
          domain={domain}
          samples={samples}
          retention={listed && typeof listed === "object" ? { days: listed.retentionDays, piiDays: listed.piiRetentionDays } : null}
          paging={{
            nextCursor: listed && typeof listed === "object" ? listed.nextCursor : null,
            hasMore: listed && typeof listed === "object" ? listed.hasMore : false,
            onLaterPage: Boolean(sp.cursor),
          }}
          state={
            onboarding
              ? {
                  collecting: onboarding.reporting.collectionEnabled,
                  naming: onboarding.reporting.identityRetentionEnabled,
                  rufPublished: onboarding.reporting.forensicConfigured,
                  forensicAddress: onboarding.suggestedRecord.forensicAddress,
                }
              : null
          }
          canIdentify={unknown || role === "owner" || role === "admin"}
          canPurge={unknown || role === "owner" || role === "admin"}
          canCollect={unknown || role === "owner" || role === "admin" || role === "analyst"}
          namedEntitled={named}
        />
      )}
    </SettingsFrame>
  );
}
