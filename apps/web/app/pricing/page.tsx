import Link from "next/link";
import { getBillingCurrency, getPlanCatalog } from "@/lib/api-ops";
import { formatMinor } from "@/lib/money";
import { featureLabel } from "@/lib/feature-label";
import { readHostBrand } from "@/lib/host-brand";
import { pickActiveWorkspace } from "@/lib/session";
import { listWorkspaces } from "@/lib/api";
import type { PlanDefinition } from "@/lib/types";
import {
  HostUnverifiedBanner,
  MarketingFooter,
  MarketingHeader,
  brandName,
} from "@/components/marketing";
import { PricingCurrencyToggle } from "@/components/pricing-currency";

/**
 * pricing.tsx route — "The Statement refit" (pricing-lab/15-the-statement-refit,
 * the locked spec): typography is the design and ALL figures land in the first
 * screen — a compact hero over one row of tabular prices, so comparing needs
 * no scrolling. Prose moves below the fold.
 *
 * Every number, name and feature on this page comes from GET /api/plans.
 * Nothing is hardcoded: a pricing change on the API changes this page.
 * The comparison table is the full inventory (rows = limits + every
 * entitlement key the catalog carries); the cards above are the incremental
 * view — "Everything in {previous}, plus" — exactly like the billing screen,
 * so a plan is described the same way wherever it is sold.
 */

/** A key granted on no plan is a commercial decision (priced but not built —
 *  see the API's plannedEntitlements), never a row in a comparison we sell
 *  against. Derived from the data: no plan name or feature list hardcoded. */
