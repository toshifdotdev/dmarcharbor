import Link from "next/link";
import { DomainCheck } from "@/components/domain-check";
import { DnsResolution } from "@/components/dns-resolution";
import { PierMark } from "@/components/mark";
import { PostureBadge } from "@/components/posture";
import { POSTURE_META, type Posture } from "@/lib/posture";
import { readHostBrand, type HostBrand } from "@/lib/host-brand";

/**
 * marketing.tsx — the stranger's surfaces: header, footer, homepage.
 *
 * The first screen says what the product does and who it is for, in plain
 * words. No slogan, no invented customer counts, no logos of companies that
 * never gave us one, no testimonial we cannot produce on request. Every link
 * on these pages resolves to a route that exists — fewer links over dead ones.
 *
 * White-label, same rule as the app: a verified custom domain serves these
 * pages in the AGENCY'S name — its workspace name replaces ours everywhere,
 * its colours come from BrandApplier. An unverified record says so plainly and
 * serves the default brand; half-branded looks like a bug in ours, and the
 * agency must not think their branding is live when it is not. Anything added
 * to the page must honour that: take the name from `brandName(brand)` and never
 * hardcode a colour that would override a brand colour.
 *
 * Plan names, prices and feature names never appear here in code: the pricing
 * page renders all of them from GET /api/plans.
 */

export function HostUnverifiedBanner() {
  return (
    <div
      role="status"
      data-testid="host-unverified"
      className="border-b px-6 py-2 text-center"
      style={{
        borderColor: "var(--color-unverified)",
        background: "var(--color-unverified-soft)",
      }}
    >
      <p className="num text-[11px]" style={{ color: "var(--color-unverified)" }}>
        This custom domain is pointed here but its record is not verified yet:
        the default brand is shown instead of yours. Verify the TXT record to
        serve your branding from this address.
      </p>
    </div>
  );
}

export function brandName(brand: HostBrand): string {
  return brand.state === "verified" ? brand.workspaceName : "DMARC Harbor";
}

/** The legal surface, one row in every footer — the reason nothing used to be
 *  reachable at all was that no footer existed. */
export const LEGAL_FOOTER_LINKS: Array<[string, string]> = [
  ["/privacy", "Privacy"],
  ["/terms", "Terms"],
  ["/dpa", "DPA"],
  ["/refunds", "Refunds"],
  ["/acceptable-use", "Acceptable use"],
  ["/security", "Security"],
  ["/sub-processors", "Sub-processors"],
  ["/complaints", "Complaints"],
  ["/faq", "FAQ"],
  ["/cookies", "Cookies"],
  ["/support", "Support"],
];

export function MarketingHeader({
  brand,
  current,
}: {
  brand: HostBrand;
  current?: "pricing";
}) {
  return (
    <header
      className="mx-auto flex w-full max-w-[1280px] items-center gap-7 border-b px-6 py-4"
      style={{ borderColor: "var(--color-line)" }}
    >
      <Link href="/" className="flex items-center gap-2.5" style={{ color: "var(--color-accent)" }}>
        <PierMark size={25} />
        <span className="text-[15.5px] font-semibold tracking-[-0.015em]" style={{ color: "var(--color-ink)" }}>
          {brandName(brand)}
        </span>
      </Link>
      <nav className="hidden items-center gap-6 sm:flex">
        <Link
          href="/pricing"
          className="text-[13px]"
          style={{ color: current === "pricing" ? "var(--color-ink)" : "var(--color-ink-2)" }}
        >
          Pricing
        </Link>
      </nav>
      <div className="ml-auto flex items-center gap-5">
        <Link href="/sign-in" className="text-[13px]" style={{ color: "var(--color-ink-2)" }}>
          Sign in
        </Link>
        <Link
          href="/sign-up"
          className="rounded-[2px] px-4 py-2 text-[13px] font-semibold"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
        >
          Start free
        </Link>
      </div>
    </header>
  );
}

