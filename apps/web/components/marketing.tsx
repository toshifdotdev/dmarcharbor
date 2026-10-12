import Link from "next/link";
import { PierMark } from "@/components/mark";
import { Reveal } from "@/components/reveal";
import { DomainCheck } from "@/components/domain-check";
import { DnsResolution } from "@/components/dns-resolution";
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
 * agency must not think their branding is live when it is not.
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

/** The name on every branded line: the agency's on a verified custom domain,
 *  ours otherwise. Never both at once. */
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
      className="mx-auto flex w-full max-w-[1040px] items-center gap-7 border-b px-6 py-4"
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
      className="mx-auto mt-14 w-full max-w-[1040px] border-t px-6 py-6 pb-14"
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
      {/* The legal surface, reachable from every screen — a footer that omits
          them is why nothing used to be reachable at all. */}
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
    <div className="relative z-10 min-h-screen" data-host-brand={brand.state}>
      {brand.state === "unverified" ? <HostUnverifiedBanner /> : null}
      <MarketingHeader brand={brand} />

      {/* Hero: what it does and the free check on the same screen.

          Deliberately NOT wrapped in Reveal. The hero is the largest
          contentful paint, and a reveal animation holds it at opacity 0 until
          the script runs, which delays the paint and means the strongest
          argument on the page is invisible for as long as JS takes. Everything
          below the fold animates; the first screen does not wait for anything. */}
      <section
        className="mx-auto w-full max-w-[1040px] px-6 pt-10"
        data-testid="home-hero"
      >
        <div className="grid grid-cols-1 gap-x-10 gap-y-7 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
          <div>
            <div className="label">DMARC reports, read where they arrive</div>
            <h1
              className="mt-4 text-[44px] font-semibold leading-[1.08] tracking-[-0.032em] sm:text-[52px]"
              style={{ fontFamily: "var(--font-display)" }}
              data-testid="home-headline"
            >
              DMARC reports for MSPs managing client domains.
            </h1>
            <div className="mt-6 max-w-[58ch] text-[15px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
              <p>
                <strong style={{ color: "var(--color-ink)" }}>{name}</strong> collects the
                aggregate and forensic DMARC reports the domains your clients
                already publish, measures whether their email authentication holds
                up, and turns the result into evidence you can hand over.
              </p>
              <p className="mt-4">
                It measures and proves. It never edits anyone’s DNS and never sends
                mail as your clients: nothing here takes control of a customer’s
                infrastructure.
              </p>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Link
                href="/sign-up"
                data-testid="home-start"
                className="rounded-[2px] px-5 py-2.5 text-[13.5px] font-semibold"
                style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
              >
                Start free
              </Link>
              <Link
                href="/pricing"
                data-testid="home-pricing"
                className="rounded-[2px] border px-5 py-2.5 text-[13.5px] font-semibold"
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
          <div>
            <DomainCheck />
          </div>
        </div>
      </section>

      {/* Reports arrive: what the product does, compact. */}
      <section className="mx-auto mt-16 w-full max-w-[1040px] px-6">
  <Reveal>
        <div className="grid grid-cols-1 gap-x-8 gap-y-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
          <div>
            <h2
              className="text-[26px] font-semibold tracking-[-0.028em]"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Reports arrive, get read, leave as evidence.
            </h2>
            <p className="mt-4 max-w-[52ch] text-[14px] leading-[1.7]" style={{ color: "var(--color-ink-2)" }}>
              A provider sends reports to the addresses your domains publish.
              Here they become posture per domain, volumes and senders, and
              evidence you can hand to a client. Nothing takes control of a
              customer’s infrastructure.
            </p>
          </div>
          <div className="rounded-[2px] border px-5 py-4 transition-colors duration-200 hover:border-[var(--color-line-strong)]" style={{ borderColor: "var(--color-line)" }}>
            <p className="text-[13px] leading-[1.7]" style={{ color: "var(--color-ink-2)" }}>
              Every label is honest: aligned, blocking, unverified, not measured.
              Not measured is not a pass. The same words and the same
              measurements as the portfolio: the free check and the product never
              disagree about a domain.
            </p>
          </div>
        </div>
      </Reveal>
