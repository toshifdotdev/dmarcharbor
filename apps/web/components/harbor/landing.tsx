/**
 * landing.tsx — the stranger's front page.
 *
 * Composition, not a template:
 * - The headline is set large in the display voice (Archivo at normal width,
 *   heavy, tight), across the whole measure. No split hero, no card beside it.
 * - The product's one idea that could belong to nothing else is the hero's
 *   second half: a real DMARC record, read tag by tag, with what each tag
 *   makes a receiving server do, and what its absence means. Type a domain and
 *   it becomes that domain's record (components/harbor/record-reading.tsx).
 * - Everything below is laid out as a ledger: a narrow index column carrying
 *   the section number and name, the content beside it. Rules, not boxes.
 *
 * Truth: no customer counts, logos, badges, testimonials or invented figures.
 * Every capability named is one the product has; the sentences are the ones
 * the earlier page carried. Plan names and prices live only on /pricing, which
 * renders them from the API.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { getServiceMeta } from "@/lib/api-public";
import { readHostBrand } from "@/lib/host-brand";
import { POSTURE_META, type Posture } from "@/lib/posture";
import { PostureMark } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { ArrowRight } from "@/components/ui/icons";
import { ApproachDiagram } from "./approach-diagram";
import { brandName, PublicFooter, PublicHeader } from "./public-frame";
import { RecordReading } from "./record-reading";

const POSTURES: Posture[] = ["pass", "block", "unverified", "stale", "unmeasured"];

export async function Landing() {
  const [brand, meta] = await Promise.all([readHostBrand(), getServiceMeta().catch(() => null)]);
  const piiDays = meta?.retention.forensicPiiDays ?? null;
  const name = brandName(brand);

  return (
    <div data-harbor data-host-brand={brand.state}>
      <PublicHeader brand={brand} />

      <main id="main">
        {/* ── Hero: the nameboard, then the record ─────────────────────── */}
        <section data-testid="home-hero" className="border-b border-rule">
          <div className="mx-auto w-full max-w-[1240px] px-5 pb-14 pt-12 sm:px-8 lg:pb-20 lg:pt-16">
            <p className="legend">DMARC monitoring for agencies and MSPs</p>
            <h1
              data-testid="home-headline"
              className="display mt-5 max-w-[15ch] text-[42px] leading-[0.98] text-fg sm:text-[64px] lg:text-[92px]"
            >
              See who sends mail as your clients.
            </h1>

            <div className="mt-10 grid gap-8 lg:mt-12 lg:grid-cols-12 lg:gap-10">
              <ul className="flex flex-col border-t border-rule-2 lg:col-span-4">
                {[
                  ["Reads", "the aggregate and forensic reports receivers send about each domain."],
                  ["Shows", "who passes, who fails, and who is impersonating, client by client."],
                  ["Never", "sends mail as your clients, or changes DNS you did not ask it to."],
                ].map(([k, v]) => (
                  <li key={k} className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 border-b border-rule py-2.5 text-ui">
                    <span className="font-bold text-fg">{k}</span>
                    <span className="text-fg-2">{v}</span>
                  </li>
                ))}
              </ul>
              <div className="lg:col-span-7 lg:col-start-6">
                <p className="max-w-[58ch] text-lead text-fg-2">
                  {name} turns the DMARC reports mail receivers send about your client domains into posture per domain,
                  the senders behind it, and evidence you can hand to a client. Every word it uses comes from measured
                  report data, and a domain that has never reported is never called healthy.
                </p>
                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <ButtonLink href="/sign-up" variant="primary" size="lg">
                    Start free
                    <ArrowRight size={14} />
                  </ButtonLink>
                  <ButtonLink href="/pricing" variant="secondary" size="lg" data-testid="home-pricing">
                    See pricing
                  </ButtonLink>
                </div>
              </div>
            </div>

            <div className="mt-14 lg:mt-16">
              <RecordReading />
            </div>
          </div>
        </section>

        <Ledger n="01" label="How DMARC decides" id="how">
          <h2 className="display max-w-[20ch] text-[28px] leading-[1.05] sm:text-d2">
            Every message that claims a domain is inspected at the entrance.
          </h2>
          <p className="mt-4 max-w-[64ch] text-lead text-fg-2">
            A receiving mail server checks whether SPF or DKIM passes for the domain in the From address. If neither
            does, the policy the domain publishes decides what happens. Choose one and watch the forged message.
          </p>
          <div className="mt-10">
            <ApproachDiagram />
          </div>
        </Ledger>

        <Ledger n="02" label="What you get">
          <h2 className="display max-w-[22ch] text-[28px] leading-[1.05] sm:text-d2">
            The receivers keep the record. We read it.
          </h2>
          <p className="mt-4 max-w-[60ch] text-lead text-fg-2">
            Point a domain&rsquo;s report address at {name} and every report it receives becomes something you can
            act on, compare, or hand over.
          </p>
          <dl className="mt-10 grid border-t border-rule-2 md:grid-cols-2 md:gap-x-10">
            {[
              ["Portfolio", "Every client domain in one table, sorted by what needs attention, with the reason beside each posture."],
              ["Senders", "Who sends as each domain, by source address and authenticating domain, with the share of their mail that fails."],
              ["Evidence", "Revocable share links, compliance packs with a published SHA-256 fingerprint, and a public trust page any auditor can open."],
              ["Client portal", "Your clients see their own domains under your name and colours, on your own domain, on plans that carry it."],
              ["Alerts", "Spoofing and volume-spike rules to email, Slack or Microsoft Teams, warnings when DNS changes or a registration nears expiry, scheduled digests, and delivery failures surfaced rather than swallowed."],
              ["DNS records", "Publish records through your Cloudflare connection, or host DMARC, SPF, BIMI and MTA-STS so a policy change needs no DNS edit. Every change can be put back."],
              ["Client approval", "Ask a client to approve a stricter policy in their portal. The decision is recorded under their name before anything changes."],
              ["Integrations", "Tickets in HaloPSA, ConnectWise or Autotask, signed webhooks, and an API for your own tooling."],
              ["Prospects", "A plain-language email security report for a company you want to win, sent under your name."],
              [
                "Forensic data",
                // The deployment's own window (FORENSIC_PII_RETENTION_DAYS via
                // /api/meta), not a number written into the page.
                `Recipient addresses in forensic reports are hashed by default. Named recipients are deleted ${
                  piiDays ? `after ${piiDays} day${piiDays === 1 ? "" : "s"}` : "after a short retention window"
                } on every plan.`,
              ],
              ["Your data", "Export and erasure are on every plan, free included. They are rights, not features."],
              ["Jump", "Type a client's name or a domain from anywhere and you are on its evidence: built for the call that starts with one domain."],
            ].map(([k, v]) => (
              <div key={k} className="grid gap-1 border-b border-rule py-3.5 sm:grid-cols-[132px_minmax(0,1fr)] sm:gap-5">
                <dt className="text-body font-bold text-fg">{k}</dt>
                <dd className="text-body text-fg-2">{v}</dd>
              </div>
            ))}
          </dl>
        </Ledger>

        <Ledger n="03" label="Five honest words">
          <h2 className="display max-w-[24ch] text-[28px] leading-[1.05] sm:text-d2">
            A domain that has never reported is not a passing domain.
          </h2>
          <p className="mt-4 max-w-[64ch] text-lead text-fg-2">
            Each domain reads as exactly one of these, chosen from measured report data. Silence has two words of its
            own, because reported-then-stopped and never-reported are different facts, and neither is a pass.
          </p>
          <ul className="mt-10 grid border-t border-rule-2 sm:grid-cols-2 lg:grid-cols-5">
            {POSTURES.map((p) => (
              <li
                key={p}
                className="border-b border-rule py-4 sm:pr-6 lg:border-b-0 lg:border-r lg:px-5 lg:first:pl-0 lg:last:border-r-0"
              >
                <p className="flex items-center gap-2 text-body font-bold text-fg">
                  <PostureMark posture={p} size={11} />
                  {POSTURE_META[p].label}
                </p>
                <p className="mt-2 text-ui text-fg-2">{POSTURE_META[p].meaning}</p>
              </li>
            ))}
          </ul>
        </Ledger>

        <Ledger n="04" label="Getting started">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div>
              <h2 id="start-head" className="display text-[28px] leading-[1.05]">
                Measurement first. Changes only when you ask.
              </h2>
              <p className="mt-4 max-w-[52ch] text-body text-fg-2">
                We never send mail as your clients. DNS changes only through a Cloudflare connection you add or a record
                you delegate to us, and only when you or your client approve it. One account holds as many workspaces as
                your plan allows; each workspace holds your clients and their client domains.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-4">
                <ButtonLink href="/sign-up" variant="primary" size="lg">
                  Create an account
                </ButtonLink>
                <Link href="/pricing" className="link text-body">
                  See pricing
                </Link>
              </div>
            </div>
            <ol className="grid gap-6 sm:grid-cols-3">
              {[
                ["Add a client and its domains", "Clients group the domains you report on together."],
                ["Publish the records", "Values are given verbatim; re-check while DNS propagates. Waiting is normal."],
                ["Reports arrive", "Usually within 24 to 48 hours. The portfolio fills in; evidence follows."],
              ].map(([t, b], i) => (
                <li key={t} className="border-t border-rule-2 pt-3">
                  <span className="tnum legend">{String(i + 1).padStart(2, "0")}</span>
                  <p className="mt-1 text-body font-bold text-fg">{t}</p>
                  <p className="mt-1 text-ui text-fg-2">{b}</p>
                </li>
              ))}
            </ol>
          </div>
        </Ledger>
      </main>

      <PublicFooter brand={brand} />
    </div>
  );
}

/**
 * A ledger row: the section's number and name in a narrow index column that
 * stays put while the content scrolls past it, the content beside it.
 */
function Ledger({ n, label, id, children }: { n: string; label: string; id?: string; children: ReactNode }) {
  return (
    <section id={id} aria-label={label} className="scroll-mt-6 border-b border-rule">
      <div className="mx-auto grid w-full max-w-[1240px] gap-6 px-5 py-16 sm:px-8 lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-10 lg:py-20">
        <div className="lg:sticky lg:top-8 lg:self-start">
          <p className="tnum data text-meta font-semibold text-fg-3">{n}</p>
          <p className="legend mt-1 text-fg!">{label}</p>
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}
