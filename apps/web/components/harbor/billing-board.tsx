"use client";

/**
 * billing-board.tsx — how much of the plan is used, and what changing it would
 * change.
 *
 *   Usage       each allowance as a figure against its limit, with a word for
 *               what that leaves ("room for 19 more", "at the limit", "2 over").
 *               No bars: a count and its limit are the whole fact. Members and
 *               workspaces are exact. Clients are exact unless the owner holds
 *               several workspaces (the limit counts across all of them).
 *               Active domains are an upper bound when the API's own count is
 *               missing: a domain only counts while reports arrive for it, or
 *               for a while after it was added.
 *   Plans       every plan from GET /api/plans, as rows on one line: the plan
 *               ladder drawn as a strip map, built (ink) up to the plan this
 *               workspace is on, unbuilt (grey) past it, so "everything in the
 *               plan before, plus" reads as distance along the line. Choosing
 *               a plan opens, inside its row, exactly what would change: what
 *               is gained and lost, each limit before and after (with anything
 *               already over it), when it applies, and how it is paid. Nothing
 *               is sent until the last button in that panel.
 *   Compare     every limit and capability, by plan.
 *
 * Which action a plan offers follows the API:
 *   a subscription exists   PATCH /billing/plan (MOORING is a cancellation)
 *   no subscription         POST /billing/checkout, to the provider's page
 * A refused downgrade (PLAN_CHANGE_OVER_QUOTA) shows the API's overage rows.
 *
 * Test hooks kept: article[data-plan] per plan with a /choose|move/ button,
 * plan-choose-<tier>, plan-decision-<tier>, plan-change-error,
 * overage-row-{quota}, checkout-refund-ack, data-usage per allowance.
 */

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { clsx } from "clsx";
import { formatMinor } from "@/lib/money";
import { fleetBill, fleetIsMonthlyOnly, fleetMinimumQuantity, fleetMinimumTotalMinor, fleetUnitMinor } from "@/lib/fleet-pricing";
import {
  addedFeatures,
  catalogMonthsSaved,
  isFree,
  limitLabel,
  planFeatureLabel,
  planLimit,
  soldFeatures,
  UNLISTED_FEATURES,
} from "@/lib/plan-features";
import { changeBillingPlan, startCheckout } from "@/lib/ops-client";
import type { BillingStatus, PlanDefinition, PlanOverageRow } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/choice";
import { Field, Input, Segmented, Select } from "@/components/ui/field";
import { Check } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";

type Interval = "monthly" | "annual";
type Currency = "INR" | "USD";

export interface UsageCount {
  used: number;
  /** False: an upper bound, or counted for this workspace only. */
  exact: boolean;
}
export interface Usage {
  clients: UsageCount | null;
  domains: UsageCount | null;
  members: UsageCount | null;
  workspaces: UsageCount | null;
}

type LimitKey = "maxClients" | "maxActiveDomains" | "maxMembers" | "maxWorkspaces";
const LIMITS: Array<{ key: LimitKey; usage: keyof Usage; label: string; one: string; many: string }> = [
  { key: "maxClients", usage: "clients", label: "Clients", one: "client", many: "clients" },
  { key: "maxActiveDomains", usage: "domains", label: "Active domains", one: "active domain", many: "active domains" },
  { key: "maxMembers", usage: "members", label: "Team members", one: "member", many: "members" },
  { key: "maxWorkspaces", usage: "workspaces", label: "Workspaces", one: "workspace", many: "workspaces" },
];

const PROVIDER_FOR: Record<Currency, string> = { INR: "Razorpay", USD: "Paddle" };

function features(plan: PlanDefinition): Set<string> {
  return new Set(
    Object.entries(plan.features)
      .filter(([k, on]) => on && !UNLISTED_FEATURES.has(k))
      .map(([k]) => k),
  );
}

function priceOf(plan: PlanDefinition, currency: Currency, interval: Interval, quote?: BillingStatus["perDomainQuote"] | null): string {
  if (plan.pricing === "per_domain") {
    // Priced in the band the measured count falls in, at that band's unit.
    return formatMinor(fleetBill(plan, currency, quote?.activeDomains ?? fleetMinimumQuantity(plan)).totalMinor, currency);
  }
  const p = plan.prices[currency];
  if (isFree(p)) return "Free";
  return formatMinor(interval === "annual" ? p.annualMinor : p.monthlyMinor, currency);
}