</section>

      {/* One lookup, end to end: DNS records, read live. */}
      <section className="mx-auto mt-16 w-full max-w-[1040px] px-6">
  <Reveal>
        <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <h2 className="text-[26px] font-semibold tracking-[-0.028em]" style={{ fontFamily: "var(--font-display)" }}>
            One lookup, end to end
          </h2>
          <p className="max-w-[52ch] text-[12.5px] leading-[1.6]" style={{ color: "var(--color-ink-3)" }}>
            Live DNS reading. One lookup is one moment; the product watches
            continuously.
          </p>
        </div>
        <div
          className="overflow-hidden rounded-[2px] border"
          style={{ borderColor: "var(--color-line)" }}
        >
          <DnsResolution />
        </div>
        <ul className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
          <MiniFact label="DMARC" detail="policy for mail failing alignment: reject / quarantine / none / missing." />
          <MiniFact label="SPF" detail="servers allowed to send as the domain; broken records fail alignment too." />
          <MiniFact label="DKIM" detail="signature receivers check; selectors lost in migration show as missing." />
          <MiniFact label="SPF fail." detail="a source that lost authorisation, or a lookup chain that broke the record." />
          <MiniFact label="DKIM break." detail="a selector that stopped signing, or a key nobody rotated." />
          <MiniFact label="New sender" detail="a source seen for the first time on a client domain." />
          <MiniFact label="Spoofing" detail="traffic claiming the domain that never authenticated, by volume & recurrence." />
        </ul>
        <p
          className="mt-4 text-[12.5px] leading-[1.6]"
          style={{ color: "var(--color-ink-3)" }}
          data-testid="domain-check-boundary"
        >
          <Link href="/sign-up" className="underline" style={{ color: "var(--color-ink)" }}>
            Start monitoring free
          </Link>{" "}
          to read every client domain as reports arrive.
        </p>
      </Reveal>
</section>

      {/* A worked example: a real result's shape, domain redacted. */}
      <section className="mx-auto mt-10 w-full max-w-[1040px] px-6">
  <Reveal>
        <h2 className="text-[26px] font-semibold tracking-[-0.028em]" style={{ fontFamily: "var(--font-display)" }}>
          What a result looks like
        </h2>
        <div className="mt-8 grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-2">
          <ScanExample />
          <div className="max-w-[52ch] text-[14px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
            <p>
              Every row says one of three things: published, missing, or not
              measured. The third state is the one most tools hide. A record
              nobody has read yet is an unknown, never a pass.
            </p>
            <p className="mt-4">
              The verdict line is derived from the same measurements the
              portfolio keeps, so the free check and the product never disagree
              about a domain.
            </p>
          </div>
        </div>
      </Reveal>
</section>

      {/* The five postures: the core idea of the product. */}
      <section className="mx-auto mt-10 w-full max-w-[1040px] px-6">
  <Reveal>
        <h2 className="text-[26px] font-semibold tracking-[-0.028em]" style={{ fontFamily: "var(--font-display)" }}>
          The five postures
        </h2>
        <p className="mt-4 max-w-[68ch] text-[14px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
          Every domain reads as exactly one of these, and the word is chosen
          from measured report data. Absence of data is not compliance: a domain
          that has never reported is not a passing domain.
        </p>
        <ul className="mt-8 grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2">
          {(Object.keys(POSTURE_META) as Posture[]).map((key) => (
            <li key={key} className="flex flex-col gap-1.5">
              <PostureBadge posture={key} />
              <p className="max-w-[46ch] text-[13px] leading-[1.7]" style={{ color: "var(--color-ink-2)" }}>
                {POSTURE_META[key].meaning}
              </p>
              <p className="num text-[11px] uppercase tracking-[0.13em]" style={{ color: "var(--color-ink-3)" }}>
                Action: {POSTURE_META[key].action}
              </p>
            </li>
          ))}
        </ul>
      </Reveal>