export function MarketingFooter({ brand }: { brand: HostBrand }) {
  return (
    <footer
      className="mx-auto mt-20 w-full max-w-[1280px] border-t px-6 py-6 pb-14"
      style={{ borderColor: "var(--color-line)", color: "var(--color-ink-3)" }}
    >
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-[12px]">
        <span>{brandName(brand)}: measurement and evidence about email authentication.</span>
        <span className="ml-auto" />
        <Link href="/pricing" className="hover:opacity-80" style={{ color: "var(--color-ink-2)" }}>
          Pricing
        </Link>
        <Link href="/verify" className="hover:opacity-80" style={{ color: "var(--color-ink-2)" }}>
          Public fingerprint verifier
        </Link>
        <Link href="/sign-in" className="hover:opacity-80" style={{ color: "var(--color-ink-2)" }}>
          Sign in
        </Link>
        <Link href="/sign-up" className="hover:opacity-80" style={{ color: "var(--color-ink-2)" }}>
          Start free
        </Link>
      </div>
      <nav
        aria-label="Legal"
        className="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-2 text-[11.5px]"
      >
        {LEGAL_FOOTER_LINKS.map(([href, label]) => (
          <Link key={href} href={href} className="hover:opacity-80" style={{ color: "var(--color-ink-3)" }}>
            {label}
          </Link>
        ))}
      </nav>
    </footer>
  );
}

