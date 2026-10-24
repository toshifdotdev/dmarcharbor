"use client";

/**
 * billing-board.tsx — how much of the plan is used, and what changing it would
 * change.
 *
 *   Usage       each allowance with what is used, worded by how exact the count
 *               is. Members and workspaces are exact. Clients are exact unless
 *               the owner holds several workspaces (the limit counts across
 *               all of them). Active domains are an upper bound: a domain only
 *               counts while reports arrive for it, or for a while after it was
 *               added, and that window is the API's, not shown here.
 *   Plans       every plan from GET /api/plans. Choosing one opens, inside its
 *               card, exactly what would change: what is gained and lost,
 *               each limit before and after (with anything already over it),
 *               when it applies, and how it is paid. Nothing is sent until the
 *               last button in that panel.
 *   Compare     every limit and capability, by plan.
 *
 * Which action a plan offers follows the API:
 *   a subscription exists   PATCH /billing/plan (MOORING is a cancellation)
 *   no subscription         POST /billing/checkout, to the provider's page
 * A refused downgrade (PLAN_CHANGE_OVER_QUOTA) shows the API's overage rows.
 *
 * Test hooks kept: article per plan with a /choose|move/ button,
 * plan-change-error, overage-row-{quota}, checkout-refund-ack.
 */

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { clsx } from "clsx";
import { formatMinor } from "@/lib/money";
import { addedFeatures, catalogMonthsSaved, isFree, planFeatureLabel, soldFeatures, UNLISTED_FEATURES } from "@/lib/plan-features";
import { changeBillingPlan, startCheckout } from "@/lib/ops-client";
import type { PlanDefinition, PlanOverageRow } from "@/lib/types";
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

function priceOf(plan: PlanDefinition, currency: Currency, interval: Interval): string {
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
}) {
  const [interval, setInterval] = useState<Interval>(currentInterval);
  const [open, setOpen] = useState<string | null>(null);
  const current = plans.find((p) => p.tier === currentTier) ?? null;
  const months = catalogMonthsSaved(plans);

  return (
    <div className="flex flex-col gap-10">
      {current ? <UsagePanel plan={current} usage={usage} /> : null}

      <section aria-labelledby="plans-head" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="plans-head" className="text-h2 font-bold tracking-[-0.02em] text-fg">
              Change plan
            </h2>
            <p className="mt-1 max-w-[70ch] text-ui text-fg-2">
              Choose a plan to see exactly what would change before anything is sent. Prices in {currency}
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

        <div className="grid border-t border-rule sm:grid-cols-2 xl:grid-cols-4">
          {plans.map((plan, i) => (
            <PlanCard
              key={plan.tier}
              index={i}
              plan={plan}
              previous={i > 0 ? plans[i - 1] : null}
              current={current}
              isCurrent={plan.tier === currentTier}
              isPending={plan.tier === pendingTier}
              pendingTier={pendingTier}
              open={open === plan.tier}
              onOpen={() => setOpen(plan.tier)}
              onClose={() => setOpen(null)}
              organizationId={organizationId}
              provider={provider}
              hasSubscription={hasSubscription}
              cancelling={cancelling}
              periodEnd={periodEnd}
              currency={currency}
              interval={interval}
              chargeable={chargeable}
              capabilitiesKnown={capabilitiesKnown}
              usage={usage}
              canChange={canChange}
              contact={contact}
            />
          ))}
        </div>
      </section>

      <Compare plans={plans} currentTier={currentTier} currency={currency} interval={interval} />
    </div>
  );
}