</section>

      {/* How it works in practice: measure, prove, react. */}
            <section className="mx-auto mt-16 w-full max-w-[1040px] px-6">
  <Reveal>
        <h2 className="text-[26px] font-semibold tracking-[-0.028em]" style={{ fontFamily: "var(--font-display)" }}>
          Measure, prove, react.
        </h2>
        <div className="mt-6 grid grid-cols-1 gap-x-8 gap-y-8 sm:grid-cols-3">
          <Fact
            title="Measure"
            body="Each domain reads as aligned, blocking, unverified, or not measured, from real report data. No reports yet is never a pass."
          />
          <Fact
            title="Prove"
            body="Revocable share links, compliance packs with a SHA-256 fingerprint, and a public Trust Center anyone can open without an account."
          />
          <Fact
            title="React"
            body="Spoofing and volume-spike rules to email or Slack, scheduled digests, and surfaced delivery failures. No silent channel reads as healthy."
          />
        </div>
        <ol className="mt-5 grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-3">
          <Step n={1} title="Add a client and domains" body="Clients group domains; adding one gives records to publish." />
          <Step n={2} title="Publish the records" body="Values come verbatim; re-check while DNS propagates." />
          <Step n={3} title="Reports arrive" body="Within 24 to 48 hours." />
        </ol>
  </Reveal>
      </section>

      {/* Closing: trust position and call to action, in one surface. */}
      <section className="mx-auto mt-10 w-full max-w-[1040px] px-6">
  <Reveal>
        <div
          className="rounded-[2px] border px-8 py-9"
          style={{ borderColor: "var(--color-line-strong)", background: "var(--color-surface)" }}
        >
          <div className="grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
            <div>
              <h2 className="max-w-[40ch] text-[26px] font-semibold tracking-[-0.028em]" style={{ fontFamily: "var(--font-display)" }}>
                Measurement and evidence, not control.
              </h2>
              <p className="mt-4 max-w-[62ch] text-[14px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
                We never edit anyone’s DNS and never send mail as your clients.
                Export and erasure are available on every plan, free included,
                because they are rights rather than features. One account, as
                many workspaces as your plan allows.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-4 lg:justify-end">
              <Link
                href="/sign-up"
                className="rounded-[2px] px-5 py-2.5 text-[13.5px] font-semibold"
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
      </Reveal>
</section>

      <MarketingFooter brand={brand} />
    </div>
  );
}

/** The shape of a real scan result, with a redacted domain: the pattern the
 *  free check produces, shown before anyone types. RFC 2606 reserved domains
 *  only: an example must never be a real company. */
function ScanExample() {
  // The same record the hero box and the lookup section show: one page, one
  // demonstration. A second example with a different policy and verdict reads
  // as two products disagreeing about the same domain.
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
        <span className="num text-[13px]" style={{ color: "var(--color-ink)" }}>
          your-client.example
        </span>
        <span className="num text-[11px] uppercase tracking-[0.12em]" style={{ color: "var(--color-unverified)" }}>
          needs attention
        </span>
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


function MiniFact({ label, detail }: { label: string; detail: string }) {
  return (
    <li className="flex items-baseline gap-2">
      <span
        className="num w-[78px] shrink-0 text-[10px] uppercase tracking-[0.13em]"
        style={{ color: "var(--color-ink-3)" }}
      >
        {label}
      </span>
      <span className="text-[12px] leading-[1.55]" style={{ color: "var(--color-ink-2)" }}>
        {detail}
      </span>
    </li>
  );
}


function Fact({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h3 className="text-[15px] font-semibold tracking-[-0.012em]" style={{ color: "var(--color-ink)" }}>
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
