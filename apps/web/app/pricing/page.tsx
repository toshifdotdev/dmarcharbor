import type { Metadata } from "next";
import Link from "next/link";
import { listWorkspaces } from "@/lib/api";
import {
  getBillingCurrency,
  getCapabilities,
  getPlanCatalog,
  getWorkspaceEntitlements,
  type DeploymentCapabilities,
} from "@/lib/api-ops";
import { readHostBrand } from "@/lib/host-brand";
import { requestOrigin } from "@/lib/metadata-origin";
import { onEveryPlan, planFeatureLabel } from "@/lib/plan-features";
import { pickActiveWorkspace } from "@/lib/session";
import { publicMetadata } from "@/lib/seo";
import { planOffersJsonLd } from "@/lib/structured-data";
import type { BillingCurrencyPreference, PlanDefinition } from "@/lib/types";
import { PricingBoard, type PricingCurrency, type PricingInterval } from "@/components/harbor/pricing-board";
import { PublicFooter, PublicHeader, brandName } from "@/components/harbor/public-frame";
import { StructuredData } from "@/components/structured-data-view";
import s from "@/components/harbor/pricing.module.css";

/** Pricing is the page a buyer shares with their finance team: canonical and
 *  OG card against the host the request came in on, custom domains included. */
export async function generateMetadata(): Promise<Metadata> {
  const origin = await requestOrigin();
  return publicMetadata({
    title: "Pricing",
    description:
      "Plans by the size of the client book: clients, active domains, members and workspaces, monthly or annual, with every feature compared.",
    path: "/pricing",
    origin,
  });
}

const CURRENCIES = ["INR", "USD"] as const;

/**
 * What every plan does that has no entitlement key, so the catalog cannot list
 * it. Each is a route with no plan gate in apps/api: DNS scans and the change
 * history (domain-scan.routes), the mailbox-provider checks
 * (mailbox-compliance.routes), the registration expiry date
 * (domain-registration.routes), sender review (onboarding.routes,
 * senders/review), subdomain discovery (onboarding.routes, subdomains), the
 * switch kit (switch.routes) and two-step verification
 * (mfa.routes). Warnings about DNS changes and expiry are alerts, and are not
 * claimed here.
 */
const UNGATED_CAPABILITIES = [
  "DNS monitoring and change history",
  "Gmail, Yahoo and Microsoft sender requirement checks",
  "Domain registration expiry dates",
  "Sender review: mark each source as yours or not",
  "Subdomains seen sending that you do not monitor",
  "Switch kit for moving from another DMARC service",
  "Two-step verification",
];

/** The currencies a checkout can complete on this deployment: provider
 *  readiness from GET /api/capabilities, never inferred from the catalog. */
function chargeableCurrencies(caps: DeploymentCapabilities | null): PricingCurrency[] {
  return CURRENCIES.filter((c) => caps?.currencies.includes(c));
}

function asCurrency(v: string | null | undefined): PricingCurrency | null {
  return v === "INR" || v === "USD" ? v : null;
}

/**
 * /pricing — every plan from GET /api/plans, nothing typed in.
 *
 * Plan names, descriptors, prices, limits and feature grants are the API's.
 * This page decides only what to show first (the figure in the chosen
 * currency and period), what to compute for the reader (the annual saving),
 * and what to say about checkout, which comes from GET /api/capabilities.
 *
 * Not published here, on purpose: retention figures (the plan's retention
 * fields govern nothing) and anything about staged policy rollout.
 */
