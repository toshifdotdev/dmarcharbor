import type { Metadata } from "next";
import { listClients } from "@/lib/api";
import {
  OpsError,
  getMonthlyReportSchedule,
  getWorkspaceEntitlements,
  listMonthlyReports,
} from "@/lib/api-ops";
import { featureOf } from "@/lib/entitlements";
import { instantLabel } from "@/lib/instant";
import { settingsContext } from "@/lib/settings-context";
import { mayChange } from "@/lib/settings-map";
import type { ClientRow, MonthlyReportRow, MonthlyReportSchedule } from "@/lib/types";
import { AppShell } from "@/components/harbor/app-shell";
import {
  MonthlyReportClientPicker,
  MonthlyReportsBoard,
  type MonthlyReportView,
} from "@/components/harbor/monthly-reports";
import { PageHeader } from "@/components/harbor/page-header";
import { PlanUnknown } from "@/components/harbor/plan-refusal";
import { EmptyState, ErrorState, UpgradeNotice } from "@/components/ui/states";

export const metadata: Metadata = { title: "Monthly reports" };

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function startOfUtcMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function addMonths(value: Date, months: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1));
}

/**
 * The complete months this client can be reported on: at most the last twelve,
 * never the current month, and never before the month the client was created.
 */
function completeMonthOptions(clientCreatedAt: string, now = new Date()): Array<{ value: string; label: string }> {
  const created = new Date(clientCreatedAt);
  const current = startOfUtcMonth(now);
  const earliest = addMonths(current, -12);
  const createdMonth = Number.isNaN(created.getTime()) ? earliest : startOfUtcMonth(created);
  const from = createdMonth.getTime() > earliest.getTime() ? createdMonth : earliest;
  const options: Array<{ value: string; label: string }> = [];

  for (let month = addMonths(current, -1); month.getTime() >= from.getTime() && options.length < 12; month = addMonths(month, -1)) {
    const value = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
    options.push({ value, label: `${monthNames[month.getUTCMonth()]} ${month.getUTCFullYear()}` });
  }

  return options;
}

export default async function MonthlyReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const ctx = await settingsContext();
  const { workspaces, active } = ctx;

  const [{ client: wanted }, clients, entitlements] = await Promise.all([
    searchParams,
    listClients(active.id).catch(() => null as ClientRow[] | null),
    getWorkspaceEntitlements(active.id).catch(() => null),
  ]);

  const selected = clients?.find((client) => client.id === wanted) ?? clients?.[0] ?? null;
  const feature = featureOf(entitlements, "reports.compliancePack");
  const canManage = ctx.role === null || mayChange(ctx.role, "admin");

  let reports: MonthlyReportView[] | null = null;
  let schedule: MonthlyReportSchedule | null = null;
  let scheduleFailed = false;
  let reportsFailed = false;
  let planBlocked = false;

  if (selected && feature === true) {
    const [reportResult, scheduleResult] = await Promise.all([
      listMonthlyReports(active.id, selected.id).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      getMonthlyReportSchedule(active.id, selected.id).then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ]);
    if (reportResult.ok) {
      // Issue times in words on the server, so the board's first paint is a string.
      reports = reportResult.result.reports.map((r: MonthlyReportRow) => ({ ...r, issuedLabel: instantLabel(r.issuedAt) }));
    } else if (reportResult.error instanceof OpsError && reportResult.error.status === 402) {
      planBlocked = true;
    } else {
      reportsFailed = true;
    }
    if (scheduleResult.ok) {
      schedule = scheduleResult.result.schedule;
    } else if (scheduleResult.error instanceof OpsError && scheduleResult.error.status === 402) {
      planBlocked = true;
    } else {
      scheduleFailed = true;
    }
  }

  const periodOptions = selected ? completeMonthOptions(selected.createdAt) : [];

  return (
    <AppShell
      workspaces={workspaces}
      activeWorkspace={active}
      trail={[{ label: "Clients", href: "/clients" }, { label: "Monthly reports" }]}
    >
      <div className="flex flex-col gap-10">
        <PageHeader
          title="Monthly reports"
          lede="One branded PDF a month for each client: what happened to its domains' email authentication in the previous complete month, with the evidence and a public fingerprint."
          meta={
            selected ? (
              <span>
                <span className="font-semibold text-fg-2">{selected.name}</span>{" "}
                <span className="tnum">{selected.domains.length}</span> domain{selected.domains.length === 1 ? "" : "s"} in each report
              </span>
            ) : null
          }
          actions={
            clients && clients.length > 1 && selected ? (
              <MonthlyReportClientPicker
                clients={clients.map((client) => ({ id: client.id, name: client.name }))}
                selected={selected.id}
              />
            ) : null
          }
        />

        {entitlements === null ? <PlanUnknown what="monthly reports" /> : null}
        {clients === null ? (
          <ErrorState
            what="the client list"
            detail="Monthly reports are issued per client, so this page needs it. Nothing was changed."
          />
        ) : !selected ? (
          <EmptyState
            title="No client yet"
            description="A monthly report belongs to a client. Add the client and its domains first."
            action={{ label: "Go to clients", href: "/clients" }}
          />
        ) : feature === false || planBlocked ? (
          <UpgradeNotice
            message="Monthly evidence reports are not included in this workspace's plan."
            feature="reports.compliancePack"
          />
        ) : (
          <MonthlyReportsBoard
            key={selected.id}
            organizationId={active.id}
            clientId={selected.id}
            clientName={selected.name}
            reports={reportsFailed ? null : reports}
            schedule={schedule}
            scheduleFailed={scheduleFailed}
            periodOptions={periodOptions}
            canManage={canManage}
          />
        )}
      </div>
    </AppShell>
  );
}
