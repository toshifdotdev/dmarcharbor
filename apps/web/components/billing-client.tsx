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

import { useMemo, useState } from "react";
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
  cancelAtPeriodEnd,
}: {
  organizationId: string;
  plans: PlanDefinition[];
  order: string[];
  currentPlan: string;
  currency: "USD" | "INR";
  status: string;
  cancelAtPeriodEnd: boolean;
}) {
  const router = useRouter();
  const [interval, setInterval] = useState<"monthly" | "annual">("monthly");
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [error, setError] = useState<ApiErrorBody["error"] | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const byTier = new Map(plans.map((p) => [p.tier, p]));
  const ordered = order
    .map((t) => byTier.get(t))
    .filter((p): p is PlanDefinition => Boolean(p));

  // Every feature key any plan claims, grouped, with the fullest plan that
  // carries each — so the comparison answers "what do I gain at each rung"
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

    if (isFree || (currentPlan !== plan.tier && status !== "NONE")) {
      // Moving between existing plans is a plan change, not a checkout.
      const res = await changeBillingPlan(organizationId, { plan: plan.tier });
      setBusyPlan(null);
      if (!res.ok) setError(res.error);
      else {
        setNote("Plan changed. The workspace now carries this plan's limits.");
        router.refresh();
      }
      return;
    }

    const res = await startCheckout(organizationId, {
      plan: plan.tier,
      interval,
      currency,
      contact: { name: "", email: "" },
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

      {error ? (
        <p
          role="alert"
          data-feature={error.feature ?? ""}
          className="text-[15px]"
          style={{ color: "var(--color-block)" }}
        >
          {error.message}
        </p>
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
                <div className="num mt-1 text-[13px]" style={{ color: "var(--color-ink-3)" }}>
                  {formatMinor(price.monthlyMinor, currency)} monthly ·{" "}
                  {formatMinor(price.annualMinor, currency)} annual
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5">
                  <Limit label="Clients" value={plan.maxClients} />
                  <Limit label="Active domains" value={plan.maxActiveDomains} />
                  <Limit label="Members" value={plan.maxMembers} />
                  <Limit label="Data retention" value={`${plan.dataRetentionDays}d`} />
                  <Limit label="Audit retention" value={`${plan.auditRetentionDays}d`} />
                </dl>

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
              <>
                <tr key={`grp-${group}`}>
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
              </>
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
