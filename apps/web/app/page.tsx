import { Suspense } from "react";
import Link from "next/link";
import { ApiError, listClients, listWorkspaces, getAllDomainSignals } from "@/lib/api";
import { resolvePosture } from "@/lib/posture";
import { pickActiveWorkspace } from "@/lib/session";
import type { DomainSignals } from "@/lib/types";
import { Shell } from "@/components/shell";
import { MarketingHome } from "@/components/marketing";
import { PortfolioGrid, type PortfolioRow } from "@/components/portfolio";
import { EmptyState, ErrorState, LoadingState } from "@/components/data-states";
import { UpgradePrompt } from "@/components/upgrade-gate";

/**
 * The root route serves two audiences:
 *
 *   stranger   — the marketing homepage: what the product does and who it is
 *                for, in plain words, with sign-up and sign-in entry points.
 *                resolveActiveWorkspace redirects 401/403 to /sign-in, so a
 *                session probe is the branch — never a hardcoded landing page
 *                shown to a signed-in operator.
 *   signed in  — the portfolio, in three distinguishable states — never two:
 *
 *                loading — a slow call on a slow connection is a waiting state
 *                          (the Tide), not a blank page and not an error
 *                empty   — a first run. Says what to do next (create a
 *                          client), never an empty table standing in for
 *                          "welcome"
 *                failed  — says what failed and offers a retry, and never
 *                          renders as "no domains" — that lie costs someone an
 *                          afternoon
 *
 * The fetch body sits behind Suspense so the loading state is real: server
 * data is awaited before render, so without a boundary a 2-11s call paints a
 * page that looks broken while it is merely slow.
 */
export default async function RootPage() {
  // One workspace call answers both questions: a definite 401/403 means
  // "stranger" and renders the marketing homepage; anything else is the app,
  // which has its own error states. A slow or failing API must never show a
  // landing page to someone who just signed in.
  let workspaces;
  try {
    workspaces = await listWorkspaces();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      return <MarketingHome />;
    }
    throw error;
  }

  const active = await pickActiveWorkspace(workspaces);

  return (
    <Shell workspaces={workspaces} activeWorkspace={active}>
      <div className="flex flex-col gap-4">
        <div className="flex items-baseline gap-4">
          <h1 className="label">Portfolio</h1>
          <Link
            href="/"
            className="num ml-auto text-[12px] tracking-[0.12em] uppercase transition-colors"
            style={{ color: "var(--color-ink-3)" }}
          >
            refresh ↻
          </Link>
        </div>

        <Suspense fallback={<LoadingState label="Loading portfolio" />}>
          <PortfolioData organizationId={active ? active.id : ""} />
        </Suspense>
      </div>
    </Shell>
  );
}

async function PortfolioData({ organizationId }: { organizationId: string }) {
  let rows: PortfolioRow[] = [];
  let loadError: string | null = null;
  let planError: string | null = null;

  try {
    const clients = await listClients(organizationId);
    const domains = clients.flatMap((c) => c.domains);
    const signals = await getAllDomainSignals(organizationId, domains);

    rows = clients.flatMap((client) =>
      client.domains.map((domain) => {
        const s: DomainSignals | null = signals.get(domain.id) ?? null;
        return {
          client,
          domain,
          signals: s,
          // Rule Zero: a row with no signals is "signals pending", never a
          // posture. resolvePosture only runs on real measurements.
          resolved: s ? resolvePosture(s) : null,
        };
      }),
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 402) {
      planError = err.message;
    } else {
      // A failed load is never shown as "nothing here".
      loadError = "the portfolio";
    }
  }

  if (planError) {
    return (
      <UpgradePrompt
        error={{ feature: "reports.aggregate", message: planError }}
        context="Portfolio monitoring needs a plan that carries it."
      />
    );
  }
  if (loadError) {
    return (
      <ErrorState
        what={loadError}
        detail="This is a connection or API problem, not an empty portfolio."
      />
    );
  }
  if (rows.length === 0) {
    // A first run, not an absence.
    return (
      <EmptyState
        title="Add your first client to start measuring"
        description="A client is a company whose domains you monitor. Create one, add its domains, and the portfolio fills in as reports arrive: usually within 24 to 48 hours of publishing the DMARC record."
        action={{ label: "Create a client", href: "/clients" }}
      />
    );
  }

  return <PortfolioGrid rows={rows} />;
}
