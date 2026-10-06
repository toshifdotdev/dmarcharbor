import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { listClients, getOnboardingState, ApiError } from "@/lib/api";
import {
  listReportShares,
  OpsError,
} from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import type { OnboardingState, ReportShareRow, DomainRow } from "@/lib/types";
import { Shell } from "@/components/shell";
import { VerifyControls } from "@/components/onboarding-client";
import { ShareForm } from "@/components/shares-client";
import { ErrorState } from "@/components/data-states";

/**
 * The onboarding funnel: verify ownership → publish the DMARC record → await
 * reports. Every string on this page is the API's own: the TXT record and its
 * lookup status come from the verify response, the DMARC record is
 * onboarding.suggestedRecord rendered verbatim (never assembled client-side,
 * so pct, ruf and the notes stay consistent with what the backend verifies),
 * and the step list is the API's own progress model — the UI invents none.
 *
 * HONESTY RULE: a domain publishing rua=https: is CONFIGURED but we do not
 * COLLECT those reports. The aggregate_reporting step carries that
 * distinction in its status and detail ("does not read reports from there
 * yet"), and this page renders it as-is. Never "reports not configured",
 * never "reports will be delivered" for a web-only record.
 */
export default async function OnboardingPage({
  params,
}: {
  params: Promise<{ domainId: string }>;
}) {
  const { domainId } = await params;
  const { workspaces, active } = await resolveActiveWorkspace();
  if (!active) redirect("/welcome");

  // A failed client list is an API problem, NOT a missing domain: rendering
  // not-found here told an operator their domain was gone on every transient
  // blip. Distinguish the two facts.
  let domain: DomainRow | null = null;
  let clientName = "";
  let clientsFailed = false;
  const clients = await listClients(active.id).catch(() => {
    clientsFailed = true;
    return [];
  });
  for (const c of clients) {
    const hit = c.domains.find((d) => d.id === domainId);
    if (hit) {
      domain = hit;
      clientName = c.name;
      break;
    }
  }
  // Three facts the old code blurred into one notFound(): the client list
  // failed (an API problem), the domain is not yours (a real 404), and the
  // domain exists. Only the middle one is a missing domain. This page used to
  // POST a live DNS verification on EVERY RENDER, which mutated domain status,
  // emitted a webhook and emailed the customer again per page view: the lookup
  // now happens when the operator presses the button, never on render.
  let onboarding: OnboardingState | null = null;
  let stateFailed: string | null = null;

  if (!domain) notFound();

  if (domain) {
    try {
      onboarding = await getOnboardingState(active.id, domainId);
    } catch (error) {
      if (
        (error instanceof OpsError || error instanceof ApiError) &&
        error.status === 404
      ) {
        notFound();
      }
      // A transient failure is a failure state on this page, not a blank
      // screen and not a not-found: the operator's domain did not go anywhere.
      stateFailed =
        error instanceof Error ? error.message : "The domain state could not be loaded.";
    }
  }
  const shares: ReportShareRow[] = (await listReportShares(active.id).catch(() => ({ items: [] }))).items;

  const steps = onboarding?.steps ?? [];
  const suggested = onboarding?.suggestedRecord ?? null;

  // A failed load is its own page, not a ternary branch inside this one: a
  // fragment spanning the whole body is how JSX nesting breaks, and the
  // failure deserves a full page of its own anyway.
  if (clientsFailed) {
    return (
      <Shell workspaces={workspaces} activeWorkspace={active}>
        <div className="mx-auto w-full max-w-[560px] px-6 py-16">
          <ErrorState
            what="the client list"
            detail="This page could not confirm which domain this is. That is an API problem, not a missing domain: the domain is still yours."
          />
        </div>
      </Shell>
    );
  }
  if (stateFailed) {
    return (
      <Shell workspaces={workspaces} activeWorkspace={active}>
        <div className="mx-auto w-full max-w-[560px] px-6 py-16">
          <ErrorState what="this domain's state" detail={stateFailed} />
        </div>
      </Shell>
    );
  }

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-6">
        <div>
          <Link
            href="/clients"
            className="num text-[11px] tracking-[0.14em] uppercase transition-colors"
            style={{ color: "var(--color-ink-3)" }}
          >
            ← Clients
          </Link>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1
              className="num text-[24px] font-semibold tracking-[-0.02em]"
              style={{ color: "var(--color-ink)" }}
            >
              {domain.name}
            </h1>
            <span className="text-[12px]" style={{ color: "var(--color-ink-3)" }}>
              {clientName}
            </span>
            <span
              className="num ml-auto text-[10.5px] tracking-[0.14em] uppercase"
              style={{ color: "var(--color-ink-3)" }}
            >
              {onboarding?.completedSteps ?? 0} of {onboarding?.totalSteps ?? 0} steps done
            </span>
          </div>
          <p className="mt-1.5 max-w-3xl text-[13.5px]" style={{ color: "var(--color-ink-2)" }}>
            Get this domain measuring: verify you own it, publish the DMARC
            record, and wait for the world's reporters to send their first
            summary.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex flex-col gap-4">
            {/* Step 1+2: ownership and the record. */}
            <section
              className="lift rounded-[2px] border p-5"
              style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
            >
              <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
                1 · Verify domain ownership
              </h2>
              <p className="mt-1.5 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                Publish the TXT record below at your DNS provider, then run the
                check.{" "}
                <strong style={{ color: "var(--color-ink)" }}>
                  A lookup that finds nothing is normal
                </strong>{" "}
               : DNS takes time to propagate.
              </p>
              <div className="mt-4">
                <VerifyControls
                  organizationId={active.id}
                  domainId={domainId}
                  initial={null}
                  published={domain.status === "VERIFIED"}
                />
              </div>
            </section>

            <section
              className="lift rounded-[2px] border p-5"
              style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
            >
              <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
                2 · Publish the DMARC record
              </h2>
              {suggested ? (
                <>
                  <p className="mt-1.5 text-[13px]" style={{ color: "var(--color-ink-2)" }}>
                    Generated by the platform: publish it at{" "}
                    <span className="num">{suggested.host}</span>. It is exactly
                    what the backend will verify, so the two cannot disagree.
                  </p>
                  <div
                    className="lift mt-3 rounded-[2px] border"
                    style={{
                      background: "var(--color-elevate)",
                      borderColor: "var(--color-line-strong)",
                    }}
                  >
                    <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: "var(--color-line)" }}>
                      <span className="num text-[10.5px] tracking-[0.14em] uppercase" style={{ color: "var(--color-ink-3)" }}>
                        {suggested.host} · {suggested.type}
                      </span>
                      <span className="num text-[10.5px]" style={{ color: "var(--color-ink-3)" }}>
                        p={suggested.policy} · pct={suggested.pct}
                      </span>
                    </div>
                    <p
                      className="num px-4 py-3 text-[12.5px] break-all"
                      style={{ color: "var(--color-ink)" }}
                      data-testid="suggested-record"
                    >
                      {suggested.value}
                    </p>
                  </div>
                  {suggested.notes.length > 0 ? (
                    <ul className="mt-3 flex flex-col gap-1.5">
                      {suggested.notes.map((n) => (
                        <li key={n} className="text-[12px]" style={{ color: "var(--color-ink-3)" }}>
                          · {n}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <p className="mt-2 text-[13px]" style={{ color: "var(--color-ink-3)" }}>
                  The generated record appears once domain ownership is verified.
                </p>
              )}
            </section>

            {/* Shares: create, list, revoke. Links the existing public
                GET /api/reports/share/:token surface — never rebuilt here. */}
            <ShareForm
              organizationId={active.id}
              domainId={domainId}
              shares={shares}
            />
          </div>

          {/* The API's own progress model, rendered as-is. */}
          <section
            className="lift rounded-[2px] border p-5"
            style={{ background: "var(--color-surface)", borderColor: "var(--color-line)" }}
          >
            <h2 className="text-[16px] font-semibold tracking-[-0.012em]">
              3 · Setup progress
            </h2>
            <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
              Each step below is the platform's own assessment of this domain.
            </p>
            <ol className="mt-4 flex flex-col">
              {steps.map((s, i) => (
                <li
                  key={s.id}
                  data-step={s.id}
                  data-step-status={s.status}
                  className="border-b py-3.5"
                  style={{ borderColor: "rgba(255,255,255,0.055)" }}
                >
                  <div className="flex items-baseline gap-3">
                    <span
                      className="num text-[10px] tracking-[0.14em] uppercase"
                      style={{
                        minWidth: 56,
                        color:
                          s.status === "done"
                            ? "var(--color-pass)"
                            : s.status === "blocked"
                              ? "var(--color-ink-3)"
                              : s.status === "optional"
                                ? "var(--color-unmeasured)"
                                : "var(--color-unverified)",
                      }}
                    >
                      {s.status}
                    </span>
                    <div>
                      <div className="text-[13px]" style={{ color: "var(--color-ink)" }}>
                        {i + 1} · {s.title}
                      </div>
                      <div className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--color-ink-2)" }}>
                        {s.detail}
                        {/* The rua=https thread: a domain whose reports go to a
                            web endpoint is fixed by collecting from a mailbox —
                            so the step points at that section rather than
                            leaving the operator to find it. */}
                        {s.id === "aggregate_reporting" &&
                        s.status !== "done" &&
                        s.detail.includes("web endpoint") ? (
                          <>
                            {" "}
                            <Link
                              href="/settings/mailbox"
                              className="underline"
                              style={{ color: "var(--color-ink)" }}
                              data-testid="rua-mailbox-link"
                            >
                              Set up the report mailbox →
                            </Link>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </Shell>
  );
}
