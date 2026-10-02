import {
  getBillingStatus,
  getPlanCatalog,
  getWorkspaceEntitlements,
} from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import { featureLabel } from "@/lib/feature-label";
import { Shell } from "@/components/shell";
import { PlanPicker } from "@/components/billing-client";

/**
 * Billing renders from two API reads only:
 *   GET /api/workspaces/:id/entitlements — plan, limits, features
 *   GET /api/plans                       — the catalog with prices
 * Plan names, prices and limits are never hardcoded here. Limits are shown as
 * given: entitlements carry no usage figure and no endpoint provides one, so
 * no usage bar exists on this page.
 */
export default async function BillingPage() {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) return null;

  const entitlements = await getWorkspaceEntitlements(active.id).catch(() => null);
  const catalog = await getPlanCatalog().catch(() => null);
  const billing = await getBillingStatus(active.id).catch(() => null);

  const currency = billing?.currency ?? "USD";

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Billing</h1>
          <p className="mt-1.5 text-[15.5px]" style={{ color: "var(--color-ink-2)" }}>
            Everything each plan carries, in full — so the choice is made on
            facts, not on a sales call.
          </p>
        </header>

        {entitlements ? (
          <section
            className="lift rounded-[2px] border p-6"
            style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
          >
            <div className="flex flex-wrap items-baseline gap-x-10 gap-y-4">
              <div>
                <div className="label">Your plan</div>
                <div className="text-[22.5px] font-semibold tracking-[-0.015em]" style={{ color: "var(--color-ink)" }}>
                  {entitlements.label}
                </div>
                <div className="num mt-1 text-[13px] tracking-[0.12em] uppercase" style={{ color: "var(--color-ink-3)" }}>
                  {entitlements.status.toLowerCase()}
                  {entitlements.currentPeriodEnd
                    ? ` · period ends ${new Date(entitlements.currentPeriodEnd).toLocaleDateString("en-GB")}`
                    : ""}
                  {entitlements.cancelAtPeriodEnd ? " · cancels at period end" : ""}
                </div>
              </div>
              <div>
                <div className="label">What it covers</div>
                <div className="num mt-1 text-[15px]" style={{ color: "var(--color-ink-2)" }}>
                  {entitlements.maxClients} clients · {entitlements.maxActiveDomains} active domains ·{" "}
                  {entitlements.maxMembers} members · {entitlements.dataRetentionDays}d data retention
                </div>
              </div>
            </div>

            <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--color-line)" }}>
              <div className="label">Included right now</div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {Object.entries(entitlements.features)
                  .filter(([, on]) => on)
                  .map(([key]) => (
                    <span
                      key={key}
                      className="rounded-[2px] border px-2.5 py-1 text-[13px]"
                      style={{
                        borderColor: "var(--color-line-strong)",
                        color: "var(--color-ink-2)",
                      }}
                    >
                      {featureLabel(key)}
                    </span>
                  ))}
              </div>
            </div>
          </section>
        ) : (
          <p role="alert" className="text-[15px]" style={{ color: "var(--color-block)" }}>
            Your plan details could not be loaded.
          </p>
        )}

        {catalog ? (
          <PlanPicker
            organizationId={active.id}
            plans={catalog.plans}
            order={catalog.order}
            currentPlan={entitlements?.plan ?? ""}
            currency={currency}
            status={entitlements?.status ?? "NONE"}
            cancelAtPeriodEnd={entitlements?.cancelAtPeriodEnd ?? false}
          />
        ) : (
          <p role="alert" className="text-[15px]" style={{ color: "var(--color-block)" }}>
            The plan catalog could not be loaded — prices are never guessed here.
          </p>
        )}

        <section
          className="lift rounded-[2px] border p-5"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
        >
          <h2 className="text-[16.5px] font-semibold tracking-[-0.012em]">
            Included in every plan, at no cost
          </h2>
          <ul className="mt-3 flex flex-col gap-2">
            <li className="text-[15px]" style={{ color: "var(--color-ink-2)" }}>
              <strong style={{ color: "var(--color-ink)" }}>Export of personal data</strong> —
              available on every plan. It is not a paid feature.
            </li>
            <li className="text-[15px]" style={{ color: "var(--color-ink-2)" }}>
              <strong style={{ color: "var(--color-ink)" }}>Erasure of personal data</strong> —
              available on every plan. It is not a paid feature.
            </li>
            <li className="text-[15px]" style={{ color: "var(--color-ink-2)" }}>
              <strong style={{ color: "var(--color-ink)" }}>The same measurement engine</strong> —
              a larger plan carries more cargo; it never parses better.
            </li>
          </ul>
        </section>
      </div>
    </Shell>
  );
}
