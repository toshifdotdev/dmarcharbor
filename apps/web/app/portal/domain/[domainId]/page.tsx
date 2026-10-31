import type { Metadata } from "next";
import { getSessionUser } from "@/lib/api";
import { getPortalBranding, getPortalDomain, getPortalDomainProposals, PortalError } from "@/lib/api-portal";
import { dayLabel, policyKind, policyPlain, senderName, senderPlain, summaryText, verdictFor } from "@/lib/portal-verdict";
import { portalHref } from "@/lib/route-hrefs";
import { signInRedirect } from "@/lib/session";
import type { PortalBranding, PortalDomainDetail, PortalPolicyProposal } from "@/lib/types";
import { ForwardReport } from "@/components/harbor/portal-client";
import { PortalProposal } from "@/components/harbor/portal-proposal";
import { PortalFrame, PortalNotice, PortalPaused } from "@/components/harbor/portal-frame";
import { VerdictWord } from "@/components/harbor/portal-verdict-word";
import {
  LineKey,
  MailRoute,
  PolicyStrip,
  policyStage,
  recordStage,
  routeModel,
  StateMark,
  type Flow,
  type PolicyOutcome,
} from "@/components/harbor/document-route";
import { Badge } from "@/components/ui/badge";
import { CopyValue } from "@/components/ui/copy";
import { Readout, ReadoutStrip } from "@/components/ui/readout";

export const metadata: Metadata = { title: "Domain report", robots: { index: false, follow: false } };

const H2 = "text-[22px] font-[740] leading-[1.15] tracking-[-0.02em] text-fg sm:text-[26px]";

