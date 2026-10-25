import type { Metadata } from "next";
import { getSessionUser } from "@/lib/api";
import { getPortalBranding, getPortalDomain, PortalError } from "@/lib/api-portal";
import { dayLabel, policyPlain, senderName, senderPlain, summaryText, verdictFor } from "@/lib/portal-verdict";
import { portalHref } from "@/lib/route-hrefs";
import { signInRedirect } from "@/lib/session";
import type { PortalBranding, PortalDomainDetail } from "@/lib/types";
import { ForwardReport } from "@/components/harbor/portal-client";
import { PortalFrame, PortalNotice, PortalPaused } from "@/components/harbor/portal-frame";
import { Badge } from "@/components/ui/badge";
import { CopyValue } from "@/components/ui/copy";

export const metadata: Metadata = { title: "Domain report", robots: { index: false, follow: false } };

/**
 * /portal/domain/[domainId] — one domain, for the agency's client.
 *
 * Top to bottom: the verdict and what to do, then the evidence a person can
 * forward ("What was observed", in sentences, each figure with what it
 * means), then who is sending as them in plain names, then the domain's
 * setting, with the exact record tucked away for their IT contact.
 *
 * The portal API never returns forensic data, and this page asks for none.
 * The address carries the domain's id (the overview does not return a slug);
 * the API accepts either.
 */