function soldKeys(plans: PlanDefinition[]): string[] {
  const keys = new Set<string>();
  for (const p of plans) for (const [k, on] of Object.entries(p.features)) if (on) keys.add(k);
  return [...keys].sort((a, b) => a.localeCompare(b));
}

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ currency?: string }>;
}) {
  const brand = await readHostBrand();
  const name = brandName(brand);
  const catalog = await getPlanCatalog().catch(() => null);

  // The quoted currency: the workspace's stored preference (the value a later
  // checkout charges) when signed in, INR by default until Paddle is approved.
  // A ?currency= query drives the display for visitors who cannot persist one.
  let preference: { preferredCurrency: "USD" | "INR"; locked: boolean; reason: string | null } | null =
    null;
  let organizationId: string | null = null;
  try {
    const workspaces = await listWorkspaces();
    const active = await pickActiveWorkspace(workspaces);
    if (active) {
      organizationId = active.id;
      preference = await getBillingCurrency(active.id).catch(() => null);
    }
  } catch {
    // Signed out: display only, nothing to persist.
  }
  const { currency: wanted } = await searchParams;
  const currency: "USD" | "INR" =
    preference?.preferredCurrency ??
      (wanted === "USD" || wanted === "INR" ? wanted : "INR");

  if (!catalog) {
    return (
      <div className="relative z-10 min-h-screen" data-host-brand={brand.state}>
        {brand.state === "unverified" ? <HostUnverifiedBanner /> : null}
        <MarketingHeader brand={brand} current="pricing" />
        <section className="mx-auto w-full max-w-[1180px] px-6 pt-14">
          <h1 className="text-[34px] font-semibold tracking-[-0.032em]" style={{ fontFamily: "var(--font-display)" }}>
            Pricing
          </h1>
          <p role="alert" className="mt-4 max-w-[62ch] text-[14px]" style={{ color: "var(--color-ink-2)" }}>
            The plan catalog did not load. Nothing is being hidden — the
            request failed. Try again in a moment.
          </p>
        </section>
        <MarketingFooter brand={brand} />
      </div>
    );
  }

  const ordered = catalog.order
    .map((tier) => catalog.plans.find((p) => p.tier === tier))
    .filter((p): p is PlanDefinition => Boolean(p));

  const keys = soldKeys(ordered);
  // The recommended rung is the one most of the ladder's feature growth lands
  // on — derived, never named in code.
  const recommended =
    ordered.length > 2
      ? ordered.reduce((best, p, i) =>
          deltaCount(ordered, i) > deltaCount(ordered, ordered.indexOf(best)) ? p : best,
        )
      : null;

  return (
    <div className="relative z-10 min-h-screen" data-host-brand={brand.state}>
      {brand.state === "unverified" ? <HostUnverifiedBanner /> : null}
      <MarketingHeader brand={brand} current="pricing" />

      {/* Hero + every price in one screen — comparison without scrolling. */}
      <section className="mx-auto flex w-full max-w-[1180px] flex-wrap items-baseline gap-x-10 gap-y-4 px-6 pt-9">
        <div>
          <div className="label">Pricing</div>
          <h1 className="mt-2 text-[32px] font-semibold leading-[1.15] tracking-[-0.032em]" style={{ fontFamily: "var(--font-display)" }}>
            The prices, before the prose.
          </h1>
        </div>
        <p className="max-w-[46ch] flex-1 text-[13.5px] leading-[1.7]" style={{ color: "var(--color-ink-2)" }}>
          All of them are on this screen. Monthly in {currency === "INR" ? "INR and USD" : "USD and INR"}, annual where
          it saves you two months. The words about what each plan buys are
          below, where scrolling is fine. <strong style={{ color: "var(--color-ink)" }}>
          {name}</strong> never prices data portability or erasure — those are on
          every plan.
        </p>
        <div className="w-full">
          <PricingCurrencyToggle
            currency={currency}
            locked={preference?.locked ?? false}
            reason={preference?.reason ?? null}
            persistable={Boolean(organizationId)}
            organizationId={organizationId}
          />
        </div>
      </section>

      {/* The row of figures. */}
      <section className="mx-auto w-full max-w-[1180px] px-6 pt-7">
        <div className="grid grid-cols-1 border-t sm:grid-cols-2 xl:grid-cols-4" style={{ borderColor: "var(--color-line-strong)" }}>
          {ordered.map((plan, idx) => {
            // The headline figure is the currency the visitor is quoted — the
            // same value a checkout will send. The other currency stays visible
            // underneath: the page is honest about both, never one behind a
            // toggle a visitor did not find.
            const lead = plan.prices[currency];
            const other = currency === "USD" ? plan.prices.INR : plan.prices.USD;
            const otherCode = currency === "USD" ? "INR" : "USD";
            const rec = recommended?.tier === plan.tier;
            const previous = idx > 0 ? ordered[idx - 1] : null;
            const added = incrementalKeys(plan, previous);
            return (
              <article
                key={plan.tier}
                data-plan={plan.tier}
                className="flex flex-col border-b px-0 py-6 sm:px-5"
                style={{
                  borderColor: "var(--color-line-strong)",
                  borderLeft: rec ? "2px solid var(--color-accent)" : undefined,
                  background: rec ? "var(--color-surface)" : undefined,
                  paddingLeft: rec ? 20 : undefined,
                }}
              >
                <div className="num text-[9.5px] uppercase tracking-[0.18em]" style={{ color: "var(--color-ink-3)" }}>
                  {plan.descriptor}
                </div>
                <h2 className="mt-1.5 text-[21px] font-semibold tracking-[-0.022em]" style={{ fontFamily: "var(--font-display)" }}>
                  {plan.label}
                  {rec ? (
                    <span
                      className="num ml-2 inline-block align-middle text-[8.5px] uppercase tracking-[0.16em]"
                      style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)", padding: "2px 7px", borderRadius: 2 }}
                    >
                      most sail here
                    </span>
                  ) : null}
                </h2>

                {/* The figure: monthly price in the quoted currency, tabular. */}
                <div
                  className="mt-4 flex items-baseline text-[64px] font-semibold leading-none tracking-[-0.045em]"
                  style={{ fontFamily: "var(--font-display)", fontVariantNumeric: "tabular-nums" }}
                >
                  <span className="text-[26px]" style={{ color: "var(--color-ink-2)" }}>
                    {currency === "USD" ? "$" : "₹"}
                  </span>
                  <span>{Math.trunc(lead.monthlyMinor / 100)}</span>
                  {lead.monthlyMinor % 100 !== 0 ? (
                    <span className="text-[26px]" style={{ color: "var(--color-ink-2)" }}>
                      .{String(lead.monthlyMinor % 100).padStart(2, "0")}
                    </span>
                  ) : null}
                </div>

                <div className="num mt-2.5 flex flex-col gap-0.5 text-[11px]" style={{ color: "var(--color-ink-3)" }}>
                  <span>
                    <b style={{ color: "var(--color-ink-2)", fontWeight: 500 }}>
                      {formatMinor(other.monthlyMinor, otherCode)}
                    </b>{" "}
                    in {otherCode}{lead.monthlyMinor === 0 ? " · always · no card" : " · per month"}
                  </span>
                  {lead.annualMinor > 0 ? (
                    <span>
                      {formatMinor(lead.annualMinor, currency)} / {formatMinor(other.annualMinor, otherCode)} per year
                    </span>
                  ) : null}
                </div>

                <Link
                  href="/sign-up"
                  data-testid={`plan-cta-${plan.tier}`}
                  className="mt-4 w-full rounded-[2px] px-4 py-2.5 text-center text-[13px] font-semibold"
                  style={
                    rec
                      ? { background: "var(--color-accent)", color: "var(--color-accent-ink)" }
                      : { border: "1px solid var(--color-line-strong)", color: "var(--color-ink-2)" }
                  }
                >
                  {lead.monthlyMinor === 0 ? "Start free" : `Choose ${plan.label}`}
                </Link>

                <ul className="mt-4 flex flex-col gap-1.5">
                  {(previous
                    ? [{ synthetic: true }, ...added.map((k) => ({ key: k }))]
                    : added.map((k) => ({ key: k }))
                  ).map((item) =>
                    "synthetic" in item ? (
                      <li key={`carry-${plan.tier}`} className="num text-[11px] leading-[1.5]" style={{ color: "var(--color-ink-2)" }}>
                        <span style={{ color: "var(--color-ink-3)" }}>→</span>{" "}
                        Everything in {previous?.label}
                      </li>
                    ) : (
                      <li key={item.key} className="num text-[11px] leading-[1.5]" style={{ color: "var(--color-ink-2)", paddingLeft: 15, position: "relative" }}>
                        <span style={{ position: "absolute", left: 0, color: "var(--color-ink-3)" }}>→</span>
                        {featureLabel(item.key)}
                      </li>
                    ),
                  )}
                </ul>
              </article>
            );
          })}
        </div>
      </section>

      {/* What the price never changes. */}
      <section className="mx-auto w-full max-w-[1180px] px-6 pt-14">
        <h2 className="text-[26px] font-semibold tracking-[-0.03em]" style={{ fontFamily: "var(--font-display)" }}>
          What the price never changes.
        </h2>
        <p className="mt-3.5 max-w-[64ch] text-[14px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
          Higher plans carry more. They do not parse better, encrypt harder, or
          expire personal data more slowly. Data export and erasure are free on
          every plan because they are rights, not features. Unknown states never
          render as a pass — at any price.
        </p>
        <dl className="mt-7 flex flex-wrap gap-x-13 gap-y-5">
          <Fig label="Annual passage" value="10 months → 12" />
          <Fig label="₹ payments" value="Razorpay" />
          <Fig label="Everything else" value="Paddle" />
          <Fig label="Deleted on downgrade" value="Nothing" />
        </dl>
      </section>

      {/* The five postures — the product's promise, priced identically. */}
      <section className="mx-auto mt-7 flex w-full max-w-[1180px] flex-wrap items-center gap-3 px-6">
        <StateChip color="var(--color-pass)" label="Pass" />
        <StateChip color="var(--color-block)" label="Block" />
        <StateChip color="var(--color-unverified)" label="Unverified" />
        <StateChip color="var(--color-unmeasured)" label="Not measured" />
        <span className="num ml-auto text-[11px]" style={{ color: "var(--color-ink-3)" }}>
          Unknown never renders as a pass — at any price.
        </span>
      </section>

      {/* The full comparison — every limit and every entitlement. */}
      <section className="mx-auto w-full max-w-[1180px] px-6 pt-14">
        <h2 className="text-[26px] font-semibold tracking-[-0.03em]" style={{ fontFamily: "var(--font-display)" }}>
          Compare everything
        </h2>
        <div className="mt-6 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                <th aria-hidden="true" className="label border-b py-2.5 pr-4 align-bottom" style={{ borderColor: "var(--color-line-strong)" }} />
                {ordered.map((p) => (
                  <th
                    key={p.tier}
                    className="border-b px-4 py-2.5 text-[13.5px] font-semibold align-bottom"
                    style={{ borderColor: "var(--color-line-strong)", color: "var(--color-ink)" }}
                  >
                    {p.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <CompareRow label="Clients" ordered={ordered} cell={(p) => String(p.maxClients)} />
              <CompareRow label="Active domains" ordered={ordered} cell={(p) => String(p.maxActiveDomains)} />
              <CompareRow label="Members" ordered={ordered} cell={(p) => String(p.maxMembers)} />
              <CompareRow label="Data retention" ordered={ordered} cell={(p) => `${p.dataRetentionDays} days`} />
              <CompareRow label="Audit retention" ordered={ordered} cell={(p) => `${p.auditRetentionDays} days`} />
              {keys.map((key) => (
                <CompareRow
                  key={key}
                  label={featureLabel(key)}
                  ordered={ordered}
                  cell={(p) => (p.features[key as keyof PlanDefinition["features"]] ? "✓" : "—")}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1180px] px-6 pt-12">
        <div
          className="rounded-[2px] border px-8 py-8"
          style={{ borderColor: "var(--color-line-strong)", background: "var(--color-surface)" }}
        >
          <h2 className="text-[23px] font-semibold tracking-[-0.028em]" style={{ fontFamily: "var(--font-display)" }}>
            Start free, no card.
          </h2>
          <p className="mt-3 max-w-[62ch] text-[14px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
            One account, one workspace. Add clients and domains once you are in,
            and move up a rung when the portfolio asks for it — a plan change
            never deletes anything, in either direction.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-4">
            <Link
              href="/sign-up"
              className="rounded-[2px] px-5 py-2.5 text-[13.5px] font-semibold"
              style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
            >
              Create an account
            </Link>
            <Link href="/sign-in" className="text-[13.5px] underline" style={{ color: "var(--color-ink-2)" }}>
              Sign in
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter brand={brand} />
    </div>
  );
}

/** The keys this plan adds over the rung below — the incremental view. */
function incrementalKeys(plan: PlanDefinition, previous: PlanDefinition | null): string[] {
  return Object.entries(plan.features)
    .filter(([k, on]) => on && (!previous || previous.features[k as keyof PlanDefinition["features"]] !== true))
    .map(([k]) => k)
    .sort((a, b) => a.localeCompare(b));
}

function deltaCount(ordered: PlanDefinition[], idx: number): number {
  return incrementalKeys(ordered[idx], idx > 0 ? ordered[idx - 1] : null).length;
}

function Fig({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd
        className="num mt-1.5 text-[21px] font-semibold tracking-[-0.01em]"
        style={{ color: "var(--color-ink)" }}
      >
        {value}
      </dd>
    </div>
  );
}

function StateChip({ color, label }: { color: string; label: string }) {
  return (
    <span
      className="num inline-flex items-center gap-1.5 border px-2.5 py-[2.5px] text-[10.5px] uppercase tracking-[0.08em]"
      style={{ color, borderColor: "currentColor", borderRadius: 2 }}
    >
      <span className="block size-[5px] rounded-full" style={{ background: "currentColor" }} />
      {label}
    </span>
  );
}

function CompareRow({
  label,
  ordered,
  cell,
}: {
  label: string;
  ordered: PlanDefinition[];
  cell: (p: PlanDefinition) => string;
}) {
  return (
    <tr>
      <th
        scope="row"
        className="border-b py-2.5 pr-4 text-[13px] font-normal"
        style={{ borderColor: "var(--color-line)", color: "var(--color-ink-2)" }}
      >
        {label}
      </th>
      {ordered.map((p) => (
        <td
          key={p.tier}
          className="num border-b px-4 py-2.5 text-[13px]"
          style={{ borderColor: "var(--color-line)", color: "var(--color-ink)" }}
        >
          {cell(p)}
        </td>
      ))}
    </tr>
  );
}
