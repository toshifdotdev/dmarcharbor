import Link from "next/link";
import { ApiError, listClients, getAllDomainSignals } from "@/lib/api";
import { resolvePosture } from "@/lib/posture";
import { resolveActiveWorkspace } from "@/lib/session";
import type { DomainSignals } from "@/lib/types";
import { Shell } from "@/components/shell";
import { PortfolioGrid, type PortfolioRow } from "@/components/portfolio";

export default async function PortfolioPage() {
  const { workspaces, active } = await resolveActiveWorkspace();

  let rows: PortfolioRow[] = [];
  let loadError: string | null = null;

  if (active) {
    try {
      const clients = await listClients(active.id);
      const domains = clients.flatMap((c) => c.domains);
      const signals = await getAllDomainSignals(active.id, domains);

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
      loadError =
        err instanceof ApiError && err.status === 402
          ? "This plan does not include portfolio monitoring yet."
          : "Could not load the portfolio. The measurement API did not answer.";
    }
  }

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

        {loadError ? (
          <div
            role="alert"
            className="lift rounded-[2px] border px-4 py-3 text-[14px]"
            style={{
              borderColor: "var(--color-line-strong)",
              background: "var(--color-surface)",
              color: "var(--color-ink-2)",
            }}
          >
            {loadError}
          </div>
        ) : (
          <PortfolioGrid rows={rows} />
        )}
      </div>
    </Shell>
  );
}
