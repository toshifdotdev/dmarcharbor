import { listClients } from "@/lib/api";
import { getWorkspaceEntitlements, listReportDigests } from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import type { ReportDigestRow } from "@/lib/types";
import { Shell } from "@/components/shell";
import { UpgradePrompt } from "@/components/upgrade-gate";
import { DigestActions, DigestForm } from "@/components/digests-client";

export default async function DigestsPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) return null;

  const entitlements = await getWorkspaceEntitlements(active.id).catch(() => null);
  const digestsEnabled = entitlements?.features["digests"] === true;
  const allowForensics = entitlements?.features["reports.forensic"] === true;

  const [clients, digests] = await Promise.all([
    listClients(active.id).catch(() => []),
    listReportDigests(active.id).catch(() => ({
      items: [] as ReportDigestRow[],
      hasMore: false,
      nextCursor: null,
    })),
  ]);
  const domains = clients.flatMap((c) => c.domains.map((d) => ({ id: d.id, name: d.name })));

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
                {digests.items.length === 0 ? (
                  <p className="px-5 py-8 text-center text-[14px]" style={{ color: "var(--color-ink-3)" }}>
                    No digests scheduled yet.
                  </p>
                ) : (
                  <ul>
                    {digests.items.map((d) => (
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