/**
 * /portal/domain/[domainId] — one domain, for the agency's client.
 *
 * Top to bottom: the verdict and what to do (with the ways to forward it),
 * any approval the agency is waiting on, then the evidence a person can
 * forward ("What was observed": the figures, and a drawing of how the mail was
 * handled, a line per sender, the failed mail on the dashed red line ending
 * where the domain's setting sends it), then who is sending as them in plain
 * names, each marked with its line, then the domain's setting on the strip
 * from monitoring to blocking, with the exact record tucked away for their IT
 * contact.
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
  const [detailResult, brand, user, proposals] = await Promise.all([
    getPortalDomain(domainId, org).then(
      (d) => ({ ok: true as const, d }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
    getPortalBranding(org).catch(() => null as PortalBranding | null),
    getSessionUser().catch(() => null),
    // A failed read shows no request rather than blocking the report; the
    // request is also in the email that announced it.
    getPortalDomainProposals(domainId, org).then(
      (result) => result.proposals,
      () => [] as PortalPolicyProposal[],
    ),
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

  // The open request, else the latest answered one, so a contact who
  // approved can see that it was recorded.
  const pending = proposals.find((p) => p.state === "pending");
  const shown = pending ?? proposals[0];

  // One line per sender: what passed rides its own line, what failed rides
  // the dashed red one.
  const flows: Flow[] = detail.senders.map((s) => {
    const who = senderName(s);
    return {
      key: s.senderKey,
      name: who.name,
      mono: isIdentifier(s, who.known),
      passed: Math.max(0, s.totalMessages - s.dmarcFailedMessages),
      failed: s.dmarcFailedMessages,
    };
  });
  const route = routeModel(flows, ["sender", "senders"]);
  const kind = policyKind(detail.domain.dmarcPolicy);
  const outcome: PolicyOutcome = kind ?? "unknown";

  return (
    <PortalFrame brand={brand} email={email} home={portalHref(org)} back={{ href: portalHref(org), label: "All your domains" }}>
      <div className="flex flex-col gap-14 sm:gap-16">
        <header className="flex flex-col">
          <p className="text-[15px] leading-[1.4] text-fg-4">
            <span className="font-bold text-fg">{detail.domain.client.name}</span> domain report
          </p>
          <h1 className="mt-4 text-[38px] font-[760] leading-[1] tracking-[-0.035em] text-fg [overflow-wrap:anywhere] sm:text-[52px] min-[1100px]:text-[60px] print:text-[24pt]">
            {detail.domain.name}
          </h1>
          <div data-verdict={verdict.kind} className="mt-8 flex max-w-[44rem] flex-col gap-3">
            <p>
              <VerdictWord verdict={verdict} size="lg" />
            </p>
            <p className="text-[18px] leading-[1.5] text-fg sm:text-[19px]">{verdict.meaning}</p>
            <p className="text-[16px] leading-[1.55] text-fg-2">
              <span className="font-semibold text-fg">What to do: </span>
              {verdict.next}
            </p>
          </div>
          <div className="mt-8 flex flex-col gap-3 border-t border-rule pt-5 print:hidden">
            <p className="text-[14px] text-fg-4">Send this to whoever handles your IT, or keep it for your records.</p>
            <ForwardReport subject={`Email protection report: ${detail.domain.name}`} text={summaryText(detail, verdict, agency)} />
          </div>
        </header>

        {shown ? <PortalProposal proposal={shown} org={org} current={policyStage(detail.domain.dmarcPolicy)} /> : null}

        {detail.possibleSpoofingSources.length > 0 ? (
          <section
            aria-labelledby="spoof-head"
            className="flex max-w-[56rem] flex-col gap-3 rounded-sheet border border-fail/30 bg-fail-wash px-5 py-5 sm:px-7 sm:py-6"
          >
            <h2 id="spoof-head" className="flex items-center gap-2.5 text-[19px] font-bold text-fail">
              <StateMark shape="diamond" tone="fail" size={12} />
              Possible impersonation
            </h2>
            <p className="max-w-[66ch] text-[15.5px] leading-[1.55] text-fg-2">
              These sources started sending email as {detail.domain.name} recently, and their messages failed every check. A
              genuine service you use normally passes at least one. If you do not recognise them, someone may be pretending to
              be you; if you do, {agency} needs to know their name to set them up correctly.
            </p>
            <ul className="mt-1 flex flex-col gap-2">
              {detail.possibleSpoofingSources.map((s) => (
                <li key={s.senderKey} className="text-[15px] leading-[1.5]">
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

        <section aria-labelledby="observed-head" className="flex flex-col gap-6 border-t border-rule pt-10">
          <div className="max-w-[44rem]">
            <h2 id="observed-head" className={H2}>
              What was observed
            </h2>
            {measured && agg ? (
              <p className="mt-2 text-[15.5px] leading-[1.55] text-fg-2">
                From {n(agg.reportCount)} report{agg.reportCount === 1 ? "" : "s"} sent by receiving mail servers
                {from && to ? `, covering ${from} to ${to}` : ""}. The last arrived {dayLabel(agg.lastReportAt) ?? "on a date that was not recorded"}.
              </p>
            ) : null}
          </div>
          {measured && agg ? (
            <>
              <ReadoutStrip>
                <Readout
                  label={`Message${agg.messageCount === 1 ? "" : "s"} sent as ${detail.domain.name}`}
                  value={n(agg.messageCount)}
                  note="Every message these servers received that claimed to come from your domain."
                />
                <Readout
                  label="Passed DMARC"
                  value={passPct === null ? "—" : `${passPct}%`}
                  note={agg.failedMessages === 0 ? "None failed DMARC." : `${n(agg.failedMessages)} failed DMARC. Those are the ones to look at.`}
                />
                <Readout
                  label={`Source${detail.senders.length === 1 ? "" : "s"} sending as you`}
                  value={n(detail.senders.length)}
                  note="Services and servers that sent email in your name. Listed below."
                />
              </ReadoutStrip>
              {route.rows.length > 0 ? (
                <MailRoute
                  rows={route.rows}
                  outcome={outcome}
                  name={detail.domain.name}
                  meta={from && to ? `${from} to ${to}` : undefined}
                  caption={
                    <>
                      Each row is a sender that sent email as {detail.domain.name}. Where a line ends is what your
                      domain&rsquo;s setting asks receiving mail servers to do with email that fails the check. Lines are not
                      drawn to scale; the counts are.
                    </>
                  }
                />
              ) : null}
            </>
          ) : (
            <p className="max-w-[64ch] border-y border-rule py-5 text-[15.5px] leading-[1.55] text-fg-2">
              No report has arrived for this domain yet, so nothing has been observed. Mail servers send reports about once a
              day; the first usually arrives within 2 days of the domain being set up.
            </p>
          )}
        </section>

        <section aria-labelledby="senders-head" className="flex flex-col gap-5 border-t border-rule pt-10">
          <h2 id="senders-head" className={H2}>
            Who is sending as you
          </h2>
          {senders.length === 0 ? (
            <p className="text-[15px] text-fg-3">No sending sources have been reported yet.</p>
          ) : (
            <>
              <p className="max-w-[66ch] text-[15.5px] leading-[1.55] text-fg-2">
                The services and servers that sent email as {detail.domain.name}, with failures first. Your own email provider,
                newsletter tool or invoicing system should be here and passing. Anything you do not recognise is worth
                mentioning to {agency}.
              </p>
              <ul className="flex max-w-[64rem] flex-col border-y border-rule">
                {senders.map((s) => {
                  const who = senderName(s);
                  const plain = senderPlain(s);
                  const mono = isIdentifier(s, who.known);
                  return (
                    <li
                      key={s.senderKey}
                      className="grid gap-x-8 gap-y-1.5 border-b border-rule py-4 last:border-b-0 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]"
                    >
                      <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                        <LineKey colour={route.colourOf.get(s.senderKey)} />
                        <span
                          className={
                            mono
                              ? "data min-w-0 text-[14.5px] font-semibold text-fg [overflow-wrap:anywhere]"
                              : "min-w-0 text-[15.5px] font-bold text-fg [overflow-wrap:anywhere]"
                          }
                        >
                          {who.name}
                        </span>
                        {spoofKeys.has(s.senderKey) ? <Badge tone="fail">Not recognised</Badge> : s.isNew ? <Badge tone="neutral">New</Badge> : null}
                      </p>
                      <p className="text-[15px] leading-[1.5] text-fg-2">
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
                        <span className="text-[13.5px] text-fg-4">Last seen {dayLabel(s.lastSeenAt) ?? "—"}.</span>
                      </p>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        <section
          aria-labelledby="setting-head"
          className="grid gap-x-16 gap-y-8 border-t border-rule pt-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
        >
          <div className="min-w-0">
            <h2 id="setting-head" className="text-[19px] font-[740] leading-[1.25] tracking-[-0.015em] text-fg">
              Your domain&rsquo;s setting: {policy.name}
            </h2>
            <PolicyStrip
              at={policyStage(detail.domain.dmarcPolicy)}
              to={pending ? recordStage(pending.recordValue) : null}
              scale
              className="mt-4 max-w-[22rem]"
            />
            <p className="mt-4 max-w-[52ch] text-[15.5px] leading-[1.55] text-fg-2">{policy.meaning}</p>
            {pending ? (
              <p className="mt-1.5 max-w-[52ch] text-[14px] text-fg-4">
                The dashed step is the change {agency} has asked you to approve.
              </p>
            ) : null}
            {detail.domain.lastScanAt ? (
              <p className="mt-1.5 text-[14px] text-fg-4">Read from your domain on {dayLabel(detail.domain.lastScanAt)}.</p>
            ) : null}
          </div>
          <div className="min-w-0">
            <h2 className="text-[19px] font-[740] leading-[1.25] tracking-[-0.015em] text-fg">What the checks are</h2>
            <p className="mt-4 max-w-[56ch] text-[15.5px] leading-[1.55] text-fg-2">
              A receiving mail server asks two questions of every message: was it sent from a server your domain allows, and
              does it carry your domain&rsquo;s digital signature? A message passes when it answers yes and the names match.
              Your IT contact may know these as SPF, DKIM and DMARC.
            </p>
          </div>
          {detail.domain.dmarcRecord ? (
            <details className="group md:col-span-2">
              <summary className="link cursor-pointer text-[15px] font-semibold">Technical detail for your IT contact</summary>
              <div className="mt-3 flex max-w-[56rem] flex-col gap-1.5">
                <p className="text-[13.5px] text-fg-4">
                  The DMARC record published at <span className="data">_dmarc.{detail.domain.name}</span>:
                </p>
                <CopyValue value={detail.domain.dmarcRecord} label="Copy the DMARC record" />
              </div>
            </details>
          ) : null}
        </section>
      </div>
    </PortalFrame>
  );
}

/** A sender named by its domain is an identifier, set in the data face; a recognised service is a name. */
function isIdentifier(s: PortalDomainDetail["senders"][number], known: boolean): boolean {
  const service = Boolean(s.service && (s.confidence === "confirmed" || s.confidence === "likely"));
  return known && !service;
}
