import { listAlertEvents, listAlertRules, getWorkspaceEntitlements, listWorkspaceMembers } from "@/lib/api-ops";
import { listClients } from "@/lib/api";
import { resolveActiveWorkspace } from "@/lib/session";
import type { AlertEventRow, WorkspaceMemberRow } from "@/lib/types";
import { Shell } from "@/components/shell";
import { UpgradePrompt } from "@/components/upgrade-gate";
import { EmptyState, ErrorState } from "@/components/data-states";
import { AcknowledgeButton, AlertRuleActions, AlertRuleForm } from "@/components/alerts-client";

export default async function AlertsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) return null;

  let entitlements;
  try {
    entitlements = await getWorkspaceEntitlements(active.id);
  } catch {
    entitlements = null;
  }

  const alertingEnabled = entitlements?.features["alerts.email"] === true;
  const spoofingEnabled = entitlements?.features["alerts.spoofing"] === true;

  const [clients, rules, events] = await Promise.all([
    // Three states, never two: a failed load must never render as "no alerts
    // yet" — that is a lie that costs someone an afternoon.
    listClients(active.id).catch(() => null),
    listAlertRules(active.id).catch(() => null),
    listAlertEvents(active.id).catch(() => null),
  ]);
  const loadFailed = clients === null || rules === null || events === null;
  const clientRows = clients ?? [];
  const ruleRows = rules ? rules.items : [];
  const eventRows = events ? events.items : [];

  const domains = clientRows.flatMap((c) => c.domains.map((d) => ({ id: d.id, name: d.name })));

  const members = await fetchMembers(active.id);

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Alerts</h1>
          <p className="mt-1.5 text-[14.5px]" style={{ color: "var(--color-ink-2)" }}>
            Observed conditions worth waking someone for. An unacknowledged
            event escalates and rolls up to the workspace owner — the level is
            always shown.
          </p>
        </header>

        {!alertingEnabled ? (
          <UpgradePrompt
            error={{
              feature: "alerts.email",
              message: "Alerting is not included in the current plan.",
            }}
            context="Alert rules and alert events need a plan that includes alerting."
          />
        ) : (
          <>
            {!spoofingEnabled ? (
              <p
                className="num text-[13px] tracking-[0.1em] uppercase"
                style={{ color: "var(--color-ink-3)" }}
              >
                note · rules on new unauthenticated sources are not available on
                your current plan
              </p>
            ) : null}

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <AlertRuleForm
                organizationId={active.id}
                domains={domains}
                members={members}
              />

              <section
                className="lift rounded-[2px] border"
                style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
              >
                <header className="border-b px-5 py-3.5" style={{ borderColor: "var(--color-line)" }}>
                  <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">Rules</h2>
                </header>
                {loadFailed ? (
                  <div className="p-5">
                    <ErrorState what="the alert rules" detail="This is a connection or API problem, not an empty workspace." />
                  </div>
                ) : ruleRows.length === 0 ? (
                  <div className="p-5">
                    <EmptyState
                      title="No alert rules yet"
                      description="Rules watch a measured condition and wake someone when it crosses the line — a failed-message count, a report that stopped arriving, a source nobody recognised. Add the first rule on the left."
                    />
                  </div>
                ) : (
                  <ul>
                    {ruleRows.map((r) => (
                      <li
                        key={r.id}
                        className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5 border-b px-5 py-3"
                        style={{ borderColor: "rgba(255,255,255,0.055)" }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[14px]" style={{ color: "var(--color-ink)" }}>
                            {r.name}
                          </div>
                          <div className="num text-[12px]" style={{ color: "var(--color-ink-3)" }}>
                            {r.domain?.name} · {r.metric.replaceAll("_", " ").toLowerCase()}{" "}
                            {r.operator.replaceAll("_", " ").toLowerCase()} {r.threshold} · window{" "}
                            {r.windowMinutes}m · cooldown {r.cooldownMinutes}m
                          </div>
                        </div>
                        <span
                          className="num text-[11.5px] tracking-[0.12em] uppercase"
                          style={{ color: r.enabled ? "var(--color-pass)" : "var(--color-ink-3)" }}
                        >
                          {r.enabled ? "active" : "disabled"}
                        </span>
                        <AlertRuleActions organizationId={active.id} rule={r} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <section
              className="lift rounded-[2px] border"
              style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
            >
              <header className="border-b px-5 py-3.5" style={{ borderColor: "var(--color-line)" }}>
                <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">Events</h2>
              </header>
              {loadFailed ? (
                <div className="p-5">
                  <ErrorState what="the alert events" detail="This is a connection or API problem, not a quiet workspace." />
                </div>
              ) : eventRows.length === 0 ? (
                <div className="p-5">
                  <EmptyState
                    title="No alert events"
                    description="When a rule fires, the event appears here and escalates until it is acknowledged. Silence here is only meaningful once a rule exists — until then nothing is watching."
                  />
                </div>
              ) : (
                <ul>
                  {eventRows.map((e) => (
                    <EventRow key={e.id} organizationId={active.id} event={e} />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </Shell>
  );
}

function EventRow({
  organizationId,
  event,
}: {
  organizationId: string;
  event: AlertEventRow;
}) {
  const acknowledged = Boolean(event.acknowledgedAt);
  const resolved = Boolean(event.resolvedAt);
  return (
    <li
      className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b px-5 py-3"
      style={{
        borderColor: "rgba(255,255,255,0.055)",
        boxShadow: acknowledged || resolved ? undefined : `inset 2px 0 0 var(--color-block)`,
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[14px]" style={{ color: "var(--color-ink)" }}>
          {event.summary}
        </div>
        <div className="num text-[12px]" style={{ color: "var(--color-ink-3)" }}>
          {event.domain?.name} · observed {event.observedValue} vs threshold{" "}
          {event.threshold}
        </div>
      </div>
      <span
        className="num text-[11.5px] tracking-[0.12em] uppercase"
        style={{
          color: resolved
            ? "var(--color-pass)"
            : acknowledged
              ? "var(--color-ink-3)"
              : "var(--color-block)",
        }}
      >
        {resolved
          ? "resolved"
          : acknowledged
            ? "acknowledged"
            : `unacknowledged · escalation level ${event.reminderLevel}`}
      </span>
      {!acknowledged && !resolved ? (
        <AcknowledgeButton organizationId={organizationId} eventId={event.id} />
      ) : null}
    </li>
  );
}

async function fetchMembers(organizationId: string): Promise<WorkspaceMemberRow[]> {
  try {
    const res = await listWorkspaceMembers(organizationId);
    return res.members ?? [];
  } catch {
    return [];
  }
}
