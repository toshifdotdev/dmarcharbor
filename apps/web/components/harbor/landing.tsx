/**
 * landing.tsx — the stranger's front page, in the Routes language
 * (.kiro/steering/design-system.md).
 *
 * The hero is one client domain's mail drawn as a transit map. Every section
 * after it extends that picture and carries one idea:
 *
 *   board    every client domain on one board, the urgent ones first
 *   how      each domain earns p=reject on its own evidence (id="how")
 *   check    read any domain's record now (record-reading.tsx)
 *   alerts   what goes wrong reaches the tools the team already uses
 *   portal   clients see the agency's name, and approve changes there
 *   close    start with one client domain
 *
 * Truth: sample data is on .example domains and captioned as sample. Every
 * agency and client name in it is invented and was checked against real
 * businesses before use; real products appear only as the senders they are
 * (Microsoft 365, HubSpot and so on). No customer counts, logos, badges,
 * testimonials or invented figures. Prices
 * live on /pricing, which renders them from the API. Visible text never names
 * the product directly: on an agency's verified domain it carries their name.
 */

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { readHostBrand } from "@/lib/host-brand";
import { AlertsMap } from "./landing-alerts-map";
import { Reveal } from "./landing-motion";
import { AGENCY, AGENCY_PORTAL, CLIENT, PortalMap } from "./landing-portal-map";
import { RouteMap } from "./landing-route-map";
import { brandName, PublicFooter, PublicHeader } from "./public-frame";
import { RecordReading } from "./record-reading";
import s from "./landing.module.css";

export async function Landing() {
  const brand = await readHostBrand();
  const name = brandName(brand);

  // The header and footer are the shared public frame (public-frame.tsx), so
  // this page and every page it links to wear the same one. Primary buttons
  // are ink, or the agency's colour on its verified domain (--hb-primary).
  return (
    <div data-harbor data-host-brand={brand.state} className={s.root}>
      <PublicHeader brand={brand} />

      <main id="main">
        <Hero />
        <Board />
        <How name={name} />
        <Check />
        <Alerts />
        <Portal />
        <Close />
      </main>

      <PublicFooter brand={brand} />
    </div>
  );
}

/* ── Hero: one domain's mail as a transit map ──────────────────────────── */

function Hero() {
  return (
    <section data-testid="home-hero" className={s.hero} aria-labelledby="home-headline">
      <div className={s.copy}>
        <h1 id="home-headline" data-testid="home-headline" className={s.headline}>
          Every sender, mapped.
        </h1>
        <p className={s.line}>
          DMARC for MSPs and agencies. Reports show every service that sends as a client&rsquo;s domain. Name the real
          ones, and the rest is turned away at p=reject.
        </p>
        <div className={s.ctaRow}>
          <Link href="/sign-up" className={s.cta}>
            Start free
          </Link>
          <span className={s.ctaNote}>Free to start, no card.</span>
        </div>
      </div>

      <figure className={s.figure}>
        <div className={s.figHead}>
          <span className={s.figDomain}>pellowyn-dental.example</span>
          <span className={s.figMeta}>Mail routes, last 30 days</span>
        </div>
        <RouteMap />
        <figcaption className={s.caption}>
          Sample routes on an example domain. Each line is a service sending as the domain.
        </figcaption>
      </figure>
    </section>
  );
}

/* ── Section frame ─────────────────────────────────────────────────────── */

/**
 * One section: a hairline, then its content. `split` sets copy and figure side
 * by side from 1100px; `flip` does the same with the figure on the left. The
 * heading inside must carry the id `${id}-head`.
 */
function Section({ id, layout, children }: { id: string; layout?: "split" | "flip"; children: ReactNode }) {
  return (
    <section id={id} className={s.section} aria-labelledby={`${id}-head`}>
      <div className={layout ? `${s.inner} ${s.split}` : s.inner} data-flip={layout === "flip" ? "" : undefined}>
        {children}
      </div>
    </section>
  );
}

/* ── The board: every client domain, the urgent ones first ─────────────── */

/** Where a domain stands: 0 p=none, 1 p=quarantine, 2 p=reject; null when nothing is measured. */
type Stage = 0 | 1 | 2 | null;