export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ currency?: string; interval?: string }>;
}) {
  const brand = await readHostBrand();
  const name = brandName(brand);
  const [catalog, capabilities] = await Promise.all([
    getPlanCatalog().catch(() => null),
    getCapabilities().catch(() => null),
  ]);

  // Signed in or not decides where the buttons go and whether a currency
  // choice is stored. A failed read is "signed out": display only.
  let organizationId: string | null = null;
  let preference: BillingCurrencyPreference | null = null;
  let currentTier: string | null = null;
  try {
    const active = await pickActiveWorkspace(await listWorkspaces());
    if (active) {
      organizationId = active.id;
      const [pref, ent] = await Promise.all([
        getBillingCurrency(active.id).catch(() => null),
        getWorkspaceEntitlements(active.id).catch(() => null),
      ]);
      preference = pref;
      currentTier = ent?.plan ?? null;
    }
  } catch {
    // Signed out.
  }

  if (!catalog) {
    return (
      <div data-harbor data-host-brand={brand.state}>
        <PublicHeader brand={brand} current="pricing" />
        <main id="main" className="page-wrap pb-24">
          <header className={s.head}>
            <h1 className={s.headline}>Pricing</h1>
            <p role="alert" className={s.lead}>
              The plan catalog did not load, so no prices are shown rather than old ones. Nothing is hidden: the request
              failed. Try again in a moment.
            </p>
          </header>
        </main>
        <PublicFooter brand={brand} />
      </div>
    );
  }

  const plans = catalog.order
    .map((tier) => catalog.plans.find((p) => p.tier === tier))
    .filter((p): p is PlanDefinition => Boolean(p));

  const { currency: wantedRaw, interval: wantedInterval } = await searchParams;
  const chargeable = chargeableCurrencies(capabilities);
  const wanted = asCurrency(wantedRaw);
  const stored = asCurrency(preference?.preferredCurrency);
  const fallback = asCurrency(capabilities?.defaultCurrency) ?? "INR";
  // The figure is quoted in a currency a checkout can take. When none can,
  // the deployment's default currency is shown as list prices.
  const currency: PricingCurrency =
    chargeable.length === 0
      ? fallback
      : (stored && chargeable.includes(stored) ? stored : null) ??
        (wanted && chargeable.includes(wanted) ? wanted : null) ??
        (chargeable.includes(fallback) ? fallback : chargeable[0]);
  // Monthly is the figure people compare; annual is the one they opt into.
  const interval: PricingInterval = wantedInterval === "annual" ? "annual" : "monthly";

  const checkoutNote = !capabilities
    ? "Which currencies checkout takes could not be read just now. Prices shown are list prices."
    : chargeable.length === 0
      ? "Checkout is not open on this deployment yet. Prices shown are list prices in both currencies."
      : chargeable.length === 1
        ? `Checkout takes ${chargeable[0]}. ${chargeable[0] === "INR" ? "USD" : "INR"} figures are list prices; checkout in it is not open yet.`
        : "Checkout takes INR or USD.";

  const persist =
    organizationId && chargeable.length > 1
      ? { organizationId, locked: preference?.locked ?? false, reason: preference?.reason ?? null }
      : null;

  // Said only when the catalog says it: every plan grants both.
  const rightsOnEveryPlan = onEveryPlan(plans, "data.export") && onEveryPlan(plans, "data.erase");
  const baseline = ["reports.aggregate", "audit.trail"].filter((k) => onEveryPlan(plans, k));

  const offers = planOffersJsonLd(
    await requestOrigin(),
    plans.map((p) => ({ name: p.label, monthlyMinor: p.prices.USD.monthlyMinor, pricing: p.pricing })),
  );

  return (
    <div data-harbor data-host-brand={brand.state}>
      <PublicHeader brand={brand} current="pricing" />
      <StructuredData data={offers} />
      <main id="main" className="page-wrap pb-24 sm:pb-32">
        <header className={s.head}>
          <h1 className={s.headline}>Priced by the size of the client book.</h1>
          <div>
            <p className={s.lead}>
              Plans differ in how many clients and domains they hold and in what you can hand to clients. Reports are
              read and measured the same way on every plan.
            </p>
            {/* Promised in the Refund Policy: 14 days from the first payment, once per customer. */}
            <p className={s.guarantee} data-testid="pricing-money-back">
              <b>14-day money-back guarantee</b> on your first payment.{" "}
              <Link href="/refunds" className="link">
                How refunds work
              </Link>
            </p>
          </div>
        </header>

        <PricingBoard
          plans={plans}
          chargeable={chargeable}
          initialCurrency={currency}
          initialInterval={interval}
          persist={persist}
          signedIn={organizationId !== null}
          currentTier={currentTier}
          checkoutNote={checkoutNote}
          between={
            rightsOnEveryPlan || baseline.length > 0 ? (
              <section aria-labelledby="floor-head" className={`${s.section} ${s.floor}`}>
                <div>
                  <h2 id="floor-head" className={s.h2}>
                    On every plan
                  </h2>
                  {rightsOnEveryPlan ? (
                    <p className={s.lead}>
                      <b className="font-semibold text-fg">Data export and data erasure are on every plan</b>, the free
                      one included. Getting your data out, and having it deleted, are a legal floor. {name} never sells
                      them as an upgrade.
                    </p>
                  ) : null}
                  <p className={s.lead}>
                    Every plan also watches each domain&rsquo;s DNS and runs the checks listed here. Retention is the same
                    on every plan, so a downgrade never deletes history.
                  </p>
                </div>
                <ul className={s.floorList} data-testid="pricing-every-plan">
                  {[
                    ...[...baseline, ...(rightsOnEveryPlan ? ["data.export", "data.erase"] : [])].map(planFeatureLabel),
                    ...UNGATED_CAPABILITIES,
                  ].map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              </section>
            ) : null
          }
        />
      </main>
      <PublicFooter brand={brand} />
    </div>
  );
}
