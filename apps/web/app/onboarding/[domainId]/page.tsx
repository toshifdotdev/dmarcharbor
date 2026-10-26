import Link from "next/link";
import { notFound, redirect, unstable_rethrow } from "next/navigation";
import type { CSSProperties } from "react";
import { clsx } from "clsx";
import { ApiError, getOnboardingState, getSessionUserId, listClients } from "@/lib/api";
import { getDnsConnections, getHostedDmarc, listReportShares, listWorkspaceMembers, OpsError } from "@/lib/api-ops";
import { domainHref } from "@/lib/route-hrefs";
import { resolveActiveWorkspace } from "@/lib/session";
import { strongestRole } from "@/lib/settings-map";
import type { DomainRow, HostedDmarcView, OnboardingState, ReportShareRow } from "@/lib/types";
import { AppShell } from "@/components/harbor/app-shell";
import { DomainRecords } from "@/components/harbor/domain-records";
import { DomainRemoval } from "@/components/harbor/domain-removal";
import { PageHeader, SectionHead } from "@/components/harbor/page-header";
import { ShareLinks, type ShareView } from "@/components/harbor/share-links";
import { Badge, type Tone } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { ArrowRight } from "@/components/ui/icons";
import { ErrorState } from "@/components/ui/states";

/**
 * A domain's setup page: from "added" to "reports arriving", with nothing left
 * to guess.
 *
 * Every string about the domain's state is the API's own. The records are the
 * API's (the ownership record from the verify call, the DMARC record from
 * onboarding.suggestedRecord, never assembled here), and the step list is the
 * API's progress model, rendered as-is. The page adds only the order to read
 * it in: what to do now, at the top; how far along it is, beside it.
 *
 * HONESTY RULE: a domain publishing rua=https: is CONFIGURED but its reports
 * are not COLLECTED. The aggregate_reporting step carries that distinction in
 * its own detail, and the page links the fix (the report mailbox) rather than
 * claiming delivery.
 *
 * The URL carries a slug or an id. The API calls below use the id read from
 * the client list, because some API reads resolve a slug for the domain but not
 * for its child queries (a known backend defect, logged, not fixed here).
 */

/** The retired pct canary step. The API no longer sends it (RFC 9989 retired
 *  pct); kept hidden here in case an older API answers this page. */
const HIDDEN_STEPS = new Set(["canary_rollout"]);

const STATE_BADGE: Record<OnboardingState["state"], { label: string; tone: Tone }> = {
  ADDED: { label: "Added", tone: "neutral" },
  AWAITING_VERIFICATION: { label: "Awaiting ownership check", tone: "warn" },
  AWAITING_DMARC_RECORD: { label: "Awaiting DMARC record", tone: "warn" },
  AWAITING_REPORTS: { label: "Awaiting first reports", tone: "neutral" },
  MONITORING: { label: "Measuring", tone: "ok" },
  NEEDS_ATTENTION: { label: "Needs attention", tone: "fail" },
};

const STEP_WORD: Record<OnboardingState["steps"][number]["status"], string> = {
  done: "Done",
  pending: "To do",
  blocked: "Waiting",
  optional: "Optional",
};