export async function MarketingHome() {
  const brand = await readHostBrand();
  const name = brandName(brand);

  return (
    <div
      className="relative z-10 min-h-screen"
      data-host-brand={brand.state}
    >
      {brand.state === "unverified" ? <HostUnverifiedBanner /> : null}
      <MarketingHeader brand={brand} />

      <section
        data-testid="home-hero"
        className="relative min-h-[80vh] overflow-hidden"
        style={{ borderColor: "var(--color-line)" }}
      >
        <HarborScene />
        <div className="relative z-10 mx-auto w-full max-w-[1280px] px-6 pt-8 lg:pt-12 pb-12">
          <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[1.12fr_0.72fr]">
            <div className="max-w-[760px]">
              <div className="num text-[11px] uppercase tracking-[0.16em]" style={{ color: "var(--color-ink-3)" }}>
                {name} — measurement and evidence
              </div>
              <h1
                className="mt-4 text-[64px] font-semibold leading-[0.98] tracking-[-0.035em] sm:text-[72px]"
                style={{ fontFamily: "var(--font-display)" }}
                data-testid="home-headline"
              >
                Reports arrive. Posture is measured. Evidence is ready.
              </h1>
              <div className="mt-7 max-w-[62ch] text-[17px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
                <p>
                  <strong style={{ color: "var(--color-ink)" }}>{name}</strong>{" "}
                  collects the aggregate and forensic DMARC reports the domains
                  your clients already publish, measures email authentication
                  posture per domain, and turns the result into evidence you can
                  hand to a client.
                </p>
                <p className="mt-4">
                  It measures and proves. It never edits anyone&apos;s DNS and
                  never sends mail as your clients. Nothing here takes control
                  of customer infrastructure.
                </p>
              </div>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  href="/sign-up"
                  data-testid="home-start"
                  className="rounded-[2px] px-5 py-3 text-[13.5px] font-semibold"
                  style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
                >
                  Start free
                </Link>
                <Link
                  href="/pricing"
                  data-testid="home-pricing"
                  className="rounded-[2px] border px-5 py-3 text-[13.5px] font-semibold"
                  style={{ borderColor: "var(--color-line-strong)", color: "var(--color-ink-2)" }}
                >
                  See pricing
                </Link>
                <Link
                  href="/sign-in"
                  data-testid="home-signin"
                  className="text-[13.5px] underline"
                  style={{ color: "var(--color-ink-2)" }}
                >
                  Sign in
                </Link>
              </div>
            </div>
            <div className="lg:pt-8">
              <DomainCheck />
            </div>
          </div>
        </div>
        <div
          className="pointer-events-none absolute bottom-0 left-0 right-0 h-40"
          style={{ background: "linear-gradient(to top, var(--color-bg), transparent)" }}
          aria-hidden="true"
        />
      </section>

      <section className="mx-auto mt-24 w-full max-w-[1280px] px-6">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
          <div className="max-w-[56ch]">
            <div className="num text-[11px] uppercase tracking-[0.16em]" style={{ color: "var(--color-ink-3)" }}>
              Reports arrive
            </div>
            <h2 className="mt-4 text-[34px] font-semibold leading-[1.05] tracking-[-0.025em]" style={{ fontFamily: "var(--font-display)" }}>
              Reports arrive, get read, leave as evidence.
            </h2>
            <p className="mt-5 text-[16px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
              A provider sends reports to the addresses your domains publish.
              Here they become posture per domain, volumes and senders, and
              evidence you can hand to a client. Nothing takes control of a
              customer&rsquo;s infrastructure.
            </p>
          </div>
          <div className="rounded-[2px] border px-5 py-4 transition-colors duration-200 hover:border-[var(--color-line-strong)]" style={{ borderColor: "var(--color-line)" }}>
            <p className="text-[13.5px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
              Every label is honest: aligned, blocking, unverified, not measured.
              Not measured is not a pass. The same words and the same
              measurements as the portfolio: the free check and the product
              never disagree about a domain.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto mt-24 w-full max-w-[1280px] px-6">
        <div className="max-w-[64ch]">
          <div className="num text-[11px] uppercase tracking-[0.16em]" style={{ color: "var(--color-ink-3)" }}>
            One lookup
          </div>
          <h2 className="mt-4 text-[34px] font-semibold leading-[1.05] tracking-[-0.025em]" style={{ fontFamily: "var(--font-display)" }}>
            One lookup, end to end
          </h2>
          <p className="mt-5 text-[16px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
            Live DNS reading. One lookup is one moment; the product watches
            continuously.
          </p>
        </div>
        <div className="mt-10 overflow-hidden rounded-[2px] border" style={{ borderColor: "var(--color-line)" }}>
          <DnsResolution />
        </div>
        <ul className="mt-6 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          <MiniFact label="DMARC" detail="policy for mail failing alignment: reject, quarantine, none, missing." />
          <MiniFact label="SPF" detail="servers allowed to send as the domain; broken records fail alignment too." />
          <MiniFact label="DKIM" detail="signature receivers check; selectors lost in migration show as missing." />
          <MiniFact label="SPF fail." detail="a source that lost authorisation, or a lookup chain that broke the record." />
          <MiniFact label="DKIM break." detail="a selector that stopped signing, or a key nobody rotated." />
          <MiniFact label="New sender" detail="a source seen for the first time on a client domain." />
          <MiniFact label="Spoofing" detail="traffic claiming the domain that never authenticated, by volume and recurrence." />
        </ul>
      </section>

      <section className="mx-auto mt-24 w-full max-w-[1280px] px-6">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:items-start">
          <ScanExample />
          <div className="max-w-[56ch]">
            <div className="num text-[11px] uppercase tracking-[0.16em]" style={{ color: "var(--color-ink-3)" }}>
              A real result
            </div>
            <h2 className="mt-4 text-[34px] font-semibold leading-[1.05] tracking-[-0.025em]" style={{ fontFamily: "var(--font-display)" }}>
              Four states, not three passes
            </h2>
            <p className="mt-5 text-[15px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
              Every row says one of three things: published, missing, or not
              measured. The third state is the one most tools hide. A record
              nobody has read yet is an unknown, never a pass.
            </p>
            <p className="mt-4 text-[15px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
              The verdict line is derived from the same measurements the
              portfolio keeps, so the free check and the product never disagree
              about a domain.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto mt-24 w-full max-w-[1280px] px-6">
        <div className="max-w-[72ch]">
          <div className="num text-[11px] uppercase tracking-[0.16em]" style={{ color: "var(--color-ink-3)" }}>
            The vocabulary
          </div>
          <h2 className="mt-4 text-[34px] font-semibold leading-[1.05] tracking-[-0.025em]" style={{ fontFamily: "var(--font-display)" }}>
            The four postures
          </h2>
          <p className="mt-5 text-[15px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
            Every domain reads as exactly one of these, and the word is chosen
            from measured report data. Absence of data is not compliance: a
            domain that has never reported is not a passing domain.
          </p>
        </div>
        <ul className="mt-10 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {(Object.keys(POSTURE_META) as Posture[]).map((key) => (
            <li key={key} className="flex flex-col gap-3">
              <PostureBadge posture={key} />
              <p className="text-[14px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
                {POSTURE_META[key].meaning}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mx-auto mt-24 w-full max-w-[1280px] px-6">
        <div className="max-w-[72ch]">
          <div className="num text-[11px] uppercase tracking-[0.16em]" style={{ color: "var(--color-ink-3)" }}>
            Measure, prove, react
          </div>
          <h2 className="mt-4 text-[34px] font-semibold leading-[1.05] tracking-[-0.025em]" style={{ fontFamily: "var(--font-display)" }}>
            Reports arrive; posture is measured; evidence is ready
          </h2>
        </div>
        <div className="mt-10 grid grid-cols-1 gap-10 sm:grid-cols-3">
          <Fact
            title="Measure"
            body="Each domain reads as aligned, blocking, unverified or not measured, from real report data. No reports yet is never a pass."
          />
          <Fact
            title="Prove"
            body="Revocable share links, compliance packs with a published SHA-256 fingerprint, and a public Trust Center any auditor can open."
          />
          <Fact
            title="React"
            body="Spoofing and volume-spike rules to email or Slack, scheduled digests, and surfaced delivery failures."
          />
        </div>
        <ol className="mt-10 grid grid-cols-1 gap-8 sm:grid-cols-3">
          <Step n={1} title="Add a client and domains" body="Clients group domains; adding one gives records to publish." />
          <Step n={2} title="Publish the records" body="Values come verbatim; re-check while DNS propagates. Waiting is normal." />
          <Step n={3} title="Reports arrive" body="Usually within 24 to 48 hours. The portfolio fills in; evidence artefacts follow." />
        </ol>
      </section>

      <section className="mx-auto mt-24 w-full max-w-[1280px] px-6">
        <div className="rounded-[2px] border px-8 py-10" style={{ borderColor: "var(--color-line-strong)", background: "var(--color-surface)" }}>
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
            <div className="max-w-[64ch]">
              <h2 className="text-[34px] font-semibold leading-[1.05] tracking-[-0.025em]" style={{ fontFamily: "var(--font-display)" }}>
                Measurement and evidence, not control
              </h2>
              <p className="mt-5 text-[16px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
                We never edit anyone&apos;s DNS and never send mail as your
                clients. Recipient addresses in forensic reports are hashed by
                default; named mode expires in seven days on every plan. Export
                and erasure are on every plan too, free included, because they
                are rights rather than features. One account, as many workspaces
                as your plan allows.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-4 lg:justify-end">
              <Link
                href="/sign-up"
                className="rounded-[2px] px-5 py-3 text-[13.5px] font-semibold"
                style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
              >
                Create an account
              </Link>
              <Link href="/pricing" className="text-[13.5px] underline" style={{ color: "var(--color-ink-2)" }}>
                See pricing
              </Link>
            </div>
          </div>
        </div>
      </section>

      <MarketingFooter brand={brand} />
    </div>
  );
}