const STAGE_WORDS = ["At p=none", "At p=quarantine", "At p=reject"] as const;

const BOARD: { domain: string; client: string; at: Stage; ready?: boolean; state: string; tone: "fail" | "void" | "plain" | "ok" }[] = [
  { domain: "pellowyn-dental.example", client: "Pellowyn Dental", at: 2, state: "Unknown sender refused, 1,204 messages", tone: "fail" },
  { domain: "corriwick-cafe.example", client: "Corriwick Café", at: null, state: "No reports yet. Not counted as passing.", tone: "void" },
  { domain: "haskerley-law.example", client: CLIENT, at: 1, ready: true, state: "Ready for p=reject. Waiting on the client.", tone: "plain" },
  { domain: "ollerbeck-vets.example", client: "Ollerbeck Vets", at: 0, ready: true, state: "Ready for p=quarantine", tone: "plain" },
  { domain: "thrandle-build.example", client: "Thrandle Build", at: 2, state: "At p=reject, 99.7% passing", tone: "ok" },
];

/** A strip map of the three policies: travelled in ink, ready-but-not-taken dashed, unmeasured dotted. */
function Strip({ at, ready }: { at: Stage; ready?: boolean }) {
  return (
    <div className={s.strip} data-void={at === null ? "" : undefined} style={{ "--at": at === null ? 0 : at / 2 } as CSSProperties} aria-hidden>
      {at ? <span className={s.stripTravel} /> : null}
      {ready && at !== null && at < 2 ? <span className={s.stripPlan} /> : null}
      {[0, 1, 2].map((p) => (
        <span
          key={p}
          className={s.stripStop}
          style={{ "--p": p / 2 } as CSSProperties}
          data-reached={at !== null && p <= at ? "" : undefined}
          data-here={at === p ? "" : undefined}
        />
      ))}
    </div>
  );
}

function StripScale() {
  return (
    <div className={s.scaleTrack} aria-hidden>
      {(["p=none", "p=quarantine", "p=reject"] as const).map((label) => (
        <span key={label}>{label}</span>
      ))}
    </div>
  );
}

function Board() {
  return (
    <Section id="board">
      <h2 id="board-head" className={s.h2}>
        Every client on one board.
      </h2>
      <p className={s.lead}>
        All your client domains in one place, each on its way to p=reject, with the ones that need you at the top.
      </p>

      <figure className={s.boardFig}>
        <div className={s.boardHead}>
          <span className={s.boardTitle}>{AGENCY}</span>
          <span className={s.boardMeta}>5 clients</span>
          <span className={s.boardSort}>Most urgent first</span>
        </div>
        <Reveal className={s.board}>
          <div className={s.scale}>
            <StripScale />
          </div>
          <ol className={s.rows}>
            {BOARD.map((row, i) => (
              <li key={row.domain} className={s.row} style={{ "--i": i } as CSSProperties}>
                <p className={s.who}>
                  <span className={s.dom}>{row.domain}</span>
                  <span className={s.client}>{row.client}</span>
                </p>
                <Strip at={row.at} ready={row.ready} />
                <p className={s.state} data-tone={row.tone}>
                  <span className="sr-only">{row.at === null ? "Policy not measured" : STAGE_WORDS[row.at]}. </span>
                  {row.state}
                </p>
              </li>
            ))}
          </ol>
        </Reveal>
        <figcaption className={s.caption}>
          Sample board. {AGENCY} and its clients are invented names, on example domains.
        </figcaption>
      </figure>
    </Section>
  );
}

/* ── How: each domain earns p=reject ───────────────────────────────────── */

