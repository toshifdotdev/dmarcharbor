import type { Metadata } from "next";
import { listClients } from "@/lib/api";
import { AUDIT_LIMIT_MAX, listAuditEvents } from "@/lib/api-ops";
import { AUDIT_ACTIONS, auditActionLabel, buildAuditTimeline, isAuditAction } from "@/lib/audit-display";
import { settingsContext } from "@/lib/settings-context";
import { AuditTrail } from "@/components/harbor/settings/audit";
import { SettingsFrame } from "@/components/harbor/settings/frame";
import { ErrorState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Audit trail" };

/**
 * /settings/audit?action=&domain=&withinHours= — readable by every role
 * (report:read). The timeline is built here with one instant, so its relative
 * times are the same strings in the server HTML and after hydration.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; domain?: string; withinHours?: string }>;
}) {
  const ctx = await settingsContext();
  const sp = await searchParams;
  const rawAction = sp.action?.trim() ?? "";
  const action = rawAction && isAuditAction(rawAction) ? rawAction : "";
  const domain = sp.domain?.trim() ?? "";
  const hours = Number(sp.withinHours);
  const withinHours = Number.isInteger(hours) && hours > 0 ? Math.min(hours, 8760) : 0;

  const [events, clients] = await Promise.all([
    listAuditEvents(ctx.active.id, {
      ...(action ? { action } : {}),
      ...(domain ? { domainId: domain } : {}),
      ...(withinHours ? { withinHours } : {}),
      limit: AUDIT_LIMIT_MAX,
    }).catch(() => null),
    listClients(ctx.active.id).catch(() => null),
  ]);

  const domainOptions = new Map<string, string>();
  for (const c of clients ?? []) for (const d of c.domains) domainOptions.set(d.id, d.name);
  for (const e of events?.items ?? []) if (e.domain) domainOptions.set(e.domain.id, e.domain.name);

  return (
    <SettingsFrame
      ctx={ctx}
      section="audit"
      lede="Every change in this workspace, who made it, and every attempt that was refused. The place to answer “who did this?” before anyone has to guess."
    >
      {events === null ? (
        <ErrorState what="the audit trail" detail="This is not the same as nothing having happened. Retry to read it." />
      ) : (
        <AuditTrail
          timeline={buildAuditTimeline(events.items, new Date())}
          actions={AUDIT_ACTIONS.map((a) => ({ value: a, label: auditActionLabel(a) }))}
          domains={[...domainOptions.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))}
          selected={{ action, domain, withinHours }}
          capped={events.items.length >= AUDIT_LIMIT_MAX}
          limit={AUDIT_LIMIT_MAX}
          ignoredAction={rawAction && !action ? rawAction : null}
        />
      )}
    </SettingsFrame>
  );
}
