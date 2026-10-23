import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUser, listClients, readWorkspaceAllowance } from "@/lib/api";
import {
  getBillingCurrency,
  getBillingStatus,
  getCapabilities,
  getPlanCatalog,
  getWorkspaceEntitlements,
  listWorkspaceMembers,
  OpsError,
} from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import type { PlanDefinition } from "@/lib/types";
import { AppShell } from "@/components/harbor/app-shell";
import { BillingBoard, type Usage } from "@/components/harbor/billing-board";
import { BillingStanding } from "@/components/harbor/billing-standing";
import { PageHeader } from "@/components/harbor/page-header";
import { RefreshButton } from "@/components/harbor/refresh-button";
import { Notice } from "@/components/ui/notice";
import { ErrorState, PermissionState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Billing" };

function dateLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * /billing — for the person paying the bill.
 *
 * In the order the owner asks: where do I stand (plan, price, when it renews or
 * ends, anything wrong with the payment), how much of the plan is used, what
 * would changing plan change (per plan, the gains, the losses and the timing,
 * before anything is sent), and what happens to the account on a downgrade, a
 * cancellation or a failed payment.
 *
 * Prices, plans, limits and features come from the API only (GET /api/plans,
 * /billing, /entitlements). Retention durations are not shown: the catalog
 * carries them, nothing enforces them. No trial, no discount beyond annual
 * being ten months' price.
 *
 * Only the owner can change billing (billing:update); everyone else sees the
 * same page read-only and is told why.
 */
export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");
  const { checkout } = await searchParams;

  const [status, entitlements, catalog, capabilities, currencyPref, clients, members, allowance, me] = await Promise.all([
    getBillingStatus(active.id).then(
      (s) => ({ ok: true as const, s }),
      (e: unknown) => ({ ok: false as const, forbidden: e instanceof OpsError && e.status === 403 }),
    ),
    getWorkspaceEntitlements(active.id).catch(() => null),
    getPlanCatalog().catch(() => null),
    getCapabilities().catch(() => null),
    getBillingCurrency(active.id).catch(() => null),
    listClients(active.id).catch(() => null),
    listWorkspaceMembers(active.id).catch(() => null),
    readWorkspaceAllowance().catch(() => null),
    getSessionUser().catch(() => null),
  ]);

  const shell = (children: React.ReactNode) => (
    <AppShell workspaces={workspaces} activeWorkspace={active} trail={[{ label: "Billing" }]}>
      <div className="flex flex-col gap-8">
        <PageHeader
          title="Billing"
          lede="The plan this workspace is on, what it costs, how much of it is used, and what changing it would change."
          actions={<RefreshButton />}
        />
        {children}
      </div>
    </AppShell>
  );

  if (!status.ok) {
    return shell(
      status.forbidden ? (
        <PermissionState what="billing" detail="Billing is visible to the workspace's members; this account's role does not include it." />
      ) : (
        <ErrorState what="the billing status" detail="Nothing about the plan or any payment was changed; the read failed." />
      ),
    );
  }
  if (!catalog) {
    return shell(<ErrorState what="the plan catalog" detail="No prices are shown rather than old ones. The plan itself is unchanged." />);
  }

  const s = status.s;
  const plans = catalog.order
    .map((tier) => catalog.plans.find((p) => p.tier === tier))
    .filter((p): p is PlanDefinition => Boolean(p));
  const current = plans.find((p) => p.tier === s.plan) ?? null;
  const free = plans.find((p) => p.prices.USD.monthlyMinor === 0 && p.prices.INR.monthlyMinor === 0) ?? null;

  const memberRows = members?.members ?? null;
  const myRole = memberRows?.find((m) => (m.userId ?? m.user?.id) === me?.id)?.role ?? null;
  const canChange = myRole === "owner";

  const domainTotal = clients ? clients.reduce((n, c) => n + c.domains.length, 0) : null;
  const usage: Usage = {
    clients: clients ? { used: clients.length, exact: (allowance?.used ?? 1) <= 1 } : null,
    domains: domainTotal === null ? null : { used: domainTotal, exact: false },
    members: memberRows ? { used: memberRows.length, exact: true } : null,
    workspaces: allowance ? { used: allowance.used, exact: true } : null,
  };

  const chargeable = (["INR", "USD"] as const).filter((c) => capabilities?.currencies.includes(c));
  const hasSubscription = s.provider !== "NONE";
  const periodEnd = dateLabel(s.currentPeriodEnd);

  return shell(
    <>
      {checkout === "complete" ? (
        <Notice tone="ok" title="Payment sent to the provider" testId="checkout-complete">
          The plan changes as soon as the provider confirms the payment to us, usually within a minute. If this page still
          shows the old plan, refresh it shortly.
        </Notice>
      ) : checkout === "cancelled" ? (
        <Notice tone="info" title="Checkout was not completed" testId="checkout-cancelled">
          The plan is unchanged. You can start again whenever you like.
        </Notice>
      ) : null}

      <BillingStanding
        organizationId={active.id}
        status={s}
        currentLabel={current?.label ?? s.plan}
        freeLabel={free?.label ?? "the free plan"}
        pendingLabel={s.pendingPlan ? (plans.find((p) => p.tier === s.pendingPlan?.plan)?.label ?? s.pendingPlan.plan) : null}
        periodEnd={periodEnd}
        pendingAt={dateLabel(s.pendingPlan?.effectiveAt)}
        // Only the API's own date. The grace length is a backend constant the
        // API does not expose, so it is never recomputed here.
        graceUntil={dateLabel(s.graceEnds)}
        canChange={canChange}
      />

      <BillingBoard
        organizationId={active.id}
        plans={plans}
        currentTier={s.plan}
        pendingTier={s.pendingPlan?.plan ?? null}
        provider={s.provider}
        hasSubscription={hasSubscription}
        cancelling={s.cancelAtPeriodEnd}
        periodEnd={periodEnd}
        currency={s.currency}
        currencyLocked={currencyPref?.locked ?? hasSubscription}
        currentInterval={s.interval === "ANNUAL" ? "annual" : "monthly"}
        chargeable={[...chargeable]}
        capabilitiesKnown={capabilities !== null}
        usage={usage}
        canChange={canChange}
        contact={me ? { name: me.name ?? "", email: me.email } : null}
        entitlementsKnown={entitlements !== null}
      />

      <section aria-labelledby="consequences-head" className="grid gap-x-10 gap-y-6 border-t border-rule pt-6 lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <h2 id="consequences-head" className="text-h2 font-bold tracking-[-0.02em] text-fg">
          If you downgrade, cancel or a payment fails
        </h2>
        <dl className="grid gap-x-8 gap-y-5 md:grid-cols-2">
          {[
            [
              "Moving to a smaller plan",
              s.provider === "PADDLE"
                ? "Applies at once, and Paddle adjusts the charge for the rest of the period. It is refused while the workspace has more clients, active domains or members than the smaller plan allows: remove the excess first. Nothing is deleted or switched off to make it fit."
                : "Applies when the period you have paid for ends, with no charge in between. It is refused while the workspace has more clients, active domains or members than the smaller plan allows: remove the excess first. Nothing is deleted or switched off to make it fit.",
            ],
            [
              "Cancelling",
              `The plan stays until the paid period ends${periodEnd ? ` (${periodEnd})` : ""}, then the workspace moves to ${free?.label ?? "the free plan"}. Every client, domain and report is kept, and you can resume before the period ends.`,
            ],
            [
              "A payment that fails",
              "Nothing changes while the paid period runs: the provider retries the card. After the period ends there is a short grace period to fix it. If it is still unpaid, the workspace moves to the free plan with every client, domain and report intact, and choosing a plan again restores it.",
            ],
            // Only for a plan that has a logo to lose.
            ...(current?.features["branding.logoUpload"]
              ? [
                  [
                    `Leaving ${current.label}`,
                    "The uploaded white-label logo is removed when the workspace moves to a plan without logo upload. Upload it again after moving back.",
                  ],
                ]
              : []),
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-ui font-semibold text-fg">{k}</dt>
              <dd className="mt-1 text-ui text-fg-2">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-meta text-fg-3 lg:col-start-2">
          Export of personal data and erasure of personal data are free on every plan, the free one included: they are on
          Settings, under Export and Erasure. Refunds follow the{" "}
          <a href="/refunds" className="link">
            Refund Policy
          </a>
          ; ask{" "}
          <a href="/support" className="link">
            support
          </a>{" "}
          if a charge looks wrong.
        </p>
      </section>
    </>,
  );
}
