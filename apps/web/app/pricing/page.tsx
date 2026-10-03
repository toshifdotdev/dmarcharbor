import Link from "next/link";
import { getBillingCurrency, getPlanCatalog } from "@/lib/api-ops";
import { formatMinor } from "@/lib/money";
import { featureLabel } from "@/lib/feature-label";
import { readHostBrand } from "@/lib/host-brand";
import { pickActiveWorkspace } from "@/lib/session";
import { listWorkspaces } from "@/lib/api";
import type { PlanDefinition, PlanPriceMinor } from "@/lib/types";
import {
  HostUnverifiedBanner,
  MarketingFooter,
  MarketingHeader,
  brandName,
} from "@/components/marketing";
import { PricingControls, type PricingCurrency, type PricingInterval } from "@/components/pricing-controls";

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

/** The currencies that can actually be CHARGED. The catalog carries both USD
 *  and INR prices, but the catalog is not what a checkout can complete: at
 *  launch INR routes to Razorpay (live) and USD to Paddle (not approved), so a
 *  USD price on the page would promise a checkout the API refuses — worse than
 *  showing no USD at all. This is the launch state's own truth, not an edge
 *  case; when GET /api/capabilities lands (its owner's call), its `currencies`
 *  list replaces this and the tab appears with no frontend release. */
