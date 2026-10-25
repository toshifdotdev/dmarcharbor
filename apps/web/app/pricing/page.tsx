import type { Metadata } from "next";
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
        <main id="main" className="mx-auto w-full max-w-[1240px] px-5 pb-24 pt-14 sm:px-8">
          <h1 className="display text-[40px] leading-none text-fg">Pricing</h1>
          <p role="alert" className="mt-4 max-w-[62ch] text-body text-fg-2">
            The plan catalog did not load, so no prices are shown rather than old ones. Nothing is hidden: the request
            failed. Try again in a moment.
          </p>
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
      <main id="main" className="mx-auto w-full max-w-[1240px] px-5 pb-24 pt-12 sm:px-8 sm:pt-16">
        <header className="mb-10 grid gap-x-12 gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:items-end">
          <div>
            <p className="legend">Pricing</p>
            <h1 className="display mt-2 text-[38px] leading-[1.02] text-fg sm:text-[52px]">
              Priced by the size of the client book.
            </h1>
          </div>
          <p className="text-body text-fg-2">
            Plans differ in how many clients and domains they hold and in what you can hand to clients. Reports are
            read and measured the same way on every plan.
          </p>
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
              <section aria-labelledby="floor-head" className="grid gap-x-12 gap-y-4 border-y border-rule py-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div>
                  <h2 id="floor-head" className="wide text-h2 font-bold tracking-[-0.02em] text-fg">
                    On every plan
                  </h2>
                  {rightsOnEveryPlan ? (
                    <p className="mt-2 max-w-[56ch] text-body text-fg-2">
                      <span className="font-semibold text-fg">Data export and data erasure are on every plan</span>,
                      the free one included. Getting your data out, and having it deleted, are a legal floor. {name}{" "}
                      never sells them as an upgrade.
                    </p>
                  ) : null}
                </div>
                <ul className="flex flex-col gap-2 self-center text-ui text-fg">
                  {[...baseline, ...(rightsOnEveryPlan ? ["data.export", "data.erase"] : [])].map((k) => (
                    <li key={k} className="flex items-baseline gap-2 border-b border-rule pb-2">
                      <span aria-hidden className="block size-1.5 shrink-0 translate-y-[-2px] bg-ok" />
                      {planFeatureLabel(k)}
                    </li>
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
