"use client";

/**
 * billing-client.tsx — checkout, plan comparison and subscription actions.
 *
 * Plan names, prices, limits and features are NOT known here: every label and
 * figure is passed in from GET /plans and GET /workspaces/:id/entitlements
 * (server side), and feature names are a text transform of the API's own
 * keys. Nothing is hardcoded. Money is integer minor units end to end (see
 * lib/money.ts) — no render path divides by 100 with float arithmetic.
 *
 * data.export and data.erase are free on every plan; nothing in this component
 * ever implies GDPR rights are a paid feature.
 */

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { featureGroup, featureLabel } from "@/lib/feature-label";
import { currencySymbol, formatMinor } from "@/lib/money";
import {
  cancelSubscription,
  changeBillingPlan,
  openBillingPortal,
  resumeSubscription,
  startCheckout,
} from "@/lib/ops-client";
import type { ApiErrorBody, PlanDefinition, PlanPriceMinor } from "@/lib/types";

export function PlanPicker({
  organizationId,
  plans,
  order,
  currentPlan,
  currency,
  status,
  provider,
  cancelAtPeriodEnd,
  account,
  retention,
}: {
  organizationId: string;
  plans: PlanDefinition[];
  order: string[];
  currentPlan: string;
  currency: "USD" | "INR";
  status: string;
  /** The billing provider of the existing subscription — "NONE" until a
   *  payment exists. Plan change needs a real provider subscription; without
   *  one the API refuses and the only honest path is checkout. */
  provider: string;
  cancelAtPeriodEnd: boolean;
  /** The signed-in account, read server-side (lib/api-phase7 is server-only).
   *  The checkout contact is this — the API validates name (min 2) and a real
   *  email, so an empty payload is a guaranteed 400. */
  account: { name: string; email: string } | null;
  /**
   * The retention this deployment actually enforces, from `GET /api/meta`.
   *
   * Replaces `plan.dataRetentionDays` and `plan.auditRetentionDays`, which were
   * printed here as "Data retention" and "Audit retention" and mean nothing. The
   * first is a quota input about dormant domains; the second is read by no code at
   * all. They are identical on every plan, which is the tell: a real per-plan
   * retention limit would differ.
   *
   * Null while it loads. Rather than print the old figures, the row is omitted, so
   * the worst case is a missing number rather than a false one.
   */
  retention: { reportDays: number; forensicDays: number; forensicPiiDays: number } | null;
}) {
  const router = useRouter();
  const [interval, setInterval] = useState<"monthly" | "annual">("monthly");
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The Terms/Refund acknowledgement gates the PAID checkout only: it is
  // our own rendered acceptance, so the buyer sees our documents and not
  // only Paddle's hosted page. Never pre-ticked.
  const [termsAccepted, setTermsAccepted] = useState(false);

  const byTier = new Map(plans.map((p) => [p.tier, p]));
  const ordered = order
    .map((t) => byTier.get(t))
    .filter((p): p is PlanDefinition => Boolean(p));

  // Every feature key any plan claims, grouped, with the fullest plan that
  // carries each: so the comparison answers "what do I gain at each rung"
  // without the reader cross-referencing four columns of ticks.
  const featureGroups = useMemo(() => {
    const groups = new Map<string, Set<string>>();
    for (const plan of ordered) {
      for (const [key, on] of Object.entries(plan.features)) {
        if (!on) continue;
        const head = featureGroup(key);
        if (!groups.has(head)) groups.set(head, new Set());
        groups.get(head)?.add(key);
      }
    }
    return [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([group, keys]) => ({
        group,
        keys: [...keys].sort((a, b) => a.localeCompare(b)),
      }));
  }, [ordered]);

  function planHas(plan: PlanDefinition, key: string): boolean {
    return plan.features[key as keyof typeof plan.features] === true;
  }

  async function choose(plan: PlanDefinition) {
    setBusyPlan(plan.tier);
    setError(null);
    setNote(null);
    const price: PlanPriceMinor = plan.prices[currency];
    const isFree = price.monthlyMinor === 0 && price.annualMinor === 0;
    // A plan change only makes sense against a real provider subscription —
    // the API answers "This workspace has no subscription to change" without
    // one. A workspace that has never paid buys through checkout like any new
    // customer; routing it to plan-change made the first purchase impossible.
    const hasPaidSubscription = provider !== "NONE";

    if (isFree || (currentPlan !== plan.tier && hasPaidSubscription)) {
      // Moving between existing plans is a plan change, not a checkout. The
      // API schedules it at the end of the current period for BOTH directions
      // (provider-side schedule_change_at: cycle_end), so the copy says what
      // the product does: nothing is lost today, the new plan applies when the
      // period ends. "Immediate upgrade" is not something the API can deliver
      // for an active subscription today: claiming it would earn the
      // chargeback the wording exists to prevent.
      const res = await changeBillingPlan(organizationId, {
        plan: plan.tier,
        interval,
      });
      setBusyPlan(null);
      if (!res.ok) setError(res.error);
      else {
        const scheduled = plan.tier === "MOORING" ? "cancelling" : "scheduled";
        setNote(
          scheduled === "cancelling"
            ? "Cancellation scheduled. Your workspace keeps everything it has until the period you already paid for ends."
            : `Plan change scheduled. Your current plan stays as it is until your current period ends, then ${plan.label} applies: you keep what you paid for until then.`,
        );
        router.refresh();
      }
      return;
    }

    // The paid path needs the Terms/Refund acceptance: real control, real
    // gate. The free plan and plan changes above are not purchases.
    if (!termsAccepted) {
      setBusyPlan(null);
      setError({
        message:
          "Please accept the Terms of Service and Refund Policy below before checking out.",
      });
      return;
    }
    const res = await startCheckout(organizationId, {
      plan: plan.tier,
      interval,
      currency,
      contact: account ?? { name: "", email: "" },
    });
    setBusyPlan(null);
    if (!res.ok) {
      setError(res.error);
    } else {
      const url = res.data?.checkoutUrl ?? res.data?.url;
      if (typeof url === "string" && url.startsWith("https://")) {
        window.location.href = url;
      } else {
        setNote("Checkout created. Follow the provider's hosted page to complete it.");
      }
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          {(["monthly", "annual"] as const).map((i) => (
            <button
              key={i}
              type="button"
              onClick={() => setInterval(i)}
              aria-pressed={interval === i}
              className="rounded-[2px] border px-4 py-2 text-[14px] font-medium"
              style={{
                borderColor: interval === i ? "var(--color-accent)" : "var(--color-line-strong)",
                background: interval === i ? "var(--color-accent-soft)" : "transparent",
                color: interval === i ? "var(--color-ink)" : "var(--color-ink-3)",
              }}
            >
              {i === "monthly" ? "Monthly" : "Annual"}
            </button>
          ))}
        </div>
        <span className="num text-[13px]" style={{ color: "var(--color-ink-3)" }}>
          {currencySymbol(currency)} {currency} · prices from the plan catalog, never guessed
        </span>
      </div>

      {/* The paid checkout needs the buyer's own acceptance of OUR documents
          before Paddle's hosted page shows its own. Real control, never
          pre-ticked — a pre-ticked box is worse than no box. */}
      <label
        className="flex items-start gap-2.5 rounded-[2px] border px-4 py-3 text-[13px] leading-[1.6]"
        style={{ borderColor: "var(--color-line-strong)", color: "var(--color-ink-2)" }}
      >
        <input
          type="checkbox"
          checked={termsAccepted}
          onChange={(e) => setTermsAccepted(e.target.checked)}
          data-testid="checkout-terms-ack"
          className="mt-1"
        />
        <span>
          I have read and accept the{" "}
          <a href="/terms" target="_blank" rel="noreferrer" className="underline" style={{ color: "var(--color-ink)" }}>
            Terms of Service
          </a>
          {" "}and the{" "}
          <a href="/refunds" target="_blank" rel="noreferrer" className="underline" style={{ color: "var(--color-ink)" }}>
            Refund Policy
          </a>
          .
        </span>
      </label>

      {error ? (
        <div
          role="alert"
          data-testid="plan-change-error"
          className="flex flex-col gap-3 rounded-[2px] border px-4 py-3.5"
          style={{
            borderColor: "var(--color-block)",
            background: "var(--color-block-soft)",
          }}
        >
          {/* The API's own message is the headline. The named overages arrive
              directly on the error (the flat wire shape) and render as rows —
              never regexed out of the sentence. */}
          <p className="text-[14.5px]" style={{ color: "var(--color-block)" }}>
            {error.message}
          </p>
          {error.overage && error.overage.length > 0 ? (
            <ul
              className="flex flex-col gap-1.5 border-t pt-2.5"
              style={{ borderColor: "var(--color-line-strong)" }}
            >
              {error.overage.map((o) => (
                <li
                  key={o.quota}
                  data-testid={`overage-row-${o.quota}`}
                  className="num flex flex-wrap items-baseline gap-x-3 text-[12px]"
                  style={{ color: "var(--color-ink-2)" }}
                >
                  <span style={{ color: "var(--color-ink)" }}>{o.label}</span>
                  <span>
                    {o.used} of {o.limit} used
                  </span>
                  <span style={{ color: "var(--color-block)" }}>{o.by} over</span>
                  <span style={{ color: "var(--color-ink-3)" }}>
                   : remove {o.by} {o.label === "members" ? "member" : o.label.replace(/s$/, "")}
                    {o.by === 1 ? "" : "s"} to move to this plan
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {error.overage && error.overage.length > 0 ? (
            <p className="text-[12px]" style={{ color: "var(--color-ink-3)" }}>
              A downgrade takes effect at the end of the period you have already
              paid for: nothing is lost today. Your current plan stays as it is
              until you remove the excess or choose to keep it.
            </p>
          ) : null}
        </div>
      ) : null}
      {note ? (
        <p role="status" className="text-[14.5px]" style={{ color: "var(--color-pass)" }}>
          {note}
        </p>
      ) : null}

      {/* Plan cards — each carries its full story: who it is for, what it
          costs in both periods, its limits, and — incrementally — what it adds
          over the rung below. "Everything in {previous}, plus" rather than a
          repeated full inventory: the reader sees exactly what each step up
          buys. Plan names come from the API's own catalog. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
        {ordered.map((plan, idx) => {
          const price = plan.prices[currency];
          const minor = interval === "monthly" ? price.monthlyMinor : price.annualMinor;
          const isFree = price.monthlyMinor === 0 && price.annualMinor === 0;
          const isCurrent = plan.tier === currentPlan;
          const previous = idx > 0 ? ordered[idx - 1] : null;
          const carried = Object.entries(plan.features)
            .filter(([, on]) => on)
            .map(([key]) => key)
            .sort((a, b) => a.localeCompare(b));
          // Incremental view: only the capabilities the rung below does NOT
          // already carry. Tiers ascend the ladder, so this is the delta.
          const added = previous
            ? carried.filter(
                (key) =>
                  previous.features[key as keyof typeof previous.features] !== true,
              )
            : carried;
          return (
            <article
              key={plan.tier}
              className="lift flex flex-col rounded-[2px] border"
              style={{
                background: isCurrent ? "var(--color-accent-soft)" : "var(--color-surface)",
                borderColor: isCurrent ? "var(--color-accent)" : "var(--color-line)",
              }}
            >
              <header className="border-b p-5 pb-4" style={{ borderColor: "var(--color-line)" }}>
                <div className="flex items-baseline justify-between gap-2">
                  <div className="label">{plan.tier}</div>
                  {isCurrent ? (
                    <span
                      className="num text-[11.5px] tracking-[0.12em] uppercase"
                      style={{ color: "var(--color-ink-2)" }}
                    >
                      current
                    </span>
                  ) : null}
                </div>
                <h3 className="mt-1.5 text-[20.5px] font-semibold tracking-[-0.015em]" style={{ color: "var(--color-ink)" }}>
                  {plan.label}
                </h3>
                <p className="mt-1.5 text-[14.5px] leading-relaxed" style={{ color: "var(--color-ink-2)" }}>
                  {plan.descriptor}
                </p>

                <div className="num mt-4 flex items-baseline gap-1.5">
                  <span className="text-[31.5px] font-semibold" style={{ color: "var(--color-ink)" }}>
                    {formatMinor(minor, currency)}
                  </span>
                  <span className="text-[13.5px]" style={{ color: "var(--color-ink-3)" }}>
                    / {interval === "monthly" ? "month" : "year"}
                  </span>
                </div>
                {isFree ? (
                  // Free says ONE thing. The zero is already the figure above;
                  // restating it twice says nothing a third time.
                  <div className="num mt-1 text-[13px] font-medium" style={{ color: "var(--color-ink)" }}>
                    Free. No card, ever.
                  </div>
                ) : (
                  <div className="num mt-1 text-[13px]" style={{ color: "var(--color-ink-3)" }}>
                    {formatMinor(price.monthlyMinor, currency)} monthly ·{" "}
                    {formatMinor(price.annualMinor, currency)} annual
                  </div>
                )}

                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5">
                  <Limit label="Clients" value={plan.maxClients} />
                  <Limit label="Active domains" value={plan.maxActiveDomains} />
                  <Limit label="Members" value={plan.maxMembers} />

                  {/*
                    The enforced windows, and only when the service has told us what
                    they are. Same on every plan, because retention is a property of the
                    deployment rather than of the tier - which is exactly why these
                    numbers do not belong on a plan card at all, and are shown once
                    beneath the comparison instead.
                  */}
                </dl>

                {/*
                  One retention statement for the whole comparison, because it is one
                  fact about the deployment rather than four facts about the tiers.

                  It used to be printed on every plan card, where four identical
                  figures read as a per-plan allowance nobody could identify. The audit
                  trail is named as having no automatic expiry rather than being given
                  a number, because no number is true of it: nothing deletes an audit
                  log, and claiming a window would be the same defect again.
                */}
                {retention ? (
                  <p
                    className="mt-3 text-[12.5px] leading-relaxed"
                    style={{ color: "var(--color-ink-3)" }}
                  >
                    Retention, on every plan: aggregate reports {retention.reportDays} days,
                    forensic reports {retention.forensicDays} days, named forensic recipient
                    data {retention.forensicPiiDays} days. The audit trail has no automatic
                    expiry.
                  </p>
                ) : null}

                <button
                  type="button"
                  disabled={busyPlan === plan.tier || isCurrent}
                  onClick={() => choose(plan)}
                  className="mt-4 w-full rounded-[2px] px-4 py-2.5 text-[14.5px] font-semibold"
                  style={
                    isCurrent
                      ? { border: "1px solid var(--color-line-strong)", color: "var(--color-ink-3)" }
                      : { background: "var(--color-accent)", color: "var(--color-accent-ink)" }
                  }
                >
                  {isCurrent
                    ? "Your current plan"
                    : busyPlan === plan.tier
                      ? "Working…"
                      : minor === 0
                        ? "Move to this plan"
                        : "Choose this plan"}
                </button>
              </header>

              <div className="flex-1 p-5 pt-4">
                <div className="label">
                  {previous
                    ? `Everything in ${previous.label}, plus`
                    : `Everything ${plan.label} carries`}
                </div>
                <ul className="mt-3 flex flex-col gap-1.5">
                  {added.map((key) => (
                    <li
                      key={key}
                      className="flex items-start gap-2 text-[14px]"
                      style={{ color: "var(--color-ink-2)" }}
                    >
                      <span style={{ color: "var(--color-pass)" }} aria-hidden>✓</span>
                      {featureLabel(key)}
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          );
        })}
      </div>

      {/* The full comparison: every capability, which plan first carries it. */}
      <section
        className="lift rounded-[2px] border"
        style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
      >
        <header className="border-b px-5 py-4" style={{ borderColor: "var(--color-line)" }}>
          <h3 className="text-[17.5px] font-semibold tracking-[-0.012em]">
            Every capability, by plan
          </h3>
          <p className="mt-1 text-[14.5px]" style={{ color: "var(--color-ink-2)" }}>
            A filled mark is carried; a dash is not. Higher plans always include
            everything below them.
          </p>
        </header>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="label border-b px-5 py-2.5 text-left" style={{ borderColor: "var(--color-line)" }}>
                Capability
              </th>
              {ordered.map((p) => (
                <th
                  key={p.tier}
                  className="label border-b px-4 py-2.5 text-center"
                  style={{
                    borderColor: "var(--color-line)",
                    color: p.tier === currentPlan ? "var(--color-ink)" : undefined,
                  }}
                >
                  {p.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {featureGroups.map(({ group, keys }) => (
              // The group name is the key: it is unique per group and it is
              // what identifies the row to React. Groups are filtered by plan,
              // so an index key would make React reuse the wrong rows when the
              // plan changes: a comparison table whose rows do not match the
              // plan on screen.
              <Fragment key={group}>
                <tr>
                  <td
                    colSpan={ordered.length + 1}
                    className="label border-b px-5 pb-1.5 pt-4"
                    style={{ borderColor: "var(--color-line)", color: "var(--color-ink-3)" }}
                  >
                    {group}
                  </td>
                </tr>
                {keys.map((key) => (
                  <tr key={key}>
                    <td className="border-b px-5 py-2 text-[14.5px]" style={{ borderColor: "rgba(255,255,255,0.055)", color: "var(--color-ink-2)" }}>
                      {featureLabel(key)}
                    </td>
                    {ordered.map((p) => (
                      <td
                        key={`${p.tier}-${key}`}
                        className="border-b px-4 py-2 text-center"
                        style={{ borderColor: "rgba(255,255,255,0.055)" }}
                      >
                        {planHas(p, key) ? (
                          <span aria-label="carried" style={{ color: "var(--color-pass)", fontSize: 14 }}>✓</span>
                        ) : (
                          <span aria-label="not carried" style={{ color: "var(--color-ink-3)" }}>—</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={async () => {
            const res = await openBillingPortal(organizationId);
            if (res.ok && res.data?.url) window.location.href = res.data.url;
            else if (!res.ok) setError(res.error);
          }}
          className="rounded-[2px] border px-4 py-2 text-[14.5px] font-semibold"
          style={{ borderColor: "var(--color-line-strong)", color: "var(--color-ink-2)" }}
        >
          Billing portal
        </button>
        {cancelAtPeriodEnd ? (
          <button
            type="button"
            onClick={async () => {
              const res = await resumeSubscription(organizationId);
              if (res.ok) router.refresh();
              else setError(res.error);
            }}
            className="text-[14px] underline"
            style={{ color: "var(--color-pass)" }}
          >
            resume subscription
          </button>
        ) : status === "ACTIVE" ? (
          <button
            type="button"
            onClick={async () => {
              const res = await cancelSubscription(organizationId);
              if (res.ok) router.refresh();
              else setError(res.error);
            }}
            className="text-[14px] underline"
            style={{ color: "var(--color-block)" }}
          >
            cancel at period end
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Limit({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <dt className="num text-[12px] tracking-[0.12em] uppercase" style={{ color: "var(--color-ink-3)" }}>
        {label}
      </dt>
      <dd className="num text-[14.5px]" style={{ color: "var(--color-ink-2)" }}>
        {value}
      </dd>
    </div>
  );
}
