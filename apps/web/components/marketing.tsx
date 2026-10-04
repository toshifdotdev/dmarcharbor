import Link from "next/link";
import { PierMark } from "@/components/mark";
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
      className="mx-auto flex w-full max-w-[1180px] items-center gap-7 border-b px-6 py-4"
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
      className="mx-auto mt-14 w-full max-w-[1180px] border-t px-6 py-6 pb-14"
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
        className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-2 text-[11.5px]"
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

      {/* First screen: what it does and who it is for, with the free check as
          the hero action. The hook belongs above the fold: the strongest thing
          a stranger can do here is check their own domain, so that is the
          primary action and the account CTA is the secondary one. */}
      <section className="mx-auto w-full max-w-[1180px] px-6 pt-12" data-testid="home-hero">
        <div className="grid grid-cols-1 gap-x-12 gap-y-9 lg:grid-cols-[1.02fr_0.98fr]">
          <div>
            <div className="label">DMARC monitoring for client domains</div>
            <h1
              className="mt-3 text-[40px] font-semibold leading-[1.12] tracking-[-0.032em]"
              style={{ fontFamily: "var(--font-display)" }}
              data-testid="home-headline"
            >
              DMARC reports for MSPs managing client domains.
            </h1>
            <div className="mt-5 max-w-[52ch] text-[14.5px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
              <p>
                <strong style={{ color: "var(--color-ink)" }}>{name}</strong> collects the
                aggregate and forensic DMARC reports the domains your clients own
                already publish, measures whether their email authentication holds
                up, and turns the result into evidence you can hand over: a report
                share link, a compliance pack with a published fingerprint, a client
                portal in your brand.
              </p>
              <p className="mt-3">
                It measures and proves. It never edits anyone’s DNS and never
                sends mail as your clients: nothing here takes control of a
                customer’s infrastructure.
              </p>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link
                href="/sign-up"
                data-testid="home-start"
                className="rounded-[2px] border px-5 py-2.5 text-[13.5px] font-semibold"
                style={{ borderColor: "var(--color-line-strong)", color: "var(--color-ink-2)" }}
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

          {/* The free check: anonymous, ungated, and honest about what it is
              not. In the hero, because it is the fastest way for a stranger to
              see the product working on their own domain. */}
          <div className="lg:pt-2">
            <DomainCheck />
          </div>
        </div>
      </section>

      {/* The lookup, end to end: the one animation here, and the things it
          finds. SVG and CSS only, played once, reduced-motion aware. */}
      <section className="mx-auto mt-10 w-full max-w-[1180px] px-6">
        <h2 className="text-[23px] font-semibold tracking-[-0.028em]" style={{ fontFamily: "var(--font-display)" }}>
          One lookup, end to end
        </h2>
        <div className="mt-6 grid grid-cols-1 items-start gap-x-10 gap-y-8 lg:grid-cols-2">
          {/* The lookup box hugs its content: a fixed-height rectangle left a
              tall empty area below the caption, and an empty bordered
              rectangle reads as a broken component. */}
          <DnsResolution />
          <div>
            <h3 className="text-[15px] font-semibold tracking-[-0.012em]" style={{ color: "var(--color-ink)" }}>
              What the three rows mean
            </h3>
            <div className="mt-3 flex flex-col gap-3.5">
              <Fact
                title="DMARC"
                body="The policy domain owners publish for mail that fails alignment: reject refuses it, quarantine filters it to spam or holds it, and none only reports it. No policy published means receivers decide on their own."
              />
              <Fact
                title="SPF"
                body="The list of servers allowed to send as the domain. Published but not validating means the record itself is broken, which fails alignment just as surely as an unauthorised sender."
              />
              <Fact
                title="DKIM"
                body="The cryptographic signature receivers check. At least one selector published is a start; a migration or a key nobody rotated shows up here as a missing selector."
              />
            </div>
            <h3 className="mt-7 text-[15px] font-semibold tracking-[-0.012em]" style={{ color: "var(--color-ink)" }}>
              What it catches
            </h3>
            <dl className="mt-3 flex flex-col gap-3.5">
              <Fact
                title="SPF failures"
                body="A sending source that is no longer authorised, or a lookup limit that broke the record. Both show up as mail failing alignment."
              />
              <Fact
                title="DKIM breaks"
                body="A selector that stopped signing after a migration, or a key nobody rotated. The signature is missing and the report says so."
              />
              <Fact
                title="New senders"
                body="A source seen for the first time on a client domain: a new tool the client forgot to mention, or someone testing the fence."
              />
              <Fact
                title="Spoofing attempts"
                body="Traffic claiming a client’s domain that never authenticated. Volume and recurrence are tracked, so one attempt and a campaign read differently."
              />
            </dl>
          </div>
        </div>
        <p
          className="mt-8 max-w-[68ch] text-[13.5px] leading-[1.75]"
          style={{ color: "var(--color-ink-3)" }}
          data-testid="domain-check-boundary"
        >
          One lookup is one moment. {name} watches a whole book of client
          domains continuously: posture per domain as reports arrive, alerting,
          shareable evidence and a client portal. That is the difference between
          checking a domain and being responsible for it.{" "}
          <Link href="/sign-up" className="underline" style={{ color: "var(--color-ink)" }}>
            Start monitoring free
          </Link>
          .
        </p>
      </section>

      {/* A worked example: a real result's shape, domain redacted. */}
      <section className="mx-auto mt-16 w-full max-w-[1180px] px-6">
        <h2 className="text-[23px] font-semibold tracking-[-0.028em]" style={{ fontFamily: "var(--font-display)" }}>
          What a result looks like
        </h2>
        <div className="mt-6 grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-2">
          <ScanExample />
          <div className="max-w-[52ch] text-[14px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
            <p>
              Every row says one of three things: published, missing, or not
              measured. The third state is the one most tools hide. A record
              nobody has read yet is an unknown, never a pass.
            </p>
            <p className="mt-3">
              The verdict line is derived from the same measurements the
              portfolio keeps, so the free check and the product never disagree
              about a domain.
            </p>
          </div>
        </div>
      </section>

      {/* The five postures: the core idea of the product. */}
      <section className="mx-auto mt-16 w-full max-w-[1180px] px-6">
        <h2 className="text-[23px] font-semibold tracking-[-0.028em]" style={{ fontFamily: "var(--font-display)" }}>
          The five postures
        </h2>
        <p className="mt-3 max-w-[68ch] text-[14px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
          Every domain reads as exactly one of these, and the word is chosen
          from measured report data. Absence of data is not compliance: a domain
          that has never reported is not a passing domain.
        </p>
        <ul className="mt-6 grid grid-cols-1 gap-x-10 gap-y-5 sm:grid-cols-2">
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
      </section>

      {/* What it does — the real surfaces, described as behaviour. */}
      <section className="mx-auto mt-16 w-full max-w-[1180px] px-6">
        <h2 className="text-[23px] font-semibold tracking-[-0.028em]" style={{ fontFamily: "var(--font-display)" }}>
          What it does
        </h2>
        <div className="mt-6 grid grid-cols-1 gap-x-10 gap-y-7 sm:grid-cols-2">
          <Fact
            title="Posture, measured per domain"
            body="Each domain reads as aligned, blocking, unverified or not measured: derived from real report data, never asserted. A domain with no reports yet says so; it never renders as a pass. A signal that has gone stale says that instead."
          />
          <Fact
            title="Reports, collected two ways"
            body="Aggregate and forensic reports arrive from the rua and ruf tags domains already publish. When a provider will only email them, point the domain at the shared report mailbox instead: no customer ever hands over their own IMAP credentials."
          />
          <Fact
            title="Evidence, ready to hand over"
            body="Share a report through a link you can revoke, issue a compliance pack with a SHA-256 fingerprint anyone can verify at a public page, and publish a Trust Center an auditor opens with no account. Forensic evidence is never shown to a client portal contact."
          />
          <Fact
            title="Alerts and digests"
            body="Rules for spoofing attempts and volume spikes, delivered by email or to a Slack channel, plus scheduled client digests. Failure to deliver is surfaced: a quiet alert channel is never a working one."
          />
        </div>
      </section>

      {/* Who it is for, and what an MSP actually does with it. */}
      <section className="mx-auto mt-16 w-full max-w-[1180px] px-6">
        <h2 className="text-[23px] font-semibold tracking-[-0.028em]" style={{ fontFamily: "var(--font-display)" }}>
          Who it is for
        </h2>
        <p className="mt-4 max-w-[68ch] text-[14.5px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
          Agencies and MSPs who look after email authentication for a book of
          clients. A workspace holds many clients; each client holds its
          domains; your team gets roles with real boundaries, and each client
          can get a read-only portal in your brand rather than a PDF you
          assemble by hand. If you only monitor your own domains, it works for
          that too: the portfolio is the same either way.
        </p>
        <div className="mt-7 grid grid-cols-1 gap-x-10 gap-y-7 sm:grid-cols-3">
          <Fact
            title="Monday: the portfolio"
            body="Open the workspace and read posture across every client domain at once. Blocking and unverified sort to the top, so the week starts with the two lists that actually need a human."
          />
          <Fact
            title="Wednesday: the evidence"
            body="A client or their auditor asks what their mail authentication actually did. Issue a compliance pack with a published fingerprint, or hand over a share link you can revoke: no screenshots, no spreadsheet built by hand."
          />
          <Fact
            title="Whenever something moves"
            body="A spoofing campaign or a volume spike fires an alert to email or Slack, and scheduled digests go out on their own. Failure to deliver is surfaced, so a quiet channel is never mistaken for a working one."
          />
        </div>
      </section>

      {/* How it works. */}
      <section className="mx-auto mt-16 w-full max-w-[1180px] px-6">
        <h2 className="text-[23px] font-semibold tracking-[-0.028em]" style={{ fontFamily: "var(--font-display)" }}>
          How it works
        </h2>
        <ol className="mt-6 grid grid-cols-1 gap-x-10 gap-y-6 sm:grid-cols-3">
          <Step
            n={1}
            title="Add a client and its domains"
            body="Clients group the domains you monitor for one company. Adding a domain gives you an ownership TXT record and the DMARC record to publish."
          />
          <Step
            n={2}
            title="Publish the records"
            body="The record values come from us verbatim: nothing is assembled in the browser. Re-check as often as you like while DNS propagates; waiting is a normal state here, not an error."
          />
          <Step
            n={3}
            title="Reports arrive"
            body="Usually within 24 to 48 hours of publishing, the portfolio fills in with measured posture, volumes and sources: and the evidence artefacts become available."
          />
        </ol>
      </section>

      {/* Closing call to action. */}
      <section className="mx-auto mt-16 w-full max-w-[1180px] px-6">
        <div
          className="rounded-[2px] border px-8 py-9"
          style={{ borderColor: "var(--color-line-strong)", background: "var(--color-surface)" }}
        >
          <h2 className="max-w-[36ch] text-[23px] font-semibold tracking-[-0.028em]" style={{ fontFamily: "var(--font-display)" }}>
            One account, one workspace. Start with the domains you already look after.
          </h2>
          <p className="mt-3 max-w-[62ch] text-[14px] leading-[1.75]" style={{ color: "var(--color-ink-2)" }}>
            The free plan needs no card. Data export and erasure are available on
            every plan: they are rights, not upsells.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-4">
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
      </section>

      <MarketingFooter brand={brand} />
    </div>
  );
}

/** The shape of a real scan result, with a redacted domain: the pattern the
 *  free check produces, shown before anyone types. RFC 2606 reserved domains
 *  only: an example must never be a real company. */
function ScanExample() {
  const rows: Array<[string, boolean | null, string]> = [
    ["DMARC", true, "p=quarantine. Mail that fails alignment is filtered to spam or held."],
    ["SPF", true, "Published and valid."],
    ["DKIM", false, "No selector found."],
  ];
  return (
    <div
      className="rounded-[2px] border px-5 py-4"
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
      <div className="mt-3">
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
