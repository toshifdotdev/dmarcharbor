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
 * Drawn in the Routes language (pricing.module.css): the plans are stations
 * on one line, each stop carrying everything before it, and each station is
 * labelled with the size of client book it holds, because that is the
 * question a buyer arrives with. Fleet is a second line whose stops are its
 * volume bands. The comparison is a line diagram: a feature's line is built
 * from the first plan that carries it.
 *
 * Currency choices are the currencies a checkout can complete, from
 * GET /api/capabilities: one is a fixed chip, two are a choice, and none shows
 * the deployment's default as list prices. The other currency's list price is
 * always shown under each figure, so a buyer is never quoted only in a
 * currency they did not pick. A signed-in workspace's choice is stored (the
 * value a later checkout charges) unless a payment has locked it.
 *
 * Both choices live in the URL, so a link to "annual in USD" is shareable.
 * Figures are keyed by value, so a switch replaces the figure rather than
 * editing it in place.
 */

import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { formatMajor, formatMinor } from "@/lib/money";
import { fleetBandRows, fleetIsMonthlyOnly, fleetMinimumQuantity, fleetMinimumTotalMinor, fleetUnitMinor } from "@/lib/fleet-pricing";
import {
  addedFeatures,
  limitLabel,
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
import { Reveal } from "./landing-motion";
import s from "./pricing.module.css";

export type PricingCurrency = "INR" | "USD";
export type PricingInterval = "monthly" | "annual";

const SYMBOL: Record<PricingCurrency, string> = { USD: "$", INR: "₹" };

/** What an agency hands to its clients: the grounds for recommending a plan. */
const CLIENT_FACING = ["portal.client", "reports.forensicNamed", "reports.compliancePack", "trust.center"];

function shown(price: PlanPriceMinor, interval: PricingInterval): number {
  return interval === "monthly" ? price.monthlyMinor : price.annualMinor;
}

const count = (n: number) => n.toLocaleString("en-GB");

/** The size of client book a plan holds, as the station's label says it. */
function capacity(plan: PlanDefinition): string {
  const clients = `${count(plan.maxClients)} ${plan.maxClients === 1 ? "client" : "clients"}`;
  const domains = `${count(plan.maxActiveDomains)} active ${plan.maxActiveDomains === 1 ? "domain" : "domains"}`;
  return `${clients} · ${domains}`;
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

  const key = `${currency}-${interval}`;

  return (
    <div>
      <div>
        <div className={s.controls}>
          <div data-testid="pricing-currency" className={s.control}>
            <span className={s.controlLabel}>Currency</span>
            {chargeable.length > 1 ? (
              <Toggle
                label="Currency"
                value={currency}
                disabled={locked || busy}
                onChange={chooseCurrency}
                options={chargeable.map((c) => ({ value: c, label: `${SYMBOL[c]} ${c}`, testId: `pricing-currency-${c}` }))}
              />
            ) : (
              <span data-testid={`pricing-currency-${currency}`} className={s.chip}>
                {SYMBOL[currency]} {currency}
              </span>
            )}
          </div>
          <div data-testid="pricing-interval" className={s.control}>
            <span className={s.controlLabel}>Billing</span>
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
                      {months ? <span className={s.saving}>save {months} months</span> : null}
                    </>
                  ),
                  testId: "pricing-interval-ANNUAL",
                },
              ]}
            />
          </div>
        </div>
        <p className={s.note}>{checkoutNote}</p>
        {locked ? (
          <p role="status" data-testid="pricing-currency-locked" className={s.locked}>
            {persist?.reason ?? "The currency is fixed because this workspace has a payment."}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className={s.error}>
            {error}
          </p>
        ) : null}
      </div>

      <Reveal className={s.plans}>
        {ladderPlans.map((plan, i) => {
          const price = plan.prices[currency];
          const otherPrice = plan.prices[other];
          const freePlan = isFree(price);
          const previous = i > 0 ? ladderPlans[i - 1] : null;
          const added = addedFeatures(plan, previous);
          const saving = annualSavingMinor(price);
          const current = currentTier === plan.tier;
          const recommended = plan.tier === RECOMMENDED_TIER;
          // Clients and active domains are the station's label; the rest of
          // the limits are listed under the button.
          const otherLimits = limitRows(plan).slice(2);
          return (
            <article
              key={plan.tier}
              data-plan={plan.tier}
              data-recommended={recommended || undefined}
              aria-labelledby={`plan-${plan.tier}`}
              style={{ "--i": i } as CSSProperties}
              className={s.plan}
            >
              <div>
                <span aria-hidden className={s.station} data-here={current ? "" : undefined} />
                <h2 id={`plan-${plan.tier}`} className={s.name}>
                  {plan.label}
                </h2>
                <p className={s.capacity}>{capacity(plan)}</p>
                {current ? (
                  <p className={s.marker}>Your plan</p>
                ) : recommended ? (
                  <p data-testid="plan-recommended" className={s.marker}>
                    Recommended for agencies
                  </p>
                ) : null}
              </div>

              <p className={s.desc}>{plan.descriptor}</p>

              <div className={s.figure}>
                {freePlan ? (
                  <span key={key} data-testid={`plan-price-${plan.tier}`} className={s.amount}>
                    Free
                  </span>
                ) : (
                  <span key={key} className={s.amountRow}>
                    <span className={s.symbol}>{SYMBOL[currency]}</span>
                    <span data-testid={`plan-price-${plan.tier}`} className={s.amount}>
                      {formatMajor(shown(price, interval), currency)}
                    </span>
                  </span>
                )}
              </div>

              <div key={`${key}-sub`} className={s.terms}>
                {freePlan ? (
                  <>
                    <b>No card needed</b>
                    <span>Every account starts here.</span>
                  </>
                ) : interval === "monthly" ? (
                  <>
                    <b>per month</b>
                    <span>
                      or <span className="tnum">{formatMinor(price.annualMinor, currency)}</span> a year
                      {saving > 0 ? <> (saves <span className="tnum">{formatMinor(saving, currency)}</span>)</> : null}
                    </span>
                    <span className={s.dim}>
                      List price in {other}: <span className="tnum">{formatMinor(otherPrice.monthlyMinor, other)}</span> a month
                    </span>
                  </>
                ) : (
                  <>
                    <b>per year, paid once</b>
                    <span>
                      {saving > 0 ? (
                        <>
                          Saves <span className="tnum">{formatMinor(saving, currency)}</span> on 12 monthly payments
                        </>
                      ) : (
                        "Same as paying monthly"
                      )}
                    </span>
                    <span className={s.dim}>
                      List price in {other}: <span className="tnum">{formatMinor(otherPrice.annualMinor, other)}</span> a year
                    </span>
                  </>
                )}
              </div>

              <div className={s.cta}>
                <ButtonLink
                  href={signedIn ? "/billing" : "/sign-up"}
                  variant={!signedIn && freePlan ? "primary" : "secondary"}
                  size="lg"
                  data-testid={`plan-cta-${plan.tier}`}
                >
                  {current ? "Manage on Billing" : !signedIn && freePlan ? "Start free" : `Choose ${plan.label}`}
                </ButtonLink>
              </div>

              <dl className={s.limits}>
                {otherLimits.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>

              <div className={s.adds}>
                <p className={s.addsHead}>{previous ? `Everything in ${previous.label}, plus` : "Includes"}</p>
                <ul className={s.addsList}>
                  {added.map((k) => (
                    <li key={k}>{planFeatureLabel(k)}</li>
                  ))}
                  {added.length === 0 && previous ? <li data-none="">Higher limits; no added features.</li> : null}
                </ul>
              </div>
            </article>
          );
        })}
      </Reveal>

      {(free && !signedIn) || recommendation ? (
        <div className={s.notes}>
          {recommendation ? (
            <p>
              <b>Why we recommend {recommendation.label} to agencies:</b> it is the first plan with what you hand to a
              client: {recommendation.reasons}.
            </p>
          ) : null}
          {free && !signedIn ? (
            <p>Every account starts on {free.label}. Move to another plan from Billing whenever the client book needs it.</p>
          ) : null}
        </div>
      ) : null}

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

      {between}

      <section aria-labelledby="compare-head" className={s.section}>
        <h2 id="compare-head" className={s.h2}>
          Compare everything
        </h2>
        <p className={s.compareNote}>
          Every limit and every feature, on the four plans above. Fleet is priced per active domain and has the same
          features as Harbor; its limits are on its card. Clients and active domains are counted across every workspace
          an account owns; team members are counted per workspace. Prices in {currency},{" "}
          {interval === "monthly" ? "per month" : "per year"}.
        </p>
        <div className={s.legend} aria-hidden>
          <span>
            <span className={s.legendLine}>
              <span />
            </span>
            On the plan
          </span>
          <span>
            <span className={s.legendLine} data-off="">
              <span />
            </span>
            Not on the plan
          </span>
        </div>
        <div className={s.scroll}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Plan detail</span>
                </th>
                {ladderPlans.map((p) => (
                  <th key={p.tier} scope="col">
                    {p.label}
                    {currentTier === p.tier ? <span className={s.yours}>yours</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" className={s.rowHead}>
                  Price
                </th>
                {ladderPlans.map((p) => (
                  <td key={p.tier} className={`${s.value} ${s.price}`}>
                    <span key={key}>
                      {isFree(p.prices[currency]) ? "Free" : formatMinor(shown(p.prices[currency], interval), currency)}
                    </span>
                  </td>
                ))}
              </tr>
              <GroupRow label="Limits" span={ladderPlans.length + 1} />
              {limitRows(ladderPlans[0] ?? null, "table").map(([label], row) => (
                <tr key={label}>
                  <th scope="row" className={s.rowHead}>
                    {label}
                  </th>
                  {ladderPlans.map((p) => (
                    <td key={p.tier} className={s.value}>
                      {limitRows(p, "table")[row]?.[1]}
                    </td>
                  ))}
                </tr>
              ))}
              <GroupRow label="Features" span={ladderPlans.length + 1} />
              {features.map((k) => {
                const on = ladderPlans.map((p) => p.features[k as keyof PlanDefinition["features"]] === true);
                return (
                  <tr key={k}>
                    <th scope="row" className={s.rowHead}>
                      {planFeatureLabel(k)}
                    </th>
                    {ladderPlans.map((p, i) => (
                      <td
                        key={p.tier}
                        className={s.cell}
                        data-l={i === 0 ? "none" : on[i - 1] && on[i] ? "on" : "off"}
                        data-r={i === ladderPlans.length - 1 ? "none" : on[i] && on[i + 1] ? "on" : "off"}
                      >
                        <span aria-hidden className={s.stop} data-on={on[i] ? "" : undefined} />
                        <span className="sr-only">{on[i] ? "Included" : "Not included"}</span>
                      </td>
                    ))}
                  </tr>
                );
              })}
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
    ["Team members", limitLabel(plan.maxMembers)],
    [where === "table" ? "Workspaces per account" : "Workspaces", plan.maxWorkspaces.toLocaleString("en-GB")],
    ...(typeof prospects === "number"
      ? ([["Prospect reports a month", prospects > 0 ? prospects.toLocaleString("en-GB") : "–"]] as Array<[string, string]>)
      : []),
  ];
}

function GroupRow({ label, span }: { label: string; span: number }) {
  return (
    <tr>
      <th scope="colgroup" colSpan={span} className={s.group}>
        {label}
      </th>
    </tr>
  );
}

/**
 * The per-domain plan, below the ladder rather than a fifth station.
 *
 * Its unit price is not comparable with a flat monthly price, and putting it on
 * the same line would invite exactly that comparison. So it is its own line:
 * the stops are its volume bands, and the price per domain falls as the line
 * runs on. The minimum is stated with the total it produces, because "$2"
 * alone reads as the monthly bill.
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
  const bandRows = fleetBandRows(plan, currency);

  return (
    <article data-plan-per-domain={plan.tier} aria-labelledby={`plan-${plan.tier}`} className={s.fleet}>
      <div>
        <div className={s.fleetHead}>
          <h2 id={`plan-${plan.tier}`} className={s.fleetName}>
            {plan.label}
          </h2>
          {isCurrent ? <span className={s.fleetMinimum}>Your plan</span> : null}
          <span data-testid="fleet-minimum-label" className={s.fleetMinimum}>
            Minimum {minimum} domains
          </span>
        </div>
        <p className={s.fleetDesc}>{plan.descriptor}</p>
        <p className={s.fleetBase}>Everything in {baseLabel}.</p>
        {/* Fleet's limits were in the catalog and nowhere on the page. */}
        <dl data-testid="fleet-limits" className={`${s.limits} ${s.fleetLimits}`}>
          {limitRows(plan).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div>
        <p className={s.fleetPrice}>
          <span className={s.amountRow}>
            <span className={s.symbol}>{SYMBOL[currency]}</span>
            <span data-testid="fleet-price" className={s.amount}>
              {formatMajor(unit, currency)}
            </span>
          </span>
          <span className={s.fleetPer}>
            per active domain a month{bandRows.length > 1 ? ", falling with volume" : ""}
          </span>
        </p>
        <p data-testid="fleet-minimum" className={s.fleetMinLine}>
          At least <span className="tnum">{minimum}</span> domains are billed, so the smallest bill is{" "}
          <span className="tnum">{formatMinor(minimumTotal, currency)}</span> a month.
        </p>

        {/* The price per domain falls with volume. Each band's minimum is shown
            as what that monthly amount covers, so a flat stretch reads as an
            allowance rather than as being billed for domains you do not have. */}
        <Reveal className={s.bandsWrap}>
          <ol
            data-testid="fleet-bands"
            aria-label="Price per active domain by volume"
            className={s.bands}
            style={{ "--bands": bandRows.length } as CSSProperties}
          >
            {bandRows.map((row, index) => (
              <li key={row.upTo} className={s.band} style={{ "--i": index } as CSSProperties}>
                <p className={s.bandRange}>
                  {index === 0 ? `Up to ${count(row.upTo)}` : `${count(row.from)} to ${count(row.upTo)}`}
                </p>
                <p className={s.bandUnit}>{formatMinor(row.unitMinor, currency)} each</p>
                <p className={s.bandMin}>
                  <span className="whitespace-nowrap">{formatMinor(row.minimumTotalMinor, currency)}</span>{" "}
                  <span className="whitespace-nowrap">covers up to {count(row.minimum)}</span>
                </p>
              </li>
            ))}
          </ol>
        </Reveal>

        <p className={s.fleetBilling}>
          <b>{monthlyOnly ? (interval === "annual" ? "Billed monthly only" : "Billed monthly") : "Billed per interval"}</b>,
          at the active-domain count measured before each period starts. No proration.
        </p>

        <div className={s.fleetAction}>
          <ButtonLink href={signedIn ? "/billing" : "/sign-up"} variant="secondary" size="lg" data-testid="fleet-cta">
            {isCurrent ? "Manage on Billing" : `Choose ${plan.label}`}
          </ButtonLink>
          <p className={s.fleetSupport}>
            Up to 300 domains, Admiralty includes your own domain and SSO. Need them for more than 300 domains?{" "}
            <a href="/support" className="link font-semibold">
              Contact us
            </a>
            .
          </p>
        </div>
      </div>
    </article>
  );
}

/** Two to four exclusive choices: native radios, so arrow keys work. A pill
 *  track with the chosen option filled, as the shared Segmented control. */
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
    <fieldset disabled={disabled} className={s.track}>
      <legend className="sr-only">{label}</legend>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <label key={o.value} data-testid={o.testId} data-on={on ? "" : undefined} className={s.option}>
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