export function BillingBoard({
  organizationId,
  plans,
  currentTier,
  pendingTier,
  provider,
  hasSubscription,
  cancelling,
  periodEnd,
  currency,
  currencyLocked,
  currentInterval,
  chargeable,
  capabilitiesKnown,
  usage,
  canChange,
  contact,
  fleetQuote,
}: {
  organizationId: string;
  plans: PlanDefinition[];
  currentTier: string;
  pendingTier: string | null;
  provider: string;
  hasSubscription: boolean;
  cancelling: boolean;
  periodEnd: string | null;
  currency: Currency;
  currencyLocked: boolean;
  currentInterval: Interval;
  chargeable: Currency[];
  capabilitiesKnown: boolean;
  usage: Usage;
  canChange: boolean;
  contact: { name: string; email: string } | null;
  entitlementsKnown: boolean;
  fleetQuote: BillingStatus["perDomainQuote"] | null;
}) {
  const [interval, setInterval] = useState<Interval>(currentInterval);
  const [open, setOpen] = useState<string | null>(null);
  const current = plans.find((p) => p.tier === currentTier) ?? null;
  const ladderPlans = plans.filter((plan) => plan.pricing !== "per_domain");
  const fleetPlan = plans.find((plan) => plan.pricing === "per_domain") ?? null;
  const harbor = plans.find((plan) => plan.tier === "HARBOR") ?? null;
  const months = catalogMonthsSaved(ladderPlans);

  // How far along the ladder this workspace is: to its own plan, or, on the
  // per-domain plan, to the plan whose features it carries.
  const hereIndex = ladderPlans.findIndex((p) => p.tier === currentTier);
  const builtTo = hereIndex >= 0 ? hereIndex : current?.pricing === "per_domain" && harbor ? ladderPlans.findIndex((p) => p.tier === harbor.tier) : -1;

  const shared = {
    current,
    pendingTier,
    organizationId,
    provider,
    hasSubscription,
    cancelling,
    periodEnd,
    currency,
    chargeable,
    capabilitiesKnown,
    usage,
    canChange,
    contact,
    fleetQuote,
  };

  return (
    <div className="flex flex-col gap-12">
      {current ? <UsagePanel plan={current} usage={usage} /> : null}

      <section aria-labelledby="plans-head" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="plans-head" className="text-h2 font-bold tracking-[-0.02em] text-fg">
              Change plan
            </h2>
            <p className="mt-1 max-w-[70ch] text-ui text-fg-2">
              Each plan carries everything in the one before it. Choose one to see exactly what would change before anything
              is sent. Prices in {currency}
              {currencyLocked ? ", the currency this workspace is billed in" : ""}.
            </p>
          </div>
          <Segmented
            label="Billing period"
            size="sm"
            value={interval}
            onChange={setInterval}
            options={[
              { value: "monthly", label: "Monthly" },
              { value: "annual", label: months ? `Annual, ${months} months free` : "Annual" },
            ]}
          />
        </div>

        <ol aria-label="Plans, smallest first" className="border-t border-fg">
          {ladderPlans.map((plan, i) => (
            <li key={plan.tier}>
              <PlanRow
                {...shared}
                plan={plan}
                previous={i > 0 ? ladderPlans[i - 1] : null}
                isCurrent={plan.tier === currentTier}
                isPending={plan.tier === pendingTier}
                open={open === plan.tier}
                onOpen={() => setOpen(plan.tier)}
                onClose={() => setOpen(null)}
                interval={interval}
                ladder={{
                  above: i > 0 ? (i <= builtTo ? "built" : "unbuilt") : null,
                  below: i < ladderPlans.length - 1 ? (i + 1 <= builtTo ? "built" : "unbuilt") : null,
                  station: i === hereIndex ? "here" : i <= builtTo ? "passed" : "ahead",
                }}
              />
            </li>
          ))}
        </ol>

        {fleetPlan ? (
          <div className="mt-4 flex flex-col gap-2">
            <p className="text-ui font-bold text-fg">
              Priced per domain <span className="font-normal text-fg-3">for larger fleets, with {harbor?.label ?? "Harbor"}&rsquo;s features</span>
            </p>
            <div className="border-t border-fg">
              <PlanRow
                {...shared}
                plan={fleetPlan}
                previous={harbor}
                isCurrent={fleetPlan.tier === currentTier}
                isPending={fleetPlan.tier === pendingTier}
                open={open === fleetPlan.tier}
                onOpen={() => setOpen(fleetPlan.tier)}
                onClose={() => setOpen(null)}
                // Fleet is monthly only, whatever the ladder toggle says.
                interval={fleetIsMonthlyOnly(fleetPlan) ? "monthly" : interval}
                ladder={{ above: null, below: null, station: fleetPlan.tier === currentTier ? "here" : "ahead" }}
              />
            </div>
          </div>
        ) : null}
      </section>

      <Compare plans={ladderPlans} currentTier={currentTier} currency={currency} interval={interval} fleetQuote={fleetQuote} />
    </div>
  );
}

