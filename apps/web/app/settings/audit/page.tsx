import { Suspense } from "react";
import { redirect } from "next/navigation";
import { listAuditEvents, AUDIT_LIMIT_MAX, AUDIT_LIMIT_MIN } from "@/lib/api-ops";
import { listClients } from "@/lib/api";
import { buildAuditTimeline, isAuditAction } from "@/lib/audit-display";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { SettingsNav } from "@/components/settings-nav";
import { AuditTrail } from "@/components/audit-client";
import { LoadingState } from "@/components/data-states";
import type { AuditDomainOption } from "@/components/audit-client";

/**
 * The audit trail. Read only, and this page is where that is enforced.
 *
 * There is no write route for an audit row: PATCH and DELETE on this path both
 * answer 404, asserted in the API's operations suite. That is the product
 * working. An audit trail an operator can edit is a log of what they chose to
 * write down, and the whole value of the surface is that nobody, including us,
 * can change a row after the fact. So there is no action on this page, and
 * adding one would mean changing the API first.
 *
 * THE THREE STATES, NEVER TWO
 *
 *   loading  the Tide, behind the Suspense boundary below. A 2 to 11 second
 *            call on this machine must not read as a broken page.
 *   empty    the API answered and there is nothing. Distinct from the next one,
 *            and from the fact that a brand new workspace writes a DPA_ACCEPTED
 *            row on creation, so a truly empty trail is unusual.
 *   failed   the API did not answer. This is the one that costs someone an
 *            afternoon if it is rendered as "nothing happened here": an empty
 *            trail is a claim, and only a successful read may make it.
 *
 * NO ENTITLEMENT GATE. The route carries requireSession and
 * requireOrganizationPermission('report', 'read') and nothing else. `audit.trail`
 * is in alwaysOnEntitlements (plan-catalog.ts), so there is no gate to mirror
 * and inventing one would hide the trail from workspaces the API would serve.
 *
 * THE FILTERS ARE THE API'S, NOT OURS
 *
 * `action` and `domainId` are the two the service applies, so both are forwarded
 * and both narrow what the database was asked. The action value is checked
 * against the real enum first: listAuditEvents casts the raw string into the
 * Prisma enum without validating, so a hand-edited URL would otherwise be a
 * database error and a 500 rather than an ignored filter. An unrecognised value
 * is dropped, and the page says it dropped it.
 */
export default async function AuditSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; domain?: string; limit?: string }>;
}) {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  const { action, domain, limit } = await searchParams;

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Settings · Audit trail</h1>
          <p className="mt-1.5 max-w-3xl text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            Every sensitive action in this workspace, who took it and whether it
            was allowed. The record is append only: there is no route that edits
            or deletes a row, so nobody, including us, can change it afterwards.
          </p>
        </header>
        <SettingsNav current="audit" />

        <Suspense fallback={<LoadingState label="Loading the audit trail" />}>
          <AuditTrailSection
            organizationId={active.id}
            wantedAction={action}
            wantedDomain={domain}
            wantedLimit={limit}
          />
        </Suspense>
      </div>
    </Shell>
  );
}

async function AuditTrailSection({
  organizationId,
  wantedAction,
  wantedDomain,
  wantedLimit,
}: {
  organizationId: string;
  wantedAction: string | undefined;
  wantedDomain: string | undefined;
  wantedLimit: string | undefined;
}) {
  const action = wantedAction && isAuditAction(wantedAction) ? wantedAction : undefined;
  const ignoredAction = wantedAction && !action ? wantedAction : null;
  const domain = wantedDomain && wantedDomain.length > 0 ? wantedDomain : undefined;

  // The service clamps this itself; clamping here as well keeps a hand-edited
  // URL from turning into a request the API answers with a 400.
  const requested = Number(wantedLimit);
  const limit =
    wantedLimit !== undefined && Number.isInteger(requested)
      ? Math.min(Math.max(requested, AUDIT_LIMIT_MIN), AUDIT_LIMIT_MAX)
      : AUDIT_LIMIT_MAX;

  const [events, clients] = await Promise.all([
    listAuditEvents(organizationId, { domainId: domain, action, limit }).then(
      (r) => ({ rows: r.items ?? [], failed: false }),
      () => ({ rows: [] as Awaited<ReturnType<typeof listAuditEvents>>["items"], failed: true }),
    ),
    // Only here to fill the domain filter. A failure costs the filter its
    // options, not the trail, so the two are tracked separately.
    listClients(organizationId).then(
      (rows) => ({ rows, failed: false }),
      () => ({ rows: [], failed: true }),
    ),
  ]);

  /**
   * Two sources for the domain filter, unioned.
   *
   * The client list is the workspace as it is now; the loaded events are the
   * domains the trail actually names. A domain deleted after the fact keeps its
   * rows (the relation is SetNull, so the row survives with no domain) and the
   * current client list no longer offers it, which would leave a filter pointed
   * at something the select cannot show.
   */
  const domains: AuditDomainOption[] = [];
  const seen = new Set<string>();
  for (const client of clients.rows) {
    for (const item of client.domains) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      domains.push({ id: item.id, name: item.name });
    }
  }
  for (const event of events.rows) {
    if (!event.domain || seen.has(event.domain.id)) continue;
    seen.add(event.domain.id);
    domains.push({ id: event.domain.id, name: event.domain.name });
  }
  domains.sort((a, b) => a.name.localeCompare(b.name));

  return (
    <AuditTrail
      // One instant for the whole page, so every "4 minutes ago" on it agrees.
      timeline={buildAuditTimeline(events.rows, new Date())}
      domains={domains}
      domainsIncomplete={clients.failed}
      loadFailed={events.failed}
      ignoredAction={ignoredAction}
      // There is no cursor behind this (the route parses one and never passes
      // it on), so a full window means the API has more and no way to reach it.
      capped={!events.failed && events.rows.length >= limit}
      selectedAction={action ?? ""}
      selectedDomain={domain ?? ""}
      selectedLimit={limit}
    />
  );
}
