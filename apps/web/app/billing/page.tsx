import {
  getBillingCurrency,
  getBillingStatus,
  getPlanCatalog,
  getWorkspaceEntitlements,
} from "@/lib/api-ops";
import Link from "next/link";
import { getMe } from "@/lib/api-phase7";
import { resolveActiveWorkspace } from "@/lib/session";
import { featureLabel } from "@/lib/feature-label";
import { Shell } from "@/components/shell";
import { PlanPicker } from "@/components/billing-client";
import { DunningPanel } from "@/components/dunning-client";

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
  const currencyPref = await getBillingCurrency(active.id).catch(() => null);
  // The checkout contact is the signed-in account. Read here (server-only
  // module) and passed down — the API validates name and email, so an empty
  // contact is a guaranteed 400.
  const me = await getMe().catch(() => null);
  const account =
    me?.user?.name && me?.user?.email
      ? { name: me.user.name, email: me.user.email }
      : null;

  // The currency a checkout will charge is the stored preference (INR by
  // default until Paddle is approved), not the provider of an existing
  // subscription. billing.currency reports the provider's currency and would
  // mislabel a workspace that has not paid yet.
  const currency = currencyPref?.preferredCurrency ?? "INR";

  // The plan catalog owns plan NAMES. A pending plan arrives as a tier enum
  // (FAIRWAY), and a customer-facing row reads Fairway — never the enum.
  const planLabel = (tier: string) =>
    catalog?.plans.find((p) => p.tier === tier)?.label ?? tier;

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="label">Billing</h1>
          <p className="mt-1.5 text-[15.5px]" style={{ color: "var(--color-ink-2)" }}>
            Everything each plan carries, in full — so the choice is made on
            facts, not on a sales call.{" "}
            {/* The refund question arises HERE, not in a footer nobody reads
                mid-decision — so the policy is linked here. */}
            <Link
              href="/refunds"
              className="underline"
              style={{ color: "var(--color-ink)" }}
            >
              Refund policy
            </Link>
            .
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

              {/* Scheduled change, shown beside the current plan rather than
                  instead of it — a customer with both needs to see both. Null
                  means nothing scheduled; a field still landing renders the
                  spot without asserting anything. */}
              <div data-testid="pending-plan">
                <div className="label">Scheduled change</div>
                {billing?.pendingPlan ? (
                  <>
                    <div
                      className="text-[22.5px] font-semibold tracking-[-0.015em]"
                      style={{ color: "var(--color-unverified)" }}
                    >
                      {planLabel(billing.pendingPlan.plan)}
                    </div>
                    <div className="num mt-1 text-[13px] tracking-[0.12em] uppercase" style={{ color: "var(--color-ink-3)" }}>
                      {billing.pendingPlan.interval} · applies{" "}
                      {billing.pendingPlan.effectiveAt
                        ? new Date(billing.pendingPlan.effectiveAt).toLocaleDateString("en-GB", {
                            day: "numeric",
                            month: "long",
                          })
                        : "at the end of your current period"}
                    </div>
                    <p className="mt-1.5 max-w-[30ch] text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
                      {billing.pendingPlan.effectiveAt ? (
                        <>
                          You are on {entitlements.label} until{" "}
                          {new Date(billing.pendingPlan.effectiveAt).toLocaleDateString("en-GB", {
                            day: "numeric",
                            month: "long",
                          })}
                          , then {planLabel(billing.pendingPlan.plan)}. Everything you have now
                          stays until then.
                        </>
                      ) : (
                        <>
                          {planLabel(billing.pendingPlan.plan)} applies at the end of your
                          current period. Everything you have now stays until
                          then.
                        </>
                      )}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="text-[16px]" style={{ color: "var(--color-ink-3)" }}>
                      nothing scheduled
                    </div>
                    <p className="mt-1 max-w-[30ch] text-[12px]" style={{ color: "var(--color-ink-3)" }}>
                      A plan change you schedule appears here before it takes
                      effect.
                    </p>
                  </>
                )}
              </div>

              <div>
                <div className="label">What it covers</div>
                <div className="num mt-1 text-[15px]" style={{ color: "var(--color-ink-2)" }}>
                  {entitlements.maxClients} clients · {entitlements.maxActiveDomains} active domains ·{" "}
                  {entitlements.maxMembers} members · {entitlements.dataRetentionDays}d data retention
                </div>
              </div>
            </div>

            {billing ? (
              <DunningPanel
                organizationId={active.id}
                stage={billing.dunningStage}
                graceEnds={billing.graceEnds}
                status={billing.status}
              />
            ) : null}

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
            provider={billing?.provider ?? "NONE"}
            cancelAtPeriodEnd={entitlements?.cancelAtPeriodEnd ?? false}
            account={account}
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