function How({ name }: { name: string }) {
  return (
    <Section id="how" layout="split">
      <div>
        <h2 id="how-head" className={s.h2}>
          Every domain earns p=reject.
        </h2>
        <p className={s.lead}>
          {name} tells you when each domain is ready for the next policy, from that domain&rsquo;s own reports. Nothing
          changes until you or the client approve it.
        </p>
      </div>

      <Reveal className={s.journeyWrap}>
        <ol className={s.journey}>
          <JourneyStop i={0} title="Reports arrive">
            Add one address to the client&rsquo;s DMARC record. Mail receivers start sending reports within a day or
            two.
          </JourneyStop>
          <JourneyStop i={1} title="Senders named">
            Mark each service as the client&rsquo;s or not. Mail from a sender nobody has named is never counted as
            safe.
          </JourneyStop>
          <JourneyStop
            i={2}
            title="p=quarantine"
            gate={
              <>
                After <b>30 days</b> of reports, <b>1,000</b> messages and <b>95%</b> passing.
              </>
            }
          >
            Mail that fails goes to spam.
          </JourneyStop>
          <JourneyStop
            i={3}
            title="p=reject"
            gate={
              <>
                After <b>30 days</b> at quarantine, <b>99%</b> passing and <b>99%</b> signed with DKIM.
              </>
            }
          >
            Mail that fails is refused.
          </JourneyStop>
        </ol>
      </Reveal>
    </Section>
  );
}

function JourneyStop({ i, title, gate, children }: { i: number; title: string; gate?: ReactNode; children: ReactNode }) {
  return (
    <li className={s.jStop} style={{ "--i": i } as CSSProperties}>
      <span className={s.jRail} aria-hidden>
        <span className={s.jCap} />
      </span>
      <div>
        <h3 className={s.jTitle}>{title}</h3>
        <p className={s.jBody}>{children}</p>
        {gate ? <p className={s.jGate}>{gate}</p> : null}
      </div>
    </li>
  );
}

/* ── Check: read any domain's record now ───────────────────────────────── */

function Check() {
  return (
    <Section id="check">
      <h2 id="check-head" className={s.h2}>
        Read a client&rsquo;s record now.
      </h2>
      <p className={s.lead}>
        Any domain, a client&rsquo;s or one you want to win. The DMARC record is read from public DNS and explained tag
        by tag. No account needed.
      </p>
      <RecordReading />
    </Section>
  );
}

/* ── Alerts: what goes wrong reaches the team's own tools ──────────────── */

function Alerts() {
  return (
    <Section id="alerts" layout="flip">
      <div>
        <h2 id="alerts-head" className={s.h2}>
          A forged sender becomes a ticket.
        </h2>
        <p className={s.lead}>
          A new sender failing SPF and DKIM, failures over your threshold, reports that stop arriving, a DNS record that
          changes: each alert goes to email, Slack or Teams, or opens a ticket in HaloPSA, ConnectWise or Autotask.
        </p>
      </div>
      <figure className={s.figure}>
        <AlertsMap />
      </figure>
    </Section>
  );
}

/* ── Portal: clients see the agency's name ─────────────────────────────── */

function Portal() {
  return (
    <Section id="portal" layout="split">
      <div>
        <h2 id="portal-head" className={s.h2}>
          Your clients see your name.
        </h2>
        <p className={s.lead}>
          From the Harbor plan, the portal, the monthly reports and every approval request carry your logo and colours.
          On Admiralty the portal opens on your own domain.
        </p>
        <p className={s.lead}>Clients approve a move to p=reject there, and the decision is recorded under their name.</p>
      </div>

      {/* The agency's own line, in the agency's colour, ending at its client. */}
      <figure className={s.figure}>
        <div className={s.figHead}>
          <span className={s.figDomain}>{AGENCY_PORTAL}</span>
          <span className={s.figMeta}>What {CLIENT} sees</span>
        </div>
        <PortalMap />
        <figcaption className={s.caption}>
          Sample. {AGENCY} and {CLIENT} are invented names, on example domains.
        </figcaption>
      </figure>
    </Section>
  );
}

/* ── Close: every line ends at one terminus ────────────────────────────── */

function Close() {
  return (
    <Section id="close">
      <h2 id="close-head" className={s.h2}>
        Start with one client domain.
      </h2>
      <p className={s.lead}>
        Gmail and Yahoo have required DMARC from anyone sending more than 5,000 messages a day since February 2024, and
        Outlook.com since May 5, 2025.
      </p>
      <div className={s.terminus}>
        <span className={s.bundle} aria-hidden />
        <Link href="/sign-up" className={s.cta}>
          Start free
        </Link>
      </div>
      <p className={s.closeLinks}>
        <span>Free to start, no card.</span>
        <Link href="/pricing" className={s.textLink} data-testid="home-pricing">
          See pricing
        </Link>
      </p>
    </Section>
  );
}