/**
 * The harbor: three tide waves washing right to left, and reports flowing
 * through the channel between them, each resolving into one of the four posture
 * shapes. Purely decorative, hence aria-hidden and pointer-events-none: a
 * screen reader has no use for it and it must never swallow a click meant for
 * the lookup behind it.
 *
 * SVG and CSS only. No canvas, no WebGL, nothing that would delay first paint
 * on the page a stranger lands on. The hero content is not wrapped in this and
 * never starts transparent, so the headline and the lookup paint immediately.
 *
 * Rule One holds: the only colour here is the four postures, plus the bone and
 * grey of the line token. Motion stops entirely under prefers-reduced-motion.
 */
function HarborScene() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ opacity: 0.78 }}
    >
      <svg
        viewBox="0 0 1680 540"
        preserveAspectRatio="xMidYMid slice"
        width="100%"
        height="100%"
        fill="none"
        style={{ position: "absolute", inset: 0, display: "block" }}
      >
        <g stroke="var(--color-line-strong)" strokeWidth="1.5" strokeLinecap="round">
          {/*
            Each wave repeats every 760 units, and the animation shifts by exactly
            760. Shifting by a non-multiple of the period makes the restart visible
            as a jump; shifting by one period keeps it seamless.

            The path also runs one full period further right than the viewport needs,
            to x=2840 rather than 2080, because after shifting left by 760 the right
            edge must still cover the viewport: ending at 2080 would leave the last
            360 units of a wide screen with no wave on it.
          */}
          <path className="tide-wave-1" d="M-200 170 Q 180 110, 560 170 T 1320 170 T 2080 170 T 2840 170" />
          <path className="tide-wave-2" d="M-200 300 Q 180 240, 560 300 T 1320 300 T 2080 300 T 2840 300" />
          <path className="tide-wave-3" d="M-200 440 Q 180 380, 560 440 T 1320 440 T 2080 440 T 2840 440" />
        </g>
        <g className="tide-report tide-report-1" fill="var(--color-pass)">
          <rect width="10" height="10" rx="2" />
        </g>
        <g className="tide-report tide-report-2" fill="var(--color-pass)">
          <rect width="10" height="10" rx="1" />
        </g>
        <g className="tide-report tide-report-3" fill="var(--color-block)">
          {/*
            The 45 degree rotation sits on the rect, not on this group.

            The CSS animation sets `transform` on the group, and a CSS transform
            overrides an SVG transform attribute on the SAME element. It used to be
            written as transform="rotate(45)" on this group, so the moment the
            animation ran the diamond fell back to an axis-aligned square: every
            blocking posture in the hero became an aligned one, on the one element
            whose whole job is to show the difference between the four shapes.
          */}
          <rect width="10" height="10" rx="1" transform="rotate(45 5 5)" />
        </g>
        <g className="tide-report tide-report-4" stroke="var(--color-unverified)" fill="none">
          <circle cx="5" cy="5" r="5" />
        </g>
        <g className="tide-report tide-report-5" fill="var(--color-unmeasured)">
          <rect width="10" height="10" rx="1" />
        </g>
        {/*
          No brand-name text element in the scene.

          It was here, at low opacity on the right, but the label above the
          headline already carries the name, so it read as a duplicate. It also
          overflowed the viewBox on a long agency name, which is the one string
          on this page whose length we do not control.
        */}
      </svg>
      <style>{`
        .tide-wave-1 { animation: tide-wash 26s linear infinite; }
        .tide-wave-2 { animation: tide-wash 32s linear infinite; }
        .tide-wave-3 { animation: tide-wash 38s linear infinite reverse; }
        .tide-report { animation: report-flow 12s cubic-bezier(.4,.1,.2,1) infinite; }
        .tide-report-1 { animation-delay: 0s; }
        .tide-report-2 { animation-delay: 2.4s; }
        .tide-report-3 { animation-delay: 4.8s; }
        .tide-report-4 { animation-delay: 7.2s; }
        .tide-report-5 { animation-delay: 9.6s; }
        @keyframes tide-wash {
          from { transform: translateX(0); }
          to   { transform: translateX(-760px); }
        }
        @keyframes report-flow {
          0%   { opacity: 0; transform: translate(-180px, 170px) scale(0.6); }
          10%  { opacity: 0.85; transform: translate(240px, 170px) scale(1); }
          38%  { transform: translate(560px, 300px) scale(1); }
          62%  { transform: translate(880px, 300px) scale(1); }
          85%  { transform: translate(1200px, 440px) scale(1); }
          100% { opacity: 0; transform: translate(1700px, 440px) scale(0.6); }
        }
        .tide-label { opacity: 0.5; }
        @media (prefers-reduced-motion: reduce) {
          .tide-wave-1, .tide-wave-2, .tide-wave-3,
          .tide-report {
            animation: none;
          }
          .tide-report { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}

function MiniFact({ label, detail }: { label: string; detail: string }) {
  return (
    <li className="flex items-baseline gap-2">
      <span className="num w-[78px] shrink-0 text-[10px] uppercase tracking-[0.13em]" style={{ color: "var(--color-ink-3)" }}>
        {label}
      </span>
      <span className="text-[12px] leading-[1.55]" style={{ color: "var(--color-ink-2)" }}>
        {detail}
      </span>
    </li>
  );
}

/** The shape of a real scan result, with a redacted domain: the pattern the
 *  free check produces, shown before anyone types. RFC 2606 reserved domains
 *  only: an example must never be a real company. */
function ScanExample() {
  const rows: Array<[string, boolean | null, string]> = [
    ["DMARC", true, "p=reject. Mail that fails alignment is refused by receivers."],
    ["SPF", true, "Published and valid."],
    ["DKIM", false, "No selector found."],
  ];
  return (
    <div
      className="rounded-[2px] border px-5 py-4 transition-colors duration-200 hover:border-[var(--color-line-strong)]"
      style={{ borderColor: "var(--color-line-strong)", background: "var(--color-surface)" }}
      data-testid="scan-example"
    >
      <div className="flex flex-wrap items-baseline gap-x-4">
        <span className="num text-[13px]" style={{ color: "var(--color-ink)" }}>your-client.example</span>
        <span className="num text-[11px] uppercase tracking-[0.12em]" style={{ color: "var(--color-unverified)" }}>needs attention</span>
      </div>
      <div className="mt-4">
        {rows.map(([label, found, detail]) => (
          <div
            key={label}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b py-2"
            style={{ borderColor: "var(--color-line)" }}
          >
            <span className="num w-[84px] shrink-0 text-[11px] uppercase tracking-[0.12em]" style={{ color: "var(--color-ink-3)" }}>
              {label}
            </span>
            <span
              className="num text-[11px] uppercase tracking-[0.12em]"
              style={{
                color:
                  found === true
                    ? "var(--color-pass)"
                    : found === false
                      ? "var(--color-unverified)"
                      : "var(--color-unmeasured)",
              }}
            >
              {found === true ? "published" : found === false ? "missing" : "not measured"}
            </span>
            <span className="flex-1 text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
              {detail}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Fact({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h3 className="text-[16px] font-semibold tracking-[-0.012em]" style={{ color: "var(--color-ink)" }}>
        {title}
      </h3>
      <p className="mt-2 text-[13.5px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
        {body}
      </p>
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div>
      <div className="num text-[11px] tracking-[0.16em]" style={{ color: "var(--color-ink-3)" }}>
        {String(n).padStart(2, "0")}
      </div>
      <h3 className="mt-1.5 text-[15px] font-semibold tracking-[-0.012em]" style={{ color: "var(--color-ink)" }}>
        {title}
      </h3>
      <p className="mt-2 text-[13.5px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
        {body}
      </p>
    </div>
  );
}