export default async function PortalDomainPage({
  params,
  searchParams,
}: {
  params: Promise<{ domainId: string }>;
  searchParams: Promise<{ org?: string }>;
}) {
  const { domainId } = await params;
  // The provider, for a contact invited by more than one.
  const { org } = await searchParams;
  const [detailResult, brand, user] = await Promise.all([
    getPortalDomain(domainId, org).then(
      (d) => ({ ok: true as const, d }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
    getPortalBranding(org).catch(() => null as PortalBranding | null),
    getSessionUser().catch(() => null),
  ]);
  const email = user?.email ?? null;

  if (!detailResult.ok) {
    const e = detailResult.e;
    if (e instanceof PortalError && e.status === 401) await signInRedirect();
    if (e instanceof PortalError && e.code === "PORTAL_PAUSED") {
      return <PortalPaused email={email} provider={e.workspaceName} />;
    }
    if (e instanceof PortalError) {
      return (
        <PortalNotice
          brand={brand}
          email={email}
          title={e.status === 404 || e.status === 403 ? "This domain is not in your report" : "This report is unavailable just now"}
        >
          <p>
            {e.status === 404 || e.status === 403
              ? "It may belong to another account, or it may have been removed. Your other domains are on the overview."
              : "This is a problem reaching the report, not a problem with your email. Please try again in a few minutes."}
          </p>
        </PortalNotice>
      );
    }
    throw e;
  }

  const detail: PortalDomainDetail = detailResult.d;
  const agency = brand?.workspaceName ?? "Your provider";
  const verdict = verdictFor(detail, agency, Date.now());
  const agg = detail.aggregate;
  const measured = Boolean(agg && agg.messageCount > 0);
  const passed = agg ? agg.messageCount - agg.failedMessages : 0;
  const passPct = agg && agg.messageCount > 0 ? Math.round((passed / agg.messageCount) * 1000) / 10 : null;
  const from = dayLabel(agg?.messageWindow.begin);
  const to = dayLabel(agg?.messageWindow.end);
  const policy = policyPlain(detail.domain.dmarcPolicy);
  const n = (v: number) => v.toLocaleString("en-GB");

  const senders = [...detail.senders].sort(
    (a, b) => b.dmarcFailedMessages - a.dmarcFailedMessages || b.totalMessages - a.totalMessages,
  );
  const spoofKeys = new Set(detail.possibleSpoofingSources.map((s) => s.senderKey));

  return (
    <PortalFrame brand={brand} email={email} home={portalHref(org)} back={{ href: portalHref(org), label: "All your domains" }}>
      <div className="flex flex-col gap-10">
        <header className="flex flex-col gap-3">
          <p className="legend">{detail.domain.client.name}</p>
          <h1 className="data break-all text-[26px] font-semibold tracking-[-0.03em] text-fg sm:text-[32px]">{detail.domain.name}</h1>
          <div data-verdict={verdict.kind} className="flex flex-col gap-2 border-l-[3px] pl-4" style={{ borderColor: `var(--color-${verdict.tone === "fail" ? "fail" : verdict.tone === "warn" ? "warn-mark" : verdict.tone === "ok" ? "ok" : "rule-2"})` }}>
            <p>
              <Badge tone={verdict.tone} boxed>
                {verdict.title}
              </Badge>
            </p>
            <p className="max-w-[70ch] text-lead text-fg">{verdict.meaning}</p>
            <p className="max-w-[70ch] text-body text-fg-2">
              <span className="font-semibold text-fg">What to do: </span>
              {verdict.next}
            </p>
          </div>
          <div className="mt-2 flex flex-col gap-1.5">
            <p className="text-meta text-fg-3">Send this to whoever handles your IT, or keep it for your records.</p>
            <ForwardReport subject={`Email protection report: ${detail.domain.name}`} text={summaryText(detail, verdict, agency)} />
          </div>
        </header>

        {detail.possibleSpoofingSources.length > 0 ? (
          <section aria-labelledby="spoof-head" className="flex flex-col gap-2 rounded-ctl border border-fail/35 bg-fail-wash/60 px-4 py-4">
            <h2 id="spoof-head" className="text-h3 font-bold text-fail">
              Possible impersonation
            </h2>
            <p className="max-w-[72ch] text-ui text-fg-2">
              These sources started sending email as {detail.domain.name} recently, and their messages failed every check. A
              genuine service you use normally passes at least one. If you do not recognise them, someone may be pretending to
              be you; if you do, {agency} needs to know their name to set them up correctly.
            </p>
            <ul className="mt-1 flex flex-col gap-1.5">
              {detail.possibleSpoofingSources.map((s) => (
                <li key={s.senderKey} className="text-ui">
                  <span className="font-semibold text-fg">{senderName(s).name}</span>
                  <span className="text-fg-2">
                    {" "}
                    sent {n(s.totalMessages)} message{s.totalMessages === 1 ? "" : "s"}, {n(s.failedMessages)} of them failed DMARC.
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="observed-head" className="flex flex-col gap-4">
          <h2 id="observed-head" className="text-h2 font-bold tracking-[-0.02em] text-fg">
            What was observed
          </h2>
          {measured && agg ? (
            <>
              <p className="max-w-[72ch] text-ui text-fg-2">
                From {n(agg.reportCount)} report{agg.reportCount === 1 ? "" : "s"} sent by receiving mail servers
                {from && to ? `, covering ${from} to ${to}` : ""}. The last arrived {dayLabel(agg.lastReportAt) ?? "on a date that was not recorded"}.
              </p>
              <dl className="grid gap-px overflow-hidden rounded-ctl border border-rule bg-rule sm:grid-cols-3">
                {[
                  [n(agg.messageCount), `message${agg.messageCount === 1 ? "" : "s"} sent as ${detail.domain.name}`, "Every message these servers received that claimed to come from your domain."],
                  [
                    passPct === null ? "—" : `${passPct}%`,
                    "proved they came from you",
                    agg.failedMessages === 0 ? "None failed." : `${n(agg.failedMessages)} did not. Those are the ones to look at.`,
                  ],
                  [n(detail.senders.length), `source${detail.senders.length === 1 ? "" : "s"} sending as you`, "Services and servers that sent email in your name. Listed below."],
                ].map(([figure, label, meaning]) => (
                  <div key={label} className="bg-paper-2 px-4 py-4">
                    <dt className="text-meta font-semibold text-fg-2">{label}</dt>
                    <dd className="mt-1">
                      <span className="tnum display block text-[30px] leading-none text-fg">{figure}</span>
                      <span className="mt-2 block text-meta text-fg-3">{meaning}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          ) : (
            <p className="max-w-[72ch] border-y border-rule py-4 text-ui text-fg-2">
              No report has arrived for this domain yet, so nothing has been observed. Mail servers send reports about once a
              day; the first usually arrives within 2 days of the domain being set up.
            </p>
          )}
        </section>

        <section aria-labelledby="senders-head" className="flex flex-col gap-3">
          <h2 id="senders-head" className="text-h2 font-bold tracking-[-0.02em] text-fg">
            Who is sending as you
          </h2>
          {senders.length === 0 ? (
            <p className="text-ui text-fg-3">No sending sources have been reported yet.</p>
          ) : (
            <>
              <p className="max-w-[72ch] text-ui text-fg-2">
                The services and servers that sent email as {detail.domain.name}, with failures first. Your own email provider,
                newsletter tool or invoicing system should be here and passing. Anything you do not recognise is worth
                mentioning to {agency}.
              </p>
              <ul className="hb-stagger flex flex-col border-y border-rule">
                {senders.map((s, i) => {
                  const who = senderName(s);
                  const plain = senderPlain(s);
                  return (
                    <li
                      key={s.senderKey}
                      style={{ "--i": Math.min(i, 10) } as React.CSSProperties}
                      className="grid gap-x-6 gap-y-1 border-b border-rule py-3 last:border-b-0 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]"
                    >
                      <p className="flex flex-wrap items-baseline gap-2">
                        <span className={who.known ? "data text-ui font-semibold text-fg" : "text-ui font-semibold text-fg"}>{who.name}</span>
                        {spoofKeys.has(s.senderKey) ? <Badge tone="fail">Not recognised</Badge> : s.isNew ? <Badge tone="neutral">New</Badge> : null}
                      </p>
                      <p className="text-ui text-fg-2">
                        <span
                          className={
                            plain.tone === "fail"
                              ? "font-semibold text-fail"
                              : plain.tone === "warn"
                                ? "font-semibold text-warn"
                                : plain.tone === "ok"
                                  ? "font-semibold text-ok"
                                  : "text-fg-3"
                          }
                        >
                          {plain.line}
                        </span>{" "}
                        <span className="text-meta text-fg-3">Last seen {dayLabel(s.lastSeenAt) ?? "—"}.</span>
                      </p>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        <section aria-labelledby="setting-head" className="grid gap-x-10 gap-y-4 border-t border-rule pt-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <h2 id="setting-head" className="text-h3 font-bold tracking-[-0.01em] text-fg">
              Your domain&rsquo;s setting: {policy.name}
            </h2>
            <p className="mt-1.5 text-ui text-fg-2">{policy.meaning}</p>
            {detail.domain.lastScanAt ? (
              <p className="mt-1 text-meta text-fg-3">Read from your domain on {dayLabel(detail.domain.lastScanAt)}.</p>
            ) : null}
          </div>
          <div>
            <p className="text-h3 font-bold tracking-[-0.01em] text-fg">What the checks are</p>
            <p className="mt-1.5 text-ui text-fg-2">
              A receiving mail server asks two questions of every message: was it sent from a server your domain allows, and
              does it carry your domain&rsquo;s digital signature? A message passes when it answers yes and the names match.
              Your IT contact may know these as SPF, DKIM and DMARC.
            </p>
          </div>
          {detail.domain.dmarcRecord ? (
            <details className="md:col-span-2">
              <summary className="link cursor-pointer text-ui font-semibold">Technical detail for your IT contact</summary>
              <div className="mt-3 flex flex-col gap-1.5">
                <p className="text-meta text-fg-3">The DMARC record published at _dmarc.{detail.domain.name}:</p>
                <CopyValue value={detail.domain.dmarcRecord} label="Copy the DMARC record" />
              </div>
            </details>
          ) : null}
        </section>
      </div>
    </PortalFrame>
  );
}