function usageLine(u: UsageCount | null, limit: number, l: (typeof LIMITS)[number]): { text: string; over: boolean; near: boolean } {
  if (!u) return { text: `Up to ${limit} ${limit === 1 ? l.one : l.many}. The current count could not be read.`, over: false, near: false };
  const word = u.used === 1 ? l.one : l.many;
  if (l.usage === "domains" && !u.exact) {
    return {
      text: `${u.used} ${u.used === 1 ? "domain" : "domains"} in this workspace, so at most ${u.used} count as active. A domain counts while reports arrive for it, and for a while after it is added.`,
      over: false,
      near: u.used > limit,
    };
  }
  if (l.usage === "clients" && !u.exact) {
    return {
      text: `${u.used} ${word} in this workspace. The limit counts clients across every workspace on the owner's account.`,
      over: u.used > limit,
      near: u.used >= limit,
    };
  }
  const left = limit - u.used;
  // Counted across every workspace on the owner's account, as the limit is.
  const scope =
    l.usage === "domains"
      ? " Counted across the owner's workspaces: a domain is active while reports arrive for it, and for a while after it is added."
      : l.usage === "clients"
        ? " Counted across the owner's workspaces."
        : "";
  return {
    text:
      (left < 0
        ? `${-left} over the limit. Nothing is removed, but a new one cannot be added until the count is under it.`
        : left === 0
          ? `At the limit: adding another needs a larger plan.`
          : `Room for ${left} more.`) + scope,
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
      <dl className="grid gap-px overflow-hidden rounded-ctl border border-rule bg-rule sm:grid-cols-2 xl:grid-cols-4">
        {LIMITS.map((l) => {
          const limit = plan[l.key];
          const u = usage[l.usage];
          const line = usageLine(u, limit, l);
          const share = u && u.exact ? Math.min(1, u.used / Math.max(1, limit)) : null;
          return (
            <div key={l.key} data-usage={l.usage} className="flex flex-col gap-1.5 bg-paper-2 px-4 py-4">
              <dt className="text-meta font-semibold text-fg-2">{l.label}</dt>
              <dd className="flex flex-col gap-1.5">
                <span className="tnum text-[26px] font-semibold leading-none text-fg">
                  {u ? (
                    <>
                      {l.usage === "domains" && !u.exact ? <span className="text-body font-medium text-fg-3">up to </span> : null}
                      {u.used}
                      <span className="text-body font-medium text-fg-3"> of {limit}</span>
                    </>
                  ) : (
                    <span className="text-body font-medium text-fg-3">limit {limit}</span>
                  )}
                </span>
                {share !== null ? (
                  <span aria-hidden className="block h-[3px] w-full bg-rule">
                    <span
                      className={clsx("hb-rail-fill block h-full", line.over ? "bg-fail" : line.near ? "bg-warn-mark" : "bg-act")}
                      style={{ "--from": "0%", "--to": `${share * 100}%`, width: `${share * 100}%` } as React.CSSProperties}
                    />
                  </span>
                ) : null}
                <span className={clsx("text-meta", line.over ? "font-semibold text-fail" : "text-fg-3")}>{line.text}</span>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

type Action = "current" | "keep" | "change" | "cancel" | "checkout" | "blocked";

function PlanCard(props: {
  index: number;
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
}) {
  const { plan, previous, isCurrent, isPending, pendingTier, open, hasSubscription, cancelling, currency, interval, canChange } = props;
  const free = isFree(plan.prices[currency]);
  const added = addedFeatures(plan, previous);

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
      className={clsx(
        "relative flex flex-col gap-4 border-b border-rule px-0 pb-6 pt-5 sm:px-5",
        props.index > 0 && "sm:border-l",
        props.index === 2 && "sm:border-l-0 xl:border-l",
        isCurrent && "bg-paper-2/70",
      )}
    >
      {isCurrent ? <span aria-hidden className="absolute inset-x-0 -top-px h-[2px] bg-act" /> : null}
      <header>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 id={`bill-${plan.tier}`} className="wide text-[20px] font-bold tracking-[-0.02em] text-fg">
            {plan.label}
          </h3>
          {isCurrent ? (
            <span className="text-meta font-semibold text-act">Your plan</span>
          ) : isPending ? (
            <span className="text-meta font-semibold text-act">Scheduled</span>
          ) : null}
        </div>
        <p className="mt-1 text-ui text-fg-2">{plan.descriptor}</p>
      </header>
      <p className="tnum">
        <span key={`${currency}-${interval}`} className="display inline-block text-[30px] leading-none text-fg [animation:hb-rise_220ms_ease-out_both]">
          {priceOf(plan, currency, interval)}
        </span>
        {free ? null : <span className="ml-1 text-meta text-fg-3">{interval === "annual" ? "a year" : "a month"}</span>}
      </p>
      <p className="text-meta text-fg-2">
        {LIMITS.map((l) => `${plan[l.key]} ${plan[l.key] === 1 ? l.one : l.many}`).join(" · ")}
      </p>

      {open && action !== "current" ? (
        <Decision {...props} action={action} verb={verb} />
      ) : (
        <>
          {action === "current" ? null : action === "blocked" ? (
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
            <Button
              variant={action === "keep" ? "primary" : "secondary"}
              onClick={props.onOpen}
              disabled={!canChange}
              className="w-full justify-center"
              data-testid={`plan-choose-${plan.tier}`}
            >
              {verb}
            </Button>
          )}
          {!canChange && action !== "current" && action !== "blocked" ? (
            <p className="-mt-2 text-meta text-fg-3">Only the workspace owner can change the plan.</p>
          ) : null}
        </>
      )}

      <div>
        <p className="text-meta font-semibold text-fg-2">{previous ? `Everything in ${previous.label}, plus` : "Includes"}</p>
        <ul className="mt-2 flex flex-col gap-1.5 text-ui text-fg">
          {added.map((k) => (
            <li key={k} className="grid grid-cols-[16px_minmax(0,1fr)] gap-1.5">
              <Check size={13} className="mt-[3px] text-ok" />
              <span>{planFeatureLabel(k)}</span>
            </li>
          ))}
          {added.length === 0 && previous ? <li className="text-fg-3">Higher limits; no added features.</li> : null}
        </ul>
      </div>
    </article>
  );
}

function Decision(
  props: Parameters<typeof PlanCard>[0] & { action: Action; verb: string },
) {
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
    const before = current?.[l.key] ?? null;
    const after = plan[l.key];
    const u = props.usage[l.usage];
    const over = u ? (u.exact || l.usage === "clients" ? u.used > after : false) : false;
    const maybe = u && !over && l.usage === "domains" ? u.used > after : false;
    return { l, before, after, u, over, maybe };
  });
  const knownOver = limitRows.filter((r) => r.over);

  const timing =
    action === "checkout"
      ? `You pay ${priceOf(plan, payCurrency, interval)} ${interval === "annual" ? "a year" : "a month"} on ${PROVIDER_FOR[payCurrency]}'s page. The plan changes when ${PROVIDER_FOR[payCurrency]} confirms the payment.`
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
    <div className="flex flex-col gap-3 rounded-ctl border border-act-line bg-paper px-3 py-3 [animation:hb-rise_200ms_ease-out]" data-testid={`plan-decision-${plan.tier}`}>
      <p className="text-ui font-semibold text-fg">
        {action === "keep" ? `Keep ${plan.label}` : `From ${currentLabel} to ${plan.label}`}
      </p>

      {action !== "keep" ? (
        <>
          {gains.length ? (
            <div>
              <p className="legend pb-1 text-ok!">You gain</p>
              <ul className="flex flex-col gap-0.5 text-meta text-fg">
                {gains.map((k) => (
                  <li key={k}>+ {planFeatureLabel(k)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {losses.length ? (
            <div>
              <p className="legend pb-1 text-fail!">No longer included</p>
              <ul className="flex flex-col gap-0.5 text-meta text-fg">
                {losses.map((k) => (
                  <li key={k}>− {planFeatureLabel(k)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <table className="w-full text-meta">
            <caption className="sr-only">Limits before and after</caption>
            <tbody>
              {limitRows.map(({ l, before, after, u, over, maybe }) => (
                <tr key={l.key} className="border-b border-rule last:border-b-0">
                  <th scope="row" className="py-1 pr-2 text-left font-medium text-fg-2">
                    {l.label}
                  </th>
                  <td className="tnum py-1 text-right text-fg">
                    {before ?? "—"} → <span className={clsx(after < (before ?? after) && "font-semibold", over && "text-fail")}>{after}</span>
                  </td>
                  <td className="py-1 pl-2 text-right">
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
        </>
      ) : (
        <p className="text-meta text-fg-2">The scheduled change is withdrawn and {plan.label} continues as now.</p>
      )}

      {action === "keep" || (action === "checkout" && !checkoutOpen) ? null : <p className="text-meta text-fg-2">{timing}</p>}

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
            className="flex flex-col gap-2.5"
          >
            {chargeable.length > 1 ? (
              <Field label="Pay in">
                <Select value={payCurrency} onChange={(e) => setPayCurrency(e.target.value as Currency)} className="w-full" size="sm">
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
            <Field label="Tax ID (optional)" hint="GSTIN or VAT number, if the invoice needs one.">
              <Input size="sm" mono value={taxId} onChange={(e) => setTaxId(e.target.value)} maxLength={32} />
            </Field>
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
            <Button type="submit" variant="primary" busy={busy} busyLabel="Opening checkout" disabled={!contactOk || !ack} className="w-full justify-center">
              Continue to payment
            </Button>
          </form>
        )
      ) : (
        <Button variant={action === "cancel" ? "danger" : "primary"} onClick={go} busy={busy} busyLabel="Sending" className="w-full justify-center">
          {action === "cancel"
            ? `Move to ${plan.label} at period end`
            : action === "keep"
              ? `Keep ${plan.label}`
              : provider === "PADDLE"
                ? `Move to ${plan.label} now`
                : `Move to ${plan.label} at period end`}
        </Button>
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

function Compare({ plans, currentTier, currency, interval }: { plans: PlanDefinition[]; currentTier: string; currency: Currency; interval: Interval }) {
  const keys = soldFeatures(plans);
  return (
    <section aria-labelledby="compare-bill-head" className="flex flex-col gap-3">
      <h2 id="compare-bill-head" className="text-h2 font-bold tracking-[-0.02em] text-fg">
        Every capability, by plan
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse border-y border-fg text-left text-ui">
          <thead className="border-b border-rule-2">
            <tr>
              <th scope="col" className="sticky left-0 bg-paper py-2 pr-4">
                <span className="sr-only">Detail</span>
              </th>
              {plans.map((p) => (
                <th key={p.tier} scope="col" className="px-3 py-2 font-bold text-fg">
                  {p.label}
                  {p.tier === currentTier ? <span className="ml-1.5 text-meta font-semibold text-act">yours</span> : null}
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
                <td key={p.tier} className="tnum px-3 py-2 font-semibold text-fg">
                  {priceOf(p, currency, interval)}
                </td>
              ))}
            </tr>
            {LIMITS.map((l) => (
              <tr key={l.key} className="border-b border-rule">
                <th scope="row" className="sticky left-0 bg-paper py-2 pr-4 font-medium text-fg-2">
                  {l.label}
                </th>
                {plans.map((p) => (
                  <td key={p.tier} className="tnum px-3 py-2 text-fg">
                    {p[l.key]}
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
                  <td key={p.tier} className="px-3 py-2">
                    {p.features[k as keyof PlanDefinition["features"]] ? (
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
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
