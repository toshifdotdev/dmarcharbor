import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUser, listClients } from "@/lib/api";
import { getWorkspaceEntitlements, listAlertEvents, listAlertRules, listWorkspaceMembers } from "@/lib/api-ops";
import { eventState, isMetric, minutesLabel, nextReminderAt, valueWithUnit } from "@/lib/alert-rules";
import { featureOf } from "@/lib/entitlements";
import { instantLabel } from "@/lib/instant";
import { resolveActiveWorkspace } from "@/lib/session";
import type { AlertRuleRow, WorkspaceMemberRow } from "@/lib/types";
import { AlertEvents, type EventView } from "@/components/harbor/alert-events";
import { AlertRuleForm, type MemberChoice } from "@/components/harbor/alert-rule-form";
import { AlertRules, type RuleView } from "@/components/harbor/alert-rules";
import { AppShell } from "@/components/harbor/app-shell";
import { PageHeader } from "@/components/harbor/page-header";
import { PlanUnknown } from "@/components/harbor/plan-refusal";
import { RefreshButton } from "@/components/harbor/refresh-button";
import { ErrorState, UpgradeNotice } from "@/components/ui/states";

export const metadata: Metadata = { title: "Alerts" };

function memberChoice(m: WorkspaceMemberRow): MemberChoice {
  return {
    userId: m.userId ?? m.user?.id ?? m.id,
    label: m.user?.name || m.user?.email || "A workspace member",
    email: m.user?.email ?? null,
    role: m.role,
  };
}

/**
 * /alerts — what fired, what is watching, and a new watch.
 *
 * Read top to bottom the way an operator works it at 9am: the open events
 * first (what needs a person now, with how far each has escalated and when it
 * will remind again), then the rules that produced them, then the form to add
 * one. Everything said about a metric comes from lib/alert-rules.ts, which is
 * the API's own definition written down once.
 *
 * Plan gating follows the API, not a guess: reading rules and events needs no
 * feature, so a workspace whose plan lost alerting still sees its history and
 * can acknowledge; changing or creating rules needs alerts.email (and
 * alerts.spoofing for the new-source metric). An unreadable plan is said as
 * unknown, never as "not included".
 */
