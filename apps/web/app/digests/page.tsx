import { redirect } from "next/navigation";
import { listClients } from "@/lib/api";
import { getWorkspaceEntitlements, listReportDigests } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import { Shell } from "@/components/shell";
import { UpgradePrompt } from "@/components/upgrade-gate";
import { EmptyState, ErrorState } from "@/components/data-states";
import { DigestActions, DigestForm } from "@/components/digests-client";
import { DigestRunControls, RunAllDigestsButton } from "@/components/digest-controls";

export default async function DigestsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  const entitlements = await getWorkspaceEntitlements(active.id).catch(() => null);
  const digestsEnabled = entitlements?.features["digests"] === true;
  const allowForensics = entitlements?.features["reports.forensic"] === true;

  const [clients, digests] = await Promise.all([
    // Three states, never two: a failed load must never render as "no digests
    // yet": that is a lie that costs someone an afternoon.
    listClients(active.id).catch(() => null),
    listReportDigests(active.id).catch(() => null),
  ]);
  const loadFailed = clients === null || digests === null;
  const clientRows = clients ?? [];
  const digestRows = digests ? digests.items : [];
  const domains = clientRows.flatMap((c) => c.domains.map((d) => ({ id: d.id, name: d.name })));

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Digests</h1>
          <p className="mt-1.5 text-[14.5px]" style={{ color: "var(--color-ink-2)" }}>
            Scheduled report summaries sent to client contacts under your brand.
          </p>
        </header>

{!digestsEnabled ? (
            <UpgradePrompt
              error={{
                feature: "digests",
                message: entitlements
                  ? "Scheduled digests are not included in this plan."
                  : "Scheduled digests require an entitlement the current plan does not carry.",
              }}
              context="The API owns which plan carries digests; this workspace's current plan does not."
            />
          ) : (
            <>
              <section className="panel p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="max-w-xl">
                    <h2 className="text-[15px] font-semibold">Send without waiting</h2>
                    <p className="mt-1 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                      Useful the first time you set a digest up, when the only other
                      way to find out whether it works is to wait for the schedule.
                    </p>
                  </div>
                  <RunAllDigestsButton organizationId={active.id} />
                </div>
              </section>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <DigestForm
                organizationId={active.id}
                domains={domains}
                allowForensics={allowForensics}
              />

              <section
                className="lift rounded-[2px] border"
                style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
              >
                <header className="border-b px-5 py-3.5" style={{ borderColor: "var(--color-line)" }}>
                  <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">Scheduled</h2>
                </header>
                {loadFailed ? (
                  <div className="p-5">
                    <ErrorState what="the scheduled digests" detail="This is a connection or API problem, not an empty schedule." />
                  </div>
                ) : digestRows.length === 0 ? (
                  <div className="p-5">
                    <EmptyState
                      title="No digests scheduled yet"
                      description="A digest is a recurring report summary sent to your client's contacts under your brand. Create the first one on the left: weekly or monthly, with the recipient list you choose."
                    />
                  </div>
                ) : (
                  <ul>
                    {digestRows.map((d) => (
                      <li
                        key={d.id}
                        className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b px-5 py-3"
                        style={{
                          borderColor: "rgba(255,255,255,0.055)",
                          boxShadow: d.enabled ? undefined : "inset 2px 0 0 var(--color-unmeasured)",
                        }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[14px]" style={{ color: "var(--color-ink)" }}>
                            {d.domain?.name}
                          </div>
                          <div className="num text-[12px]" style={{ color: "var(--color-ink-3)" }}>
                            {d.frequency.toLowerCase()} · {String(d.sendHourUtc).padStart(2, "0")}:00 UTC ·{" "}
                            {d.frequency === "WEEKLY"
                              ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.weekday]
                              : `day ${d.dayOfMonth}`}{" "}
                            · {d.recipientEmails.length} recipient
                            {d.recipientEmails.length === 1 ? "" : "s"}
                            {d.includeForensics ? " · forensic included" : ""}
                          </div>
                        </div>
                        <span
                          className="num text-[11.5px] tracking-[0.12em] uppercase"
                          style={{ color: d.enabled ? "var(--color-pass)" : "var(--color-unmeasured)" }}
                        >
                          {d.enabled ? "active" : "paused"}
                        </span>
<DigestActions organizationId={active.id} digest={d} />
                          <div className="basis-full">
                            <DigestRunControls
                              organizationId={active.id}
                              digestId={d.id}
                              digestLabel={d.domain?.name ?? "this digest"}
                            />
                          </div>
                        </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}
