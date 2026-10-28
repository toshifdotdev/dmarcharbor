"use client";

/**
 * pricing-board.tsx — the plans, the two questions that change their figures
 * (which currency, which period), and the full comparison.
 *
 * Every name, price, limit and feature is a prop from GET /api/plans; nothing
 * here knows what a plan is called or costs. The words this file adds are the
 * cadence ("per month"), the saving (computed from the two prices, never
 * typed in), and the plain feature labels from lib/plan-features.
 *
 * Currency choices are the currencies a checkout can complete, from
 * GET /api/capabilities: one is a fixed chip, two are a choice, and none shows
 * the deployment's default as list prices. The other currency's list price is
 * always shown under each figure, so a buyer is never quoted only in a
 * currency they did not pick. A signed-in workspace's choice is stored (the
 * value a later checkout charges) unless a payment has locked it.
 *
 * Both choices live in the URL, so a link to "annual in USD" is shareable.
 * Figures are keyed by value: a switch is visibly a change, not a reflow.
 */

import { useId, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { formatMajor, formatMinor } from "@/lib/money";
import { fleetIsMonthlyOnly, fleetMinimumQuantity, fleetMinimumTotalMinor, fleetUnitMinor } from "@/lib/fleet-pricing";
import {
  addedFeatures,
  annualSavingMinor,
  catalogMonthsSaved,
  isFree,
  planFeatureLabel,
  RECOMMENDED_TIER,
  soldFeatures,
} from "@/lib/plan-features";
import { setBillingCurrency } from "@/lib/ops-client";
import type { PlanDefinition, PlanPriceMinor } from "@/lib/types";
import { ButtonLink } from "@/components/ui/button";
import { Check } from "@/components/ui/icons";

export type PricingCurrency = "INR" | "USD";
export type PricingInterval = "monthly" | "annual";

const SYMBOL: Record<PricingCurrency, string> = { USD: "$", INR: "₹" };

/** What an agency hands to its clients: the grounds for recommending a plan. */
const CLIENT_FACING = ["portal.client", "reports.forensicNamed", "reports.compliancePack", "trust.center"];

/** Row labels stay in view while a narrow screen scrolls the plan columns. */
const ROW_HEAD = "sticky left-0 z-[1] bg-paper py-2.5 pr-4 font-medium text-fg-2";

function shown(price: PlanPriceMinor, interval: PricingInterval): number {
  return interval === "monthly" ? price.monthlyMinor : price.annualMinor;
}

export function PricingBoard({
  plans,
  chargeable,
  initialCurrency,
  initialInterval,
  persist,
  signedIn,
  currentTier,
  checkoutNote,
  between,
}: {
  plans: PlanDefinition[];
  chargeable: PricingCurrency[];
  initialCurrency: PricingCurrency;
  initialInterval: PricingInterval;
  /** A signed-in workspace whose currency can be stored. */
  persist: { organizationId: string; locked: boolean; reason: string | null } | null;
  signedIn: boolean;
  currentTier: string | null;
  checkoutNote: string;
  /** Server-rendered notes between the plans and the comparison. */
  between?: ReactNode;
}) {
  const router = useRouter();
  const [currency, setCurrency] = useState<PricingCurrency>(initialCurrency);
  const [interval, setInterval] = useState<PricingInterval>(initialInterval);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = persist?.locked ?? false;
  const ladderPlans = plans.filter((plan) => plan.pricing !== "per_domain");
  const perDomainPlan = plans.find((plan) => plan.pricing === "per_domain") ?? null;
  const months = catalogMonthsSaved(ladderPlans);
  const other: PricingCurrency = currency === "USD" ? "INR" : "USD";
  const free = ladderPlans.find((p) => isFree(p.prices.USD) && isFree(p.prices.INR)) ?? null;

  function syncUrl(next: { currency?: PricingCurrency; interval?: PricingInterval }) {
    const params = new URLSearchParams(window.location.search);
    params.set("currency", next.currency ?? currency);
    params.set("interval", next.interval ?? interval);
    window.history.replaceState(null, "", `/pricing?${params.toString()}`);
  }

  function chooseInterval(next: PricingInterval) {
    setInterval(next);
    syncUrl({ interval: next });
  }

  async function chooseCurrency(next: PricingCurrency) {
    if (next === currency || locked || busy) return;
    setError(null);
    if (!persist) {
      setCurrency(next);
      syncUrl({ currency: next });
      return;
    }
    setBusy(true);
    const res = await setBillingCurrency(persist.organizationId, next);
    setBusy(false);
    if (!res.ok) {
      // A payment exists: re-read, so the lock and its reason render.
      if (res.error.code === "CURRENCY_LOCKED") router.refresh();
      else setError(res.error.message ?? "The currency could not be changed.");
      return;
    }
    setCurrency(next);
    syncUrl({ currency: next });
    router.refresh();
  }

  const features = soldFeatures(ladderPlans);

  // The reason for the recommendation, read from the catalog: what the
  // recommended plan is the first to carry among the things handed to clients.
  // No reason in the data, no sentence.
  const recommendation = (() => {
    const at = ladderPlans.findIndex((p) => p.tier === RECOMMENDED_TIER);
    if (at < 0) return null;
    const added = new Set(addedFeatures(ladderPlans[at], at > 0 ? ladderPlans[at - 1] : null));
    // Mid-sentence, so lower-case the label unless it is a product name.
    const reasons = CLIENT_FACING.filter((k) => added.has(k)).map((k) => {
      const label = planFeatureLabel(k);
      return k === "trust.center" ? label : label.charAt(0).toLowerCase() + label.slice(1);
    });
    if (reasons.length === 0) return null;
    // Serial comma: some labels carry their own "and" ("client portal and client
    // approvals"), so the last item needs the comma to read as a separate item.
    const list =
      reasons.length === 1
        ? reasons[0]
        : reasons.length === 2
          ? `${reasons[0]}, and ${reasons[1]}`
          : `${reasons.slice(0, -1).join(", ")}, and ${reasons[reasons.length - 1]}`;
    return { label: ladderPlans[at].label, reasons: list };
  })();

  return (
    <div className="flex flex-col gap-12">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div data-testid="pricing-currency" className="flex items-center gap-2">
            <span className="text-meta font-semibold text-fg-2">Currency</span>
            {chargeable.length > 1 ? (
              <Toggle
                label="Currency"
                value={currency}
                disabled={locked || busy}
                onChange={chooseCurrency}
                options={chargeable.map((c) => ({ value: c, label: `${SYMBOL[c]} ${c}`, testId: `pricing-currency-${c}` }))}
              />
            ) : (
              <span
                data-testid={`pricing-currency-${currency}`}
                className="inline-flex h-8 items-center rounded-ctl border border-rule-2 bg-paper-2 px-3 text-ui font-semibold text-fg"
              >
                {SYMBOL[currency]} {currency}
              </span>
            )}
          </div>
          <div data-testid="pricing-interval" className="flex items-center gap-2">
            <span className="text-meta font-semibold text-fg-2">Billing</span>
            <Toggle
              label="Billing period"
              value={interval}
              onChange={chooseInterval}
              options={[
                { value: "monthly", label: "Monthly", testId: "pricing-interval-MONTHLY" },
                {
                  value: "annual",
                  label: (
                    <>
                      Annual
                      {months ? <span className="ml-1.5 font-medium text-ok">save {months} months</span> : null}
                    </>
                  ),
                  testId: "pricing-interval-ANNUAL",
                },
              ]}
            />
          </div>
        </div>
        <p className="text-meta text-fg-3">{checkoutNote}</p>
        {locked ? (
          <p role="status" data-testid="pricing-currency-locked" className="text-meta font-semibold text-warn">
            {persist?.reason ?? "The currency is fixed because this workspace has a payment."}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-meta font-semibold text-fail">
            {error}
          </p>
        ) : null}
      </div>

      <div className="hb-stagger grid border-t border-rule sm:grid-cols-2 xl:grid-cols-4">
        {ladderPlans.map((plan, i) => {
          const price = plan.prices[currency];
          const otherPrice = plan.prices[other];
          const freePlan = isFree(price);
          const previous = i > 0 ? ladderPlans[i - 1] : null;
          const added = addedFeatures(plan, previous);
          const saving = annualSavingMinor(price);
          const current = currentTier === plan.tier;
          const recommended = plan.tier === RECOMMENDED_TIER;
          const key = `${currency}-${interval}`;
          return (
            <article
              key={plan.tier}
              data-plan={plan.tier}
              data-recommended={recommended || undefined}
              aria-labelledby={`plan-${plan.tier}`}
              style={{ "--i": i } as React.CSSProperties}
              className={clsx(
                "relative row-span-6 grid grid-rows-subgrid gap-y-0 border-b border-rule px-0 pb-7 pt-6 sm:px-5",
                i > 0 && "sm:border-l",
                i === 2 && "sm:border-l-0 xl:border-l",
              )}
            >
              {/* The recommendation is structural: one accent hairline laid
                  over the top rule of this card only. No fill, no shadow,
                  nothing that moves the layout or the price. */}
              {recommended ? <span aria-hidden className="absolute inset-x-0 -top-px h-px bg-act" /> : null}
              <header>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h2 id={`plan-${plan.tier}`} className="wide text-[22px] font-bold tracking-[-0.02em] text-fg">
                    {plan.label}
                  </h2>
                  {current ? (
                    <span className="text-meta font-semibold text-act">Your plan</span>
                  ) : recommended ? (
                    <span data-testid="plan-recommended" className="relative pb-[3px] text-meta font-semibold text-act">
                      Recommended for agencies
                      <span aria-hidden className="hb-rule-draw absolute inset-x-0 bottom-0 h-px bg-act" />
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-ui text-fg-2">{plan.descriptor}</p>
              </header>

              <div className="mt-5 flex items-baseline gap-0.5 text-fg">
                {freePlan ? (
                  <span key={key} data-testid={`plan-price-${plan.tier}`} className="hb-figure display text-[46px] leading-none">
                    Free
                  </span>
                ) : (
                  <span key={key} className="tnum flex items-baseline [animation:hb-rise_220ms_ease-out_both]">
                    <span className="mr-0.5 text-[26px] font-semibold text-fg-2">{SYMBOL[currency]}</span>
                    <span data-testid={`plan-price-${plan.tier}`} className="display text-[46px] leading-none">
                      {formatMajor(shown(price, interval), currency)}
                    </span>
                  </span>
                )}
              </div>

              <div key={`${key}-sub`} className="mt-2 flex flex-col gap-0.5 text-meta text-fg-2 [animation:hb-rise_220ms_ease-out_both]">
                {freePlan ? (
                  <>
                    <span className="font-semibold text-fg">No card needed</span>
                    <span>Every account starts here.</span>
                  </>
                ) : interval === "monthly" ? (
                  <>
                    <span className="font-semibold text-fg">per month</span>
                    <span>
                      or <span className="tnum">{formatMinor(price.annualMinor, currency)}</span> a year
                      {saving > 0 ? <> (saves <span className="tnum">{formatMinor(saving, currency)}</span>)</> : null}
                    </span>
                    <span className="text-fg-3">
                      List price in {other}: <span className="tnum">{formatMinor(otherPrice.monthlyMinor, other)}</span> a month
                    </span>
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-fg">per year, paid once</span>
                    <span className={saving > 0 ? "text-ok" : undefined}>
                      {saving > 0 ? (
                        <>
                          Saves <span className="tnum">{formatMinor(saving, currency)}</span> on 12 monthly payments
                        </>
                      ) : (
                        "Same as paying monthly"
                      )}
                    </span>
                    <span className="text-fg-3">
                      List price in {other}: <span className="tnum">{formatMinor(otherPrice.annualMinor, other)}</span> a year
                    </span>
                  </>
                )}
              </div>

              <div className="mt-5">
                <ButtonLink
                  href={signedIn ? "/billing" : "/sign-up"}
                  variant={!signedIn && freePlan ? "primary" : "secondary"}
                  className="w-full justify-center"
                  data-testid={`plan-cta-${plan.tier}`}
                >
                  {current ? "Manage on Billing" : !signedIn && freePlan ? "Start free" : `Choose ${plan.label}`}
                </ButtonLink>
              </div>

              <dl className="mt-6 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-t border-rule pt-3 text-ui">
                {limitRows(plan).map(([k, v]) => (
                  <div key={k} className="col-span-2 grid grid-cols-subgrid py-0.5">
                    <dt className="text-fg-2">{k}</dt>
                    <dd className="tnum text-right font-semibold text-fg">{v}</dd>
                  </div>
                ))}
              </dl>

              <div className="mt-5">
                {previous ? (
                  <p className="text-meta font-semibold text-fg-2">
                    Everything in {previous.label}, plus
                  </p>
                ) : (
                  <p className="text-meta font-semibold text-fg-2">Includes</p>
                )}
                <ul className="mt-2 flex flex-col gap-1.5 text-ui text-fg">
                  {added.map((k) => (
                    <li key={k} className="grid grid-cols-[16px_minmax(0,1fr)] gap-1.5">
                      <Check size={13} className="mt-[3px] text-ok" aria-hidden />
                      <span>{planFeatureLabel(k)}</span>
                    </li>
                  ))}
                  {added.length === 0 && previous ? (
                    <li className="text-fg-3">Higher limits; no added features.</li>
                  ) : null}
                </ul>
              </div>
            </article>
          );
        })}
      </div>

      {perDomainPlan ? (
        <FleetCard
          plan={perDomainPlan}
          currency={currency}
          interval={interval}
          signedIn={signedIn}
          isCurrent={currentTier === perDomainPlan.tier}
          baseLabel={ladderPlans.find((plan) => plan.tier === "HARBOR")?.label ?? "Harbor"}
        />
      ) : null}

      {(free && !signedIn) || recommendation ? (
        <div className="-mt-6 flex flex-col gap-1 text-meta text-fg-3">
          {recommendation ? (
            <p>
              <span className="font-semibold text-fg-2">Why we recommend {recommendation.label} to agencies:</span> it is the
              first plan with what you hand to a client: {recommendation.reasons}.
            </p>
          ) : null}
          {free && !signedIn ? (
            <p>Every account starts on {free.label}. Move to another plan from Billing whenever the client book needs it.</p>
          ) : null}
        </div>
      ) : null}

      {between}

      <section aria-labelledby="compare-head" className="flex flex-col gap-4">
        <div>
          <h2 id="compare-head" className="wide text-h2 font-bold tracking-[-0.02em] text-fg">
            Compare everything
          </h2>
          <p className="mt-1 text-ui text-fg-2">
            Every limit and every feature, on the four plans above. Fleet is priced per active domain and has the same
            features as Harbor; its limits are on its card. Clients and active domains are counted across every workspace
            an account owns; team members are counted per workspace. Prices in {currency},{" "}
            {interval === "monthly" ? "per month" : "per year"}.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-ui">
            <thead>
              <tr className="border-b border-rule-2">
                <th scope="col" className="sticky left-0 z-[1] w-[34%] bg-paper py-2.5 pr-4">
                  <span className="sr-only">Plan detail</span>
                </th>
                {ladderPlans.map((p) => (
                  <th key={p.tier} scope="col" className="px-3 py-2.5 font-bold text-fg">
                    {p.label}
                    {currentTier === p.tier ? <span className="ml-1.5 text-meta font-semibold text-act">yours</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-rule">
                <th scope="row" className={ROW_HEAD}>
                  Price
                </th>
                {ladderPlans.map((p) => (
                  <td key={p.tier} className="tnum px-3 py-2.5 font-semibold text-fg">
                    <span key={`${currency}-${interval}`} className="hb-figure">
                      {isFree(p.prices[currency]) ? "Free" : formatMinor(shown(p.prices[currency], interval), currency)}
                    </span>
                  </td>
                ))}
              </tr>
              <GroupRow label="Limits" span={ladderPlans.length + 1} />
              {limitRows(ladderPlans[0] ?? null, "table").map(([label], row) => (
                <tr key={label} className="border-b border-rule">
                  <th scope="row" className={ROW_HEAD}>
                    {label}
                  </th>
                  {ladderPlans.map((p) => (
                    <td key={p.tier} className="tnum px-3 py-2.5 text-fg">
                      {limitRows(p, "table")[row]?.[1]}
                    </td>
                  ))}
                </tr>
              ))}
              <GroupRow label="Features" span={ladderPlans.length + 1} />
              {features.map((k) => (
                <tr key={k} className="border-b border-rule">
                  <th scope="row" className={ROW_HEAD}>
                    {planFeatureLabel(k)}
                  </th>
                  {ladderPlans.map((p) => {
                    const on = p.features[k as keyof PlanDefinition["features"]] === true;
                    return (
                      <td key={p.tier} className="px-3 py-2.5">
                        {on ? (
                          <span className="text-ok">
                            <Check size={14} />
                            <span className="sr-only">Included</span>
                          </span>
                        ) : (
                          <span className="text-fg-4">
                            <span aria-hidden>–</span>
                            <span className="sr-only">Not included</span>
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/**
 * A plan's limits as label and value, in one order for the cards, the table and
 * the Fleet card. The prospect allowance is a monthly limit like the others and
 * was published nowhere; a plan without the feature reads as a dash, not 0.
 */
function limitRows(plan: PlanDefinition | null, where: "card" | "table" = "card"): Array<[string, string]> {
  if (!plan) return [];
  const prospects = plan.maxProspectReportsPerMonth;
  return [
    ["Clients", plan.maxClients.toLocaleString("en-GB")],
    ["Active domains", plan.maxActiveDomains.toLocaleString("en-GB")],
    ["Team members", plan.maxMembers.toLocaleString("en-GB")],
    [where === "table" ? "Workspaces per account" : "Workspaces", plan.maxWorkspaces.toLocaleString("en-GB")],
    ...(typeof prospects === "number"
      ? ([["Prospect reports a month", prospects > 0 ? prospects.toLocaleString("en-GB") : "–"]] as Array<[string, string]>)
      : []),
  ];
}

function GroupRow({ label, span }: { label: string; span: number }) {
  return (
    <tr>
      <th scope="colgroup" colSpan={span} className="legend sticky left-0 pb-1.5 pt-5 text-left">
        {label}
      </th>
    </tr>
  );
}

/**
 * The per-domain plan, below the ladder rather than a fifth column.
 *
 * Its unit price is not comparable with a flat monthly price, and putting it in
 * the grid would invite exactly that comparison. The minimum is stated with the
 * total it produces, because "$2" alone reads as the monthly bill.
 */
function FleetCard({
  plan,
  currency,
  interval,
  signedIn,
  isCurrent,
  baseLabel,
}: {
  plan: PlanDefinition;
  currency: PricingCurrency;
  interval: PricingInterval;
  signedIn: boolean;
  isCurrent: boolean;
  baseLabel: string;
}) {
  const unit = fleetUnitMinor(plan, currency);
  const minimum = fleetMinimumQuantity(plan);
  const minimumTotal = fleetMinimumTotalMinor(plan, currency);
  const monthlyOnly = fleetIsMonthlyOnly(plan);

  return (
    <article
      data-plan-per-domain={plan.tier}
      aria-labelledby={`plan-${plan.tier}`}
      className="grid gap-x-10 gap-y-5 border-y border-rule bg-paper-2/50 px-0 py-7 sm:px-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)_minmax(0,0.8fr)] lg:items-start"
    >
      <header>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id={`plan-${plan.tier}`} className="wide text-[24px] font-bold tracking-[-0.02em] text-fg">
            {plan.label}
          </h2>
          {isCurrent ? <span className="text-meta font-semibold text-act">Your plan</span> : null}
          <span data-testid="fleet-minimum-label" className="text-meta font-semibold text-fg-3">
            Minimum {minimum} domains
          </span>
        </div>
        <p className="mt-1.5 max-w-[56ch] text-ui text-fg-2">{plan.descriptor}</p>
        <p className="mt-2 text-meta text-fg-3">Everything in {baseLabel}.</p>
        {/* Fleet's limits were in the catalog and nowhere on the page. */}
        <dl data-testid="fleet-limits" className="mt-3 grid max-w-[22rem] grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-meta">
          {limitRows(plan).map(([k, v]) => (
            <div key={k} className="col-span-2 grid grid-cols-subgrid py-0.5">
              <dt className="text-fg-2">{k}</dt>
              <dd className="tnum text-right font-semibold text-fg">{v}</dd>
            </div>
          ))}
        </dl>
      </header>

      <div className="flex flex-col gap-1">
        <p className="flex flex-wrap items-baseline gap-x-1.5 text-fg">
          <span className="text-[22px] font-semibold text-fg-2">{SYMBOL[currency]}</span>
          <span data-testid="fleet-price" className="tnum display text-[38px] leading-none">
            {formatMajor(unit, currency)}
          </span>
          <span className="text-meta font-semibold text-fg-2">per active domain a month</span>
        </p>
        <p data-testid="fleet-minimum" className="text-meta text-fg-2">
          At least <span className="tnum">{minimum}</span> domains are billed, so the smallest bill is{" "}
          <span className="tnum">{formatMinor(minimumTotal, currency)}</span> a month.
        </p>
        <p className="text-meta font-semibold text-fg-2">
          {monthlyOnly ? (interval === "annual" ? "Billed monthly only" : "Billed monthly") : "Billed per interval"}
        </p>
        <p className="text-meta text-fg-3">
          Billed at the active-domain count measured before each period starts. No proration.
        </p>
      </div>

      <div className="flex flex-col items-start gap-2">
        <ButtonLink
          href={signedIn ? "/billing" : "/sign-up"}
          variant="secondary"
          className="w-full justify-center sm:w-auto"
          data-testid="fleet-cta"
        >
          {isCurrent ? "Manage on Billing" : `Choose ${plan.label}`}
        </ButtonLink>
        <p className="text-meta text-fg-2">
          Need white label or SSO for more than 300 domains?{" "}
          <a href="/support" className="link font-semibold">
            Contact us
          </a>
          .
        </p>
      </div>
    </article>
  );
}

/** Two to four exclusive choices: native radios, so arrow keys work. */
function Toggle<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: ReactNode; testId: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset disabled={disabled} className="inline-flex rounded-ctl border border-rule-2 bg-paper-3 p-[2px] disabled:opacity-60">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <label
            key={o.value}
            data-testid={o.testId}
            className={clsx(
              "relative inline-flex h-7 cursor-pointer items-center rounded-[2px] px-3 text-ui font-semibold transition-colors duration-100",
              "has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-act",
              "has-[:disabled]:cursor-not-allowed",
              on ? "bg-paper-2 text-fg shadow-[0_0_0_1px_var(--color-rule-2)]" : "text-fg-3 hover:text-fg",
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={on}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {o.label}
          </label>
        );
      })}
    </fieldset>
  );
}
