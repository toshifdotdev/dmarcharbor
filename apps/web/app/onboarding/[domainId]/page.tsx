import Link from "next/link";
import { notFound } from "next/navigation";
import { listClients, getOnboardingState, ApiError } from "@/lib/api";
import {
  listReportShares,
  verifyDomain,
  OpsError,
} from "@/lib/api-ops";
import { resolveActiveWorkspace } from "@/lib/session";
import type { OnboardingState, ReportShareRow, DomainRow, VerifyDomainResult } from "@/lib/types";
import { Shell } from "@/components/shell";
import { VerifyControls } from "@/components/onboarding-client";
import { ShareForm } from "@/components/shares-client";

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
  if (!active) return null;

  let domain: DomainRow | null = null;
  let clientName = "";
  const clients = await listClients(active.id).catch(() => []);
  for (const c of clients) {
    const hit = c.domains.find((d) => d.id === domainId);
    if (hit) {
      domain = hit;
      clientName = c.name;
      break;
    }
  }
  if (!domain) notFound();

  let onboarding: OnboardingState;
  let verification: VerifyDomainResult["verification"] | null;

  try {
    onboarding = await getOnboardingState(active.id, domainId);
    // The ownership record + live lookup status live in the verify response.
    // Running it here (idempotent — it only emits events on a transition) is
    // how the page can show the record to publish before the operator clicks
    // anything; a fresh check on demand re-runs it through the same path.
    // The server client returns the response directly and throws on failure;
    // only the browser wrapper wraps results in { ok, data }.
    const verified = await verifyDomain(active.id, domainId).catch(() => null);
    verification = verified ? verified.verification : null;
  } catch (error) {
    // Two clients throw two error classes: getOnboardingState goes through
    // lib/api (ApiError), verifyDomain through lib/api-ops (OpsError). A 404
    // from either is "this domain is not yours" and renders not-found — an
    // unrecognised class would 500 instead.
    if (
      (error instanceof OpsError || error instanceof ApiError) &&
      error.status === 404
    ) {
      notFound();
    }
    throw error;
  }
  const shares: ReportShareRow[] = (await listReportShares(active.id).catch(() => ({ items: [] }))).items;

  const steps = onboarding?.steps ?? [];
  const suggested = onboarding?.suggestedRecord ?? null;

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
                — DNS takes time to propagate.
              </p>
              <div className="mt-4">
                <VerifyControls
                  organizationId={active.id}
                  domainId={domainId}
                  initial={verification}
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
                    Generated by the platform — publish it at{" "}
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