function dateLabel(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "not recorded"
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default async function OnboardingPage({ params }: { params: Promise<{ domainId: string }> }) {
  const { domainId } = await params;
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  // Publishing is a domain:update action. The role comes from the roster, and
  // connections are read once rather than per record.
  const [members, userId, dnsConnections] = await Promise.all([
    listWorkspaceMembers(active.id).catch(() => null),
    getSessionUserId().catch(() => null),
    getDnsConnections(active.id).catch(() => null),
  ]);
  const role = strongestRole(members?.members.find((member) => (member.userId ?? member.user?.id) === userId)?.role ?? null);
  const canPublish = role === null || ["owner", "admin", "analyst"].includes(role);
  const publishConnections = dnsConnections?.connections ?? [];

  // Three facts kept apart: the client list failed (an API problem), the
  // domain is not in this workspace (a real 404), and the domain exists.
  let domain: DomainRow | null = null;
  let clientName = "";
  let clientsFailed = false;
  const clients = await listClients(active.id).catch(() => {
    clientsFailed = true;
    return [];
  });
  for (const c of clients) {
    const hit = c.domains.find((d) => d.id === domainId || d.slug === domainId);
    if (hit) {
      domain = hit;
      clientName = c.name;
      break;
    }
  }

  const shell = (children: React.ReactNode, trail = [{ label: "Clients", href: "/clients" }, { label: "Setup" }]) => (
    <AppShell workspaces={workspaces} activeWorkspace={active} trail={trail}>
      {children}
    </AppShell>
  );

  if (clientsFailed) {
    return shell(
      <div className="flex flex-col gap-6">
        <PageHeader title="Domain setup" />
        <ErrorState
          what="the client list"
          detail="This page could not confirm which domain this is. That is an API problem, not a missing domain: the domain is still yours."
        />
      </div>,
    );
  }
  if (!domain) notFound();

  // Never POST /verify here: a lookup changes the domain's status and can
  // notify people, so it runs only when the operator presses the check.
  let onboarding: OnboardingState | null = null;
  let stateFailed = false;
  try {
    onboarding = await getOnboardingState(active.id, domain.id);
  } catch (error) {
    unstable_rethrow(error);
    if ((error instanceof OpsError || error instanceof ApiError) && error.status === 404) notFound();
    stateFailed = true;
  }
  // A failed read leaves the delete dialog without the hosted list; it does
  // not block deletion.
  let hosted: HostedDmarcView | null;
  try {
    hosted = await getHostedDmarc(active.id, domain.id);
  } catch {
    hosted = null;
  }

  const trail = [
    { label: "Clients", href: "/clients" },
    { label: clientName, href: "/clients" },
    { label: domain.name, mono: true },
  ];

  if (stateFailed || !onboarding) {
    return shell(
      <div className="flex flex-col gap-6">
        <PageHeader title={domain.name} titleMono />
        <ErrorState what="this domain's setup" detail="The domain and its records are unchanged; the setup state did not load." />
      </div>,
      trail,
    );
  }

  // Shares are a side panel: a failed read hides the list, never the setup.
  const now = Date.now();
  const shareRows: ReportShareRow[] | null = await listReportShares(active.id)
    .then((r) => r.items)
    .catch(() => null);
  const shares: ShareView[] = (shareRows ?? [])
    .filter((s) => s.domain.id === domain.id)
    .map((s) => ({
      id: s.id,
      token: s.token,
      createdLabel: dateLabel(s.createdAt),
      expiresLabel: dateLabel(s.expiresAt),
      revokedLabel: s.revokedAt ? dateLabel(s.revokedAt) : null,
      expired: !s.revokedAt && new Date(s.expiresAt).getTime() < now,
      viewCount: s.viewCount,
      includeSources: s.includeSources,
      includeForensics: s.includeForensics,
    }));

  const steps = onboarding.steps.filter((s) => !HIDDEN_STEPS.has(s.id));
  const required = steps.filter((s) => s.status !== "optional");
  const doneCount = required.filter((s) => s.status === "done").length;
  const nextStep = steps.find((s) => s.status === "pending") ?? null;
  const badge = STATE_BADGE[onboarding.state];
  const measuring = onboarding.state === "MONITORING";
  const verified = domain.status === "VERIFIED" || onboarding.domain.status === "VERIFIED";

  const lede = (() => {
    switch (onboarding.state) {
      case "ADDED":
      case "AWAITING_VERIFICATION":
        return "Publish the records below wherever this domain's DNS is managed, then check DNS. Nothing here changes how mail is delivered.";
      case "AWAITING_DMARC_RECORD":
        return "Ownership is verified. Publish the DMARC record below to start receiving reports.";
      case "AWAITING_REPORTS":
        return "The records are in place. Receivers usually send their first reports within 24 to 48 hours; this page and the domain page update as they arrive.";
      case "MONITORING":
        return "Reports are arriving and the domain is being measured. Its posture, senders and history are on the domain page.";
      case "NEEDS_ATTENTION":
        return nextStep ? `Needs attention: ${nextStep.detail}` : "Something in the setup needs attention: see the steps.";
    }
  })();

  const pct = required.length > 0 ? (doneCount / required.length) * 100 : 0;

  return shell(
    <div className="flex flex-col gap-8">
      <PageHeader
        title={domain.name}
        titleMono
        status={
          <Badge tone={badge.tone} boxed>
            {badge.label}
          </Badge>
        }
        lede={lede}
        meta={
          <>
            <span>{clientName}</span>
            <span>
              Setup: <span className="tnum font-semibold text-fg-2">{doneCount}</span> of{" "}
              <span className="tnum">{required.length}</span> steps done
            </span>
          </>
        }
        actions={
          <ButtonLink href={domainHref(domain.slug)} variant={measuring ? "primary" : "secondary"}>
            Open the domain page
            <ArrowRight size={14} />
          </ButtonLink>
        }
      />

      <div aria-hidden className="h-[3px] w-full max-w-[520px] bg-rule">
        <div
          className="hb-rail-fill h-full bg-act"
          style={{ "--from": "0%", "--to": `${pct}%`, width: `${pct}%` } as CSSProperties}
        />
      </div>

      {/* Records first, then the steps, then sharing and deletion: on a phone
          the progress sits right after the work it measures, not under the
          delete button. On wide screens the steps are the right-hand column. */}
      <div className="grid gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[auto_1fr]">
        <div className="flex min-w-0 flex-col gap-10 lg:col-start-1 lg:row-start-1">
          <section aria-labelledby="records-head">
            <SectionHead
              id="records-head"
              title={measuring ? "Records" : "Records to publish"}
              aside="TXT records, at the DNS host for this domain"
            />
            <DomainRecords
              organizationId={active.id}
              domainId={domain.id}
              domainName={domain.name}
              slug={domain.slug}
              verified={verified}
              dmarc={onboarding.suggestedRecord ?? null}
              publishedPolicy={onboarding.reporting.publishedPolicy}
              canPublish={canPublish}
              connections={publishConnections}
            />
          </section>
        </div>

        <aside
          aria-labelledby="steps-head"
          className="flex flex-col gap-3 self-start lg:sticky lg:top-[104px] lg:col-start-2 lg:row-span-2 lg:row-start-1"
        >
          <SectionHead id="steps-head" title="Setup steps" aside="The platform's own reading" />
          <ol className="hb-stagger border-t border-rule">
            {steps.map((s, i) => {
              const isNext = s === nextStep;
              return (
                <li
                  key={s.id}
                  data-step={s.id}
                  data-step-status={s.status}
                  style={{ "--i": i } as CSSProperties}
                  className={clsx(
                    "grid grid-cols-[20px_minmax(0,1fr)] gap-x-2.5 border-b border-rule py-3",
                    isNext && "border-l-2 border-l-act bg-paper-2 pl-2.5 pr-2",
                  )}
                >
                  <StepMark status={s.status} />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className={clsx("text-ui font-semibold", s.status === "blocked" ? "text-fg-3" : "text-fg")}>
                        {s.title}
                      </span>
                      <span
                        className={clsx(
                          "text-meta font-semibold",
                          s.status === "done" ? "text-ok" : isNext ? "text-act" : "text-fg-3",
                        )}
                      >
                        {isNext ? "Next" : STEP_WORD[s.status]}
                      </span>
                    </p>
                    <p className="mt-0.5 text-meta leading-[1.5] text-fg-2">
                      {s.detail}
                      {s.id === "aggregate_reporting" && s.status !== "done" && s.detail.includes("web endpoint") ? (
                        <>
                          {" "}
                          <Link href="/settings/mailbox" className="link font-semibold" data-testid="rua-mailbox-link">
                            Set up the report mailbox
                          </Link>
                        </>
                      ) : null}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="text-meta text-fg-3">
            {measuring ? (
              <>
                Policy changes from here are guided on the{" "}
                <Link href={domainHref(domain.slug)} className="link">
                  domain page
                </Link>
                , from what the reports show.
              </>
            ) : (
              "Steps update as DNS and reports change. Reload, or check DNS, to read them again."
            )}
          </p>
        </aside>

        <div className="flex min-w-0 flex-col gap-10 lg:col-start-1 lg:row-start-2">
          {shareRows === null ? (
            <p className="border-y border-rule py-3 text-ui text-fg-3">
              Share links did not load just now. Reload to manage them; existing links keep working.
            </p>
          ) : (
            <ShareLinks organizationId={active.id} domainId={domain.id} domainName={domain.name} shares={shares} />
          )}

          <DomainRemoval
            organizationId={active.id}
            domainId={domain.id}
            domainName={domain.name}
            hosted={hosted?.hosted && hosted.hosted.status !== "RELEASED" ? { value: hosted.hosted.value } : null}
          />
        </div>
      </div>
    </div>,
    trail,
  );
}

function StepMark({ status }: { status: OnboardingState["steps"][number]["status"] }) {
  if (status === "done") {
    return (
      <span aria-hidden className="mt-[3px] grid size-4 place-items-center rounded-full bg-ok">
        <svg viewBox="0 0 16 16" className="hb-draw-check size-2.5 text-white">
          <path d="M2.5 8.5 6.5 12.5 13.5 3.5" fill="none" stroke="currentColor" strokeWidth="2.6" />
        </svg>
      </span>
    );
  }
  if (status === "pending") {
    return <span aria-hidden className="mt-[3px] block size-4 rounded-full border-2 border-act" />;
  }
  if (status === "optional") {
    return <span aria-hidden className="mt-[3px] block size-4 rounded-full border border-fg-4" />;
  }
  return <span aria-hidden className="mt-[3px] block size-4 rounded-full border border-rule-2 bg-paper-3" />;
}