function purchasableCurrencies(): Array<"INR" | "USD"> {
  return ["INR"];
}

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ currency?: string; interval?: string }>;
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
  const { currency: wanted, interval: wantedInterval } = await searchParams;
  const currency: PricingCurrency =
    preference?.preferredCurrency ??
      (wanted === "USD" || wanted === "INR" ? wanted : "INR");
  // Monthly is the honest default: it is the number a reader compares, and
  // annual is the discount they opt into: never the reverse.
  const interval: PricingInterval =
    wantedInterval === "annual" ? "annual" : "monthly";

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
            The plan catalog did not load. Nothing is being hidden: the
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
  // on: derived, never named in code.
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
          All of them are on this screen. Monthly in {purchasableCurrencies().length > 1 ? "INR and USD" : currency === "INR" ? "INR" : "USD"}, annual where
          it saves you two months. The words about what each plan buys are
          below, where scrolling is fine. <strong style={{ color: "var(--color-ink)" }}>
          {name}</strong> never prices data portability or erasure: those are on
          every plan.
        </p>
        <div className="w-full">
          <PricingControls
            currency={currency}
            interval={interval}
            locked={preference?.locked ?? false}
            reason={preference?.reason ?? null}
            persistable={Boolean(organizationId)}
            organizationId={organizationId}
            availableCurrencies={purchasableCurrencies()}
          />
        </div>
      </section>

      {/* The row of figures. */}
      <section className="mx-auto w-full max-w-[1180px] px-6 pt-7">
        <div className="grid grid-cols-1 border-t sm:grid-cols-2 xl:grid-cols-4" style={{ borderColor: "var(--color-line-strong)" }}>
          {ordered.map((plan, idx) => {
            // The headline figure is the currency the visitor is quoted: the
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
                {/* Descriptor: the API sentence, sentence case, and a
                    FIXED height — two lines at any column width — so the
                    figure and button below land on the same line in every
                    column whatever the copy does. */}
                <p
                  className="min-h-[2.9em] text-[13px] leading-[1.45]"
                  style={{ color: "var(--color-ink-3)" }}
                >
                  {plan.descriptor}
                </p>
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

                {/* ONE figure for the selected interval, in the quoted
                    currency — and only that one. Tabular figures, so $0, $29,
                    $149 and $399 occupy consistent widths and the columns
                    align against something. The symbol sits ON the digits'
                    baseline at one sizing rule for both glyphs (57% of digit
                    height, tight tracking) — $ and ₹ read as one system. */}
                {/* ONE figure for the selected interval, in the quoted
                    currency. Tabular figures, so $0, $29, $149 and $399
                    occupy consistent widths and the columns align against
                    something. The symbol sits ON the digits' baseline at one
                    optical size: the dollar renders at 57% of digit height,
                    the rupee at 52% because its ascender runs taller and the
                    same em would make it look the larger glyph. Both are
                    baseline-aligned by the row's items-baseline, never
                    raised. */}
                <div
                  className="mt-4 flex min-h-[56px] items-baseline text-[56px] font-semibold leading-none tracking-[-0.02em]"
                  style={{ fontFamily: "var(--font-display)", fontVariantNumeric: "tabular-nums" }}
                >
                  <span
                    style={{ color: "var(--color-ink-2)", letterSpacing: "0", fontSize: currency === "USD" ? "0.57em" : "0.52em", lineHeight: 1 }}
                  >
                    {currency === "USD" ? "$" : "₹"}
                  </span>
                  <span data-testid={`plan-price-${plan.tier}`}>{shownMajor(lead, interval)}</span>
                  {shownFraction(lead, interval) ? (
                    <span style={{ color: "var(--color-ink-2)", letterSpacing: "0", fontSize: "0.57em", lineHeight: 1 }}>
                      .{shownFraction(lead, interval)}
                    </span>
                  ) : null}
                </div>

                {/* Secondary lines — the cadence and the local-currency
                    equivalent, the second most important text on the page: a
                    readable size and weight, lifted off the background.
                    FIXED height sized to the tallest state (three lines: the
                    annual saving is the third) rather than the shortest, so
                    nothing overflows the block and pushes the button down. */}
                <div
                  className="num mt-2.5 flex min-h-[68px] flex-col gap-1 text-[13.5px] leading-[1.45]"
                  style={{ color: "var(--color-ink-2)" }}
                >
                  {lead.monthlyMinor === 0 && lead.annualMinor === 0 ? (
                    // Free says ONE thing, not three restatements of zero.
                    <span style={{ fontWeight: 500, color: "var(--color-ink)" }}>Free. No card, ever.</span>
                  ) : (
                    <>
                      <span style={{ fontWeight: 500, color: "var(--color-ink)" }}>
                        {formatMinor(shownMinor(lead, interval), currency)} per {interval === "monthly" ? "month" : "year"}
                      </span>
                      {/* Short form: the equivalent, not a sentence that
                          competes with the figure. */}
                      <span style={{ color: "var(--color-ink-2)" }}>
                        ≈ {formatMinor(shownMinor(other, interval), otherCode)}
                      </span>
                      {/* Annual states the saving as a saving — the reader
                          never does the ten-for-twelve arithmetic. */}
                      {interval === "annual" ? (
                        <span style={{ color: "var(--color-pass)", fontWeight: 500 }}>
                          10 months for 12: save 2 months
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
                <Link
                  href="/sign-up"
                  data-testid={`plan-cta-${plan.tier}`}
                  className="mt-4 w-full rounded-[2px] px-4 py-2.5 text-center text-[13px] font-semibold"
                  style={
                    rec
                      ? { background: "var(--color-accent)", color: "var(--color-accent-ink)", border: "1px solid var(--color-accent)" }
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
          render as a pass: at any price.
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
          Unknown never renders as a pass: at any price.
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
            and move up a rung when the portfolio asks for it: a plan change
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

/** The price of the SELECTED interval, as one figure. */
function shownMinor(price: PlanPriceMinor, interval: PricingInterval): number {
  return interval === "monthly" ? price.monthlyMinor : price.annualMinor;
}

function shownMajor(price: PlanPriceMinor, interval: PricingInterval): number {
  return Math.trunc(shownMinor(price, interval) / 100);
}

function shownFraction(price: PlanPriceMinor, interval: PricingInterval): string {
  const rest = shownMinor(price, interval) % 100;
  return rest === 0 ? "" : String(rest).padStart(2, "0");
}

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