export default async function AlertsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  const [entitlements, clients, rules, events, members, me] = await Promise.all([
    getWorkspaceEntitlements(active.id).catch(() => null),
    listClients(active.id).catch(() => null),
    listAlertRules(active.id).catch(() => null),
    listAlertEvents(active.id).catch(() => null),
    listWorkspaceMembers(active.id)
      .then((r) => r.members ?? [])
      .catch(() => null),
    getSessionUser().catch(() => null),
  ]);

  const alerting = featureOf(entitlements, "alerts.email");
  const spoofing = featureOf(entitlements, "alerts.spoofing");
  const memberChoices = (members ?? []).map(memberChoice);
  const memberName = new Map(memberChoices.map((m) => [m.userId, m.label]));
  const ruleById = new Map<string, AlertRuleRow>((rules?.items ?? []).map((r) => [r.id, r]));
  const slugById = new Map((clients ?? []).flatMap((c) => c.domains.map((d) => [d.id, d.slug] as const)));

  const eventViews: EventView[] = (events?.items ?? []).map((e) => {
    const rule = ruleById.get(e.ruleId);
    const next = nextReminderAt(e, rule);
    return {
      id: e.id,
      ruleName: e.rule?.name ?? rule?.name ?? "A deleted rule",
      domainName: e.domain.name,
      domainSlug: e.domain.slug,
      summary: e.summary,
      observed: isMetric(e.metric) ? valueWithUnit(e.metric, e.observedValue) : String(e.observedValue),
      threshold: isMetric(e.metric) ? valueWithUnit(e.metric, e.threshold) : String(e.threshold),
      state: eventState(e),
      firedLabel: instantLabel(e.triggeredAt),
      handledLabel: e.resolvedAt ? instantLabel(e.resolvedAt) : e.acknowledgedAt ? instantLabel(e.acknowledgedAt) : null,
      stale: Boolean(e.staleAt),
      reminderLevel: e.reminderLevel,
      maxReminders: rule?.maxReminderLevel ?? null,
      nextReminderLabel: next ? instantLabel(next.toISOString()) : null,
    };
  });

  const ruleViews: RuleView[] = (rules?.items ?? []).map((r) => ({
    ...r,
    domainSlug: slugById.get(r.domainId) ?? null,
    lastFiredLabel: r.lastTriggeredAt ? instantLabel(r.lastTriggeredAt) : null,
    recipientNames: r.recipients.map((x) => memberName.get(x.userId) ?? "A former member"),
    cooldownLabel: minutesLabel(r.cooldownMinutes),
  }));

  const open = eventViews.filter((e) => e.state === "open").length;
  const enabled = ruleViews.filter((r) => r.enabled).length;
  const domainGroups = (clients ?? [])
    .filter((c) => c.domains.length > 0)
    .map((c) => ({ clientName: c.name, domains: c.domains.map((d) => ({ id: d.id, name: d.name })) }));

  return (
    <AppShell workspaces={workspaces} activeWorkspace={active} trail={[{ label: "Alerts" }]}>
      <div className="flex flex-col gap-8">
        <PageHeader
          title="Alerts"
          lede="Observed conditions worth waking someone for. An unacknowledged event escalates: it reminds again after each cooldown, up to the rule's limit, and open events roll up to the workspace owner. The level is always shown."
          meta={
            events && rules ? (
              <>
                <span>
                  <span className={open > 0 ? "tnum font-semibold text-fail" : "tnum font-semibold text-fg-2"}>{open}</span> open event
                  {open === 1 ? "" : "s"}
                </span>
                <span>
                  <span className="tnum font-semibold text-fg-2">{enabled}</span> of <span className="tnum">{ruleViews.length}</span> rule
                  {ruleViews.length === 1 ? "" : "s"} watching
                </span>
              </>
            ) : null
          }
          actions={<RefreshButton />}
        />

        {entitlements === null ? <PlanUnknown what="alerting" /> : null}

        <section aria-labelledby="events-head" className="flex flex-col gap-3">
          <h2 id="events-head" className="text-h2 font-bold tracking-[-0.02em] text-fg">
            Events
          </h2>
          {events === null ? (
            <ErrorState what="the alert events" detail="This is a connection or API problem, not a quiet workspace." />
          ) : (
            <AlertEvents
              organizationId={active.id}
              events={eventViews}
              truncated={events.hasMore}
              watching={enabled > 0}
            />
          )}
        </section>

        <div className="grid gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_380px]">
          <section aria-labelledby="rules-head" className="flex min-w-0 flex-col gap-3">
            <h2 id="rules-head" className="text-h2 font-bold tracking-[-0.02em] text-fg">
              Rules
            </h2>
            {rules === null ? (
              <ErrorState what="the alert rules" detail="This is a connection or API problem; no rule was changed." />
            ) : (
              <AlertRules
                organizationId={active.id}
                rules={ruleViews}
                members={memberChoices}
                editable={alerting === true}
              />
            )}
          </section>

          <aside className="flex flex-col gap-3 self-start lg:sticky lg:top-[104px]">
            {alerting === false ? (
              <UpgradeNotice
                message="Alert rules are not included in this workspace's plan."
                feature="alerts.email"
                context="Existing events stay readable and can still be acknowledged."
              />
            ) : clients === null || members === null ? (
              <ErrorState
                what={clients === null ? "the domain list" : "the member list"}
                detail="The new-rule form needs both to offer domains and recipients."
              />
            ) : (
              <AlertRuleForm
                organizationId={active.id}
                domainGroups={domainGroups}
                members={memberChoices}
                defaultRecipient={me?.id ?? memberChoices[0]?.userId ?? null}
                spoofing={spoofing}
              />
            )}
          </aside>
        </div>
      </div>
    </AppShell>
  );
}