function usageLine(u: UsageCount | null, limit: number, l: (typeof LIMITS)[number]): { text: string; over: boolean; near: boolean } {
  if (!Number.isFinite(limit)) return { text: "No limit on this plan.", over: false, near: false };
  if (!u) return { text: `Up to ${limit} ${limit === 1 ? l.one : l.many}. The current count could not be read.`, over: false, near: false };
  if (l.usage === "domains" && !u.exact) {
    return {
      text: `At most ${u.used} count as active: ${u.used} ${u.used === 1 ? "domain is" : "domains are"} in this workspace.`,
      over: false,
      near: u.used > limit,
    };
  }
  if (l.usage === "clients" && !u.exact) {
    return {
      text: `In this workspace. The limit counts every workspace the owner holds.`,
      over: u.used > limit,
      near: u.used >= limit,
    };
  }
  const left = limit - u.used;
  return {
    text:
      left < 0
        ? `${-left} over the limit. Nothing is removed, but a new one cannot be added until the count is under it.`
        : left === 0
          ? "At the limit: adding another needs a larger plan."
          : `Room for ${left} more.`,
    over: u.used > limit,
    near: u.used >= limit,
  };
}

function UsagePanel({ plan, usage }: { plan: PlanDefinition; usage: Usage }) {
  return (
    <section aria-labelledby="usage-head" className="flex flex-col gap-3">
      <h2 id="usage-head" className="text-h2 font-bold tracking-[-0.02em] text-fg">
        What {plan.label} allows, and what is used
      </h2>
      <dl className="grid border-t border-rule sm:grid-cols-2 xl:grid-cols-4 xl:border-b [&>div]:border-b [&>div]:border-rule [&>div]:py-4 xl:[&>div]:border-b-0 sm:max-xl:[&>div:nth-child(even)]:border-l sm:max-xl:[&>div:nth-child(even)]:pl-5 xl:[&>div+div]:border-l xl:[&>div+div]:pl-5">
        {LIMITS.map((l) => {
          const limit = planLimit(plan[l.key]);
          const u = usage[l.usage];
          const line = usageLine(u, limit, l);
          const tone = line.over ? "text-fail" : line.near ? "text-warn" : "text-fg";
          return (
            <div key={l.key} data-usage={l.usage} className="flex min-w-0 flex-col gap-1 pr-4">
              <dt className="text-ui font-semibold text-fg-2">{l.label}</dt>
              <dd className="flex flex-col gap-1">
                <span className="tnum flex items-baseline gap-1.5">
                  {u ? (
                    <>
                      {l.usage === "domains" && !u.exact ? <span className="text-ui font-medium text-fg-3">up to</span> : null}
                      <span className={clsx("text-[28px] font-semibold leading-none tracking-[-0.02em]", tone)}>{u.used}</span>
                      <span className="text-ui font-medium text-fg-3">of {limitLabel(limit).toLowerCase()}</span>
                    </>
                  ) : (
                    <span className="text-ui font-medium text-fg-3">Limit {limitLabel(limit).toLowerCase()}</span>
                  )}
                </span>
                <span className={clsx("text-meta", line.over ? "font-semibold text-fail" : line.near ? "font-semibold text-warn" : "text-fg-3")}>{line.text}</span>
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="max-w-[90ch] text-meta text-fg-3">
        Clients and active domains are counted across every workspace the owner holds, as the limits are; members are counted
        in this workspace. A domain counts as active while reports arrive for it, and for a while after it is added.
      </p>
    </section>
  );
}

type Action = "current" | "keep" | "change" | "cancel" | "checkout" | "blocked";
type Segment = "built" | "unbuilt" | null;

interface RowProps {
  plan: PlanDefinition;
  previous: PlanDefinition | null;
  current: PlanDefinition | null;
  isCurrent: boolean;
  isPending: boolean;
  pendingTier: string | null;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  organizationId: string;
  provider: string;
  hasSubscription: boolean;
  cancelling: boolean;
  periodEnd: string | null;
  currency: Currency;
  interval: Interval;
  chargeable: Currency[];
  capabilitiesKnown: boolean;
  usage: Usage;
  canChange: boolean;
  contact: { name: string; email: string } | null;
  fleetQuote: BillingStatus["perDomainQuote"] | null;
  /** The plan ladder through this row: the line above and below its station. */
  ladder: { above: Segment; below: Segment; station: "passed" | "here" | "ahead" };
}

/** The station's centre, from the top of the row: level with the plan's name. */
const STATION_Y = 33;

function PlanRow(props: RowProps) {
  const { plan, previous, isCurrent, isPending, pendingTier, open, hasSubscription, cancelling, currency, interval, canChange, ladder } = props;
  const free = isFree(plan.prices[currency]);
  const added = addedFeatures(plan, previous);
  const perDomain = plan.pricing === "per_domain";
  const fleetMinimum = fleetMinimumQuantity(plan);
  const fleetMinimumTotal = fleetMinimumTotalMinor(plan, currency);
  // Recomputed in the currency on screen, in the band the measured count is in.
  const quote = fleetBill(plan, currency, props.fleetQuote?.activeDomains ?? fleetMinimum);
  const quoteQuantity = quote.quantity;
  const quoteTotal = quote.totalMinor;
  const measuredDomains = props.fleetQuote?.activeDomains ?? 0;

  const action: Action = isCurrent
    ? pendingTier && pendingTier !== plan.tier && hasSubscription
      ? "keep"
      : "current"
    : hasSubscription
      ? free
        ? "cancel"
        : "change"
      : free
        ? "blocked"
        : "checkout";

  const verb = action === "checkout" ? `Choose ${plan.label}` : action === "keep" ? `Keep ${plan.label}` : `Move to ${plan.label}`;

  return (
    <article
      data-plan={plan.tier}
      aria-labelledby={`bill-${plan.tier}`}
      aria-current={isCurrent ? "true" : undefined}
      className="relative grid grid-cols-[30px_minmax(0,1fr)] border-b border-rule sm:grid-cols-[40px_minmax(0,1fr)]"
    >
      {/* The ladder: the segment above this station, the station, the segment below. */}
      {ladder.above ? (
        <span
          aria-hidden
          className={clsx("absolute left-[9px] top-0 w-[5px] sm:left-[13px]", ladder.above === "built" ? "bg-fg" : "bg-rule")}
          style={{ height: STATION_Y }}
        />
      ) : null}
      {ladder.below ? (
        <span
          aria-hidden
          className={clsx("absolute bottom-0 left-[9px] w-[5px] sm:left-[13px]", ladder.below === "built" ? "bg-fg" : "bg-rule")}
          style={{ top: STATION_Y }}
        />
      ) : null}
      <span
        aria-hidden
        className={clsx(
          "absolute -translate-y-1/2 rounded-full bg-paper",
          ladder.station === "here" ? "left-[1px] size-[21px] border-[4px] border-fg sm:left-[5px]" : "left-[3.5px] size-4 border-[3px] sm:left-[7.5px]",
          ladder.station === "passed" && "border-fg",
          ladder.station === "ahead" && "border-rule-2",
        )}
        style={{ top: STATION_Y }}
      />

      <div
        className={clsx(
          "col-start-2 grid gap-x-8 gap-y-3 py-5",
          perDomain ? "md:grid-cols-[minmax(0,1fr)_minmax(0,19rem)_minmax(0,11rem)]" : "md:grid-cols-[minmax(0,1fr)_minmax(0,13rem)_minmax(0,11rem)]",
        )}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h3 id={`bill-${plan.tier}`} className="text-[20px] font-bold leading-[26px] tracking-[-0.02em] text-fg">
              {plan.label}
            </h3>
            {isCurrent ? (
              <span className="text-meta font-bold text-fg">Your plan</span>
            ) : isPending ? (
              <span className="text-meta font-bold text-fg">Scheduled</span>
            ) : null}
            <span className="text-ui text-fg-3">{plan.descriptor}</span>
          </div>
          <p className="tnum mt-1 text-meta text-fg-2">
            {LIMITS.map((l) => `${limitLabel(plan[l.key])} ${plan[l.key] === 1 ? l.one : l.many}`).join(" · ")}
            {perDomain ? " · contact us to add more" : ""}
          </p>
          <div className="mt-3">
            <p className="text-meta font-semibold text-fg-2">
              {perDomain ? `Everything in ${previous?.label ?? "Harbor"}` : previous ? `Everything in ${previous.label}, plus` : "Includes"}
            </p>
            {perDomain ? (
              <p className="mt-1 text-ui text-fg-3">Same features as {previous?.label ?? "Harbor"}; the difference is the limits and the per-domain price.</p>
            ) : added.length === 0 && previous ? (
              <p className="mt-1 text-ui text-fg-3">Higher limits; no added features.</p>
            ) : (
              <ul className="mt-1.5 grid gap-x-6 gap-y-1 text-ui text-fg sm:grid-cols-2">
                {added.map((k) => (
                  <li key={k} className="grid grid-cols-[16px_minmax(0,1fr)] gap-1.5">
                    <Check size={13} className="mt-[3px] text-fg" />
                    <span>{planFeatureLabel(k)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="tnum min-w-0">
          {perDomain ? (
            <>
              <p className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="text-[24px] font-semibold leading-none tracking-[-0.02em] text-fg">{formatMinor(fleetUnitMinor(plan, currency), currency)}</span>
                <span className="text-meta text-fg-3">per active domain a month, falling with volume</span>
              </p>
              <p className="mt-1.5 text-meta text-fg-2">
                Minimum {fleetMinimum} domains: <span className="font-semibold text-fg">{formatMinor(fleetMinimumTotal, currency)}</span> a month
              </p>
              <p className="mt-0.5 text-meta text-fg-2">
                {props.fleetQuote && measuredDomains >= fleetMinimum
                  ? `At your current ${measuredDomains} active domains: `
                  : `At the minimum of ${fleetMinimum} domains: `}
                <span className="font-semibold text-fg">{formatMinor(quoteTotal, currency)}</span> a month
                {quoteQuantity > fleetMinimum
                  ? ` at ${formatMinor(quote.unitMinor, currency)} a domain${quoteQuantity > measuredDomains ? `, covering up to ${quoteQuantity}` : ""}`
                  : ""}
              </p>
              <p className="mt-0.5 text-meta text-fg-3">Billed monthly. The count is measured before each period starts; no proration.</p>
            </>
          ) : (
            <p className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="text-[24px] font-semibold leading-none tracking-[-0.02em] text-fg">{priceOf(plan, currency, interval, props.fleetQuote)}</span>
              {free ? null : <span className="text-meta text-fg-3">{interval === "annual" ? "a year" : "a month"}</span>}
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-col items-start gap-1.5 md:items-end md:text-right">
          {open && action !== "current" ? null : action === "current" ? (
            <span className="text-meta text-fg-3">{isCurrent ? "This workspace is on it." : null}</span>
          ) : action === "blocked" ? (
            <p className="text-meta text-fg-3">
              There is no online subscription to cancel. Ask{" "}
              <a href="/support" className="link">
                support
              </a>{" "}
              to change this plan.
            </p>
          ) : action === "cancel" && cancelling ? (
            <p className="text-meta text-fg-3">Already moving to {plan.label} when the period ends.</p>
          ) : (
            <>
              <Button
                variant={action === "keep" ? "primary" : "secondary"}
                onClick={props.onOpen}
                disabled={!canChange}
                data-testid={`plan-choose-${plan.tier}`}
              >
                {verb}
              </Button>
              {!canChange ? <p className="text-meta text-fg-3">Only the workspace owner can change the plan.</p> : null}
            </>
          )}
        </div>

        {open && action !== "current" ? (
          <div className="md:col-span-3">
            <Decision {...props} action={action} verb={verb} />
          </div>
        ) : null}
      </div>
    </article>
  );
}

function Decision(props: RowProps & { action: Action; verb: string }) {
  const router = useRouter();
  const id = useId();
  const { plan, current, action, provider, periodEnd, currency, interval, chargeable, capabilitiesKnown, organizationId, contact } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; overage: PlanOverageRow[] } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [payCurrency, setPayCurrency] = useState<Currency>(chargeable.includes(currency) ? currency : (chargeable[0] ?? currency));
  const [name, setName] = useState(contact?.name ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [taxId, setTaxId] = useState("");
  const [ack, setAck] = useState(false);

  const now = current ? features(current) : new Set<string>();
  const next = features(plan);
  const gains = [...next].filter((k) => !now.has(k));
  const losses = [...now].filter((k) => !next.has(k));
  const down = current ? plan.maxClients < current.maxClients : false;
  const currentLabel = current?.label ?? "the current plan";

  const limitRows = LIMITS.map((l) => {
    const before = current ? planLimit(current[l.key]) : null;
    const after = planLimit(plan[l.key]);
    const u = props.usage[l.usage];
    const over = u ? (u.exact || l.usage === "clients" ? u.used > after : false) : false;
    const maybe = u && !over && l.usage === "domains" ? u.used > after : false;
    return { l, before, after, u, over, maybe };
  });
  const knownOver = limitRows.filter((r) => r.over);

  const timing =
    action === "checkout"
      ? `You pay ${priceOf(plan, payCurrency, interval, props.fleetQuote)} ${interval === "annual" ? "a year" : "a month"} on ${PROVIDER_FOR[payCurrency]}'s page. The plan changes when ${PROVIDER_FOR[payCurrency]} confirms the payment.`
      : action === "cancel"
        ? `${currentLabel} stays until ${periodEnd ?? "the paid period ends"} and is not charged again; then the workspace moves to ${plan.label}. Every client, domain and report is kept.`
        : provider === "PADDLE"
          ? `Applies at once, and Paddle adjusts the charge for the rest of this period.`
          : `Applies on ${periodEnd ?? "the date the paid period ends"}. Until then nothing changes and there is no charge in between.`;

  const checkoutOpen = chargeable.length > 0;
  const contactOk = name.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  async function go() {
    if (busy) return;
    setBusy(true);
    setError(null);
    if (action === "checkout") {
      const res = await startCheckout(organizationId, {
        plan: plan.tier,
        interval,
        currency: payCurrency,
        contact: { name: name.trim(), email: email.trim(), taxId: taxId.trim() || null },
      });
      if (!res.ok) {
        setBusy(false);
        setError({ message: res.error.message ?? "The checkout could not be started.", overage: [] });
        return;
      }
      const url = res.data.url ?? res.data.checkoutUrl;
      if (url && url.startsWith("https://")) {
        window.location.href = url;
        return;
      }
      setBusy(false);
      setDone("The checkout was created, but the provider did not return a page to open. Nothing was charged.");
      return;
    }
    // "Keep" re-requests the current plan, which replaces the scheduled change.
    const res = await changeBillingPlan(organizationId, { plan: plan.tier, interval });
    setBusy(false);
    if (!res.ok) {
      setError({ message: res.error.message ?? "The plan could not be changed.", overage: res.error.overage ?? [] });
      return;
    }
    setDone(
      action === "cancel"
        ? `Cancelled. ${currentLabel} stays until ${periodEnd ?? "the period ends"}.`
        : action === "keep"
          ? `The scheduled change is withdrawn; ${plan.label} continues.`
          : // The API now says which happened, rather than the screen inferring it from the provider.
            res.data.status === "applied"
            ? `Moved to ${plan.label}.`
            : `${plan.label} applies from ${periodEnd ?? "the end of the period"}.`,
    );
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4 rounded-sheet border border-rule-2 px-4 py-4 sm:px-5" data-testid={`plan-decision-${plan.tier}`}>
      <p className="text-body font-bold text-fg">{action === "keep" ? `Keep ${plan.label}` : `From ${currentLabel} to ${plan.label}`}</p>

      {action !== "keep" ? (
        <div className="grid gap-x-10 gap-y-4 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            {gains.length ? (
              <div>
                <p className="text-meta font-semibold text-ok">You gain</p>
                <ul className="mt-1 flex flex-col gap-0.5 text-meta text-fg">
                  {gains.map((k) => (
                    <li key={k}>+ {planFeatureLabel(k)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {losses.length ? (
              <div>
                <p className="text-meta font-semibold text-fail">No longer included</p>
                <ul className="mt-1 flex flex-col gap-0.5 text-meta text-fg">
                  {losses.map((k) => (
                    <li key={k}>− {planFeatureLabel(k)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {!gains.length && !losses.length ? <p className="text-meta text-fg-2">The same features; only the limits and the price change.</p> : null}
          </div>
          <div className="flex flex-col gap-2">
            <table className="w-full text-meta">
              <caption className="sr-only">Limits before and after</caption>
              <tbody>
                {limitRows.map(({ l, before, after, u, over, maybe }) => (
                  <tr key={l.key} className="border-b border-rule last:border-b-0">
                    <th scope="row" className="py-1.5 pr-2 text-left font-medium text-fg-2">
                      {l.label}
                    </th>
                    <td className="tnum py-1.5 text-right text-fg">
                      {before === null ? "—" : limitLabel(before)} →{" "}
                      <span className={clsx(after < (before ?? after) && "font-semibold", over && "text-fail")}>{limitLabel(after)}</span>
                    </td>
                    <td className="py-1.5 pl-2 text-right">
                      {over && u ? (
                        <span className="font-semibold text-fail">{u.used - after} over</span>
                      ) : maybe ? (
                        <span className="text-warn">may be over</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {down && knownOver.length > 0 ? (
              <p className="text-meta font-semibold text-fail">
                This workspace is already over {knownOver.map((r) => r.l.label.toLowerCase()).join(" and ")} for {plan.label}. The
                change will be refused until the excess is removed; nothing is removed for you.
              </p>
            ) : down ? (
              <p className="text-meta text-fg-3">The change is checked against what is used when you confirm, and refused if anything is over.</p>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-meta text-fg-2">The scheduled change is withdrawn and {plan.label} continues as now.</p>
      )}

      {action === "keep" || (action === "checkout" && !checkoutOpen) ? null : <p className="text-ui text-fg-2">{timing}</p>}

      {action === "checkout" ? (
        !checkoutOpen ? (
          <Notice tone="warn" title="Checkout is not open yet">
            {capabilitiesKnown
              ? "No payment can be taken on this deployment yet. The plan can be changed once it opens."
              : "Which currencies checkout takes could not be read just now. Try again in a moment."}
          </Notice>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (contactOk && ack) void go();
            }}
            className="grid max-w-[640px] gap-3 sm:grid-cols-2"
          >
            {chargeable.length > 1 ? (
              <Field label="Pay in" className="sm:col-span-2">
                <Select value={payCurrency} onChange={(e) => setPayCurrency(e.target.value as Currency)} className="w-full max-w-[280px]" size="sm">
                  {chargeable.map((c) => (
                    <option key={c} value={c}>
                      {c} ({PROVIDER_FOR[c]})
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="Billing name">
              <Input size="sm" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="name" />
            </Field>
            <Field label="Billing email" hint="Receipts go here.">
              <Input size="sm" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </Field>
            <Field label="Tax ID (optional)" hint="GSTIN or VAT number, if the invoice needs one." className="sm:col-span-2">
              <Input size="sm" mono value={taxId} onChange={(e) => setTaxId(e.target.value)} maxLength={32} className="max-w-[280px]" />
            </Field>
            <div className="sm:col-span-2">
              <Checkbox
                id={`${id}-ack`}
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                data-testid="checkout-refund-ack"
                label={
                  <>
                    I accept the{" "}
                    <a href="/refunds" target="_blank" rel="noreferrer" className="link">
                      Refund Policy
                    </a>{" "}
                    for this purchase.
                  </>
                }
              />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" variant="primary" busy={busy} busyLabel="Opening checkout" disabled={!contactOk || !ack}>
                Continue to payment
              </Button>
            </div>
          </form>
        )
      ) : (
        <div>
          <Button variant={action === "cancel" ? "danger" : "primary"} onClick={go} busy={busy} busyLabel="Sending">
            {action === "cancel"
              ? `Move to ${plan.label} at period end`
              : action === "keep"
                ? `Keep ${plan.label}`
                : provider === "PADDLE"
                  ? `Move to ${plan.label} now`
                  : `Move to ${plan.label} at period end`}
          </Button>
        </div>
      )}

      {error ? (
        <div role="alert" data-testid="plan-change-error" className="flex flex-col gap-1.5 text-meta">
          {/* With overage rows the API's sentence runs the rows into itself
              ("has clients: 6 of 5"), so the headline is written here and
              the rows carry the numbers. */}
          <p className="font-semibold text-fail">
            {error.overage.length > 0
              ? `${plan.label} is smaller than what this workspace uses. Remove the excess first, or keep ${currentLabel}.`
              : error.message}
          </p>
          {error.overage.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {error.overage.map((o) => (
                <li key={o.quota} data-testid={`overage-row-${o.quota}`} className="tnum text-fg">
                  {o.label.charAt(0).toUpperCase() + o.label.slice(1)}: {o.used} of {o.limit} allowed ({o.by} over)
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-fg-2">Nothing changed: you stay on {currentLabel} for this period.</p>
        </div>
      ) : null}
      {done ? (
        <p role="status" className="text-meta font-semibold text-ok">
          {done}
        </p>
      ) : null}
      <button type="button" onClick={props.onClose} className="link self-start text-meta" disabled={busy}>
        Close
      </button>
    </div>
  );
}

function Compare({
  plans,
  currentTier,
  currency,
  interval,
  fleetQuote,
}: {
  plans: PlanDefinition[];
  currentTier: string;
  currency: Currency;
  interval: Interval;
  fleetQuote: BillingStatus["perDomainQuote"] | null;
}) {
  const keys = soldFeatures(plans);
  return (
    <section aria-labelledby="compare-bill-head" className="flex flex-col gap-3">
      <h2 id="compare-bill-head" className="text-h2 font-bold tracking-[-0.02em] text-fg">
        Every capability, by plan
      </h2>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse border-b border-rule text-left text-ui">
          <caption className="sr-only">Every limit and capability of each plan</caption>
          <thead className="border-b border-fg">
            <tr>
              {/* Narrow on phones, so a plan column is in view beside the labels. */}
              <th scope="col" className="sticky left-0 w-[9.5rem] bg-paper py-2 pr-4 sm:w-auto">
                <span className="sr-only">Detail</span>
              </th>
              {plans.map((p) => (
                <th key={p.tier} scope="col" className="px-3 py-2 text-right font-bold text-fg">
                  {p.label}
                  {p.tier === currentTier ? <span className="block text-meta font-semibold text-fg-3">your plan</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-rule">
              <th scope="row" className="sticky left-0 bg-paper py-2 pr-4 font-medium text-fg-2">
                Price, {interval === "annual" ? "a year" : "a month"}
              </th>
              {plans.map((p) => (
                <td key={p.tier} className="tnum px-3 py-2 text-right font-semibold text-fg">
                  {priceOf(p, currency, interval, fleetQuote)}
                </td>
              ))}
            </tr>
            {LIMITS.map((l) => (
              <tr key={l.key} className="border-b border-rule">
                <th scope="row" className="sticky left-0 bg-paper py-2 pr-4 font-medium text-fg-2">
                  {l.label}
                </th>
                {plans.map((p) => (
                  <td key={p.tier} className="tnum px-3 py-2 text-right text-fg">
                    {limitLabel(p[l.key])}
                  </td>
                ))}
              </tr>
            ))}
            {keys.map((k) => (
              <tr key={k} className="border-b border-rule">
                <th scope="row" className="sticky left-0 bg-paper py-2 pr-4 font-medium text-fg-2">
                  {planFeatureLabel(k)}
                </th>
                {plans.map((p) => (
                  <td key={p.tier} className="px-3 py-2 text-right">
                    {p.features[k as keyof PlanDefinition["features"]] ? (
                      <span className="inline-flex text-fg">
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
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
