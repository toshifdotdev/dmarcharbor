"use client";

/**
 * domain-monitoring.tsx — whether this domain stores new reports.
 *
 * While an account has more counted domains than its plan monitors, the newest
 * are paused: history stays, new reports are not collected. An owner can pause
 * a domain to free a place and resume one when a place is free. Shown only
 * when paused, or when the person can pause it (as a quiet control).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { setDomainMonitoring } from "@/lib/ops-client";
import type { DomainMonitoringView } from "@/lib/types";

function usage(m: DomainMonitoringView): string | null {
  if (m.limit === null) return null;
  return `${m.used} of ${m.limit} active domain${m.limit === 1 ? "" : "s"} in use on your plan.`;
}

export function DomainMonitoring({
  organizationId,
  domainId,
  initial,
  canEdit,
}: {
  organizationId: string;
  domainId: string;
  initial: DomainMonitoringView;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [monitoring, setMonitoring] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(paused: boolean) {
    setBusy(true);
    setError(null);
    const result = await setDomainMonitoring(organizationId, domainId, paused);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message ?? "The change could not be saved. Nothing was changed.");
      return;
    }
    setMonitoring(result.data.monitoring);
    router.refresh();
  }

  const used = usage(monitoring);
  const full = monitoring.limit !== null && monitoring.used >= monitoring.limit;

  if (!monitoring.paused) {
    if (!canEdit) return null;
    return (
      <div className="flex flex-wrap items-center justify-end gap-3 text-meta text-fg-3" data-testid="domain-monitoring">
        {error ? <span className="text-fail">{error}</span> : null}
        <Button variant="ghost" size="sm" busy={busy} onClick={() => change(true)}>
          Pause monitoring
        </Button>
      </div>
    );
  }

  return (
    <Notice
      tone="warn"
      testId="domain-monitoring"
      title="Monitoring paused"
      action={
        canEdit ? (
          <>
            <Button variant="primary" size="sm" busy={busy} disabled={full} onClick={() => change(false)}>
              Resume monitoring
            </Button>
            {monitoring.reason === "plan_limit" || full ? (
              <ButtonLink href="/billing" variant="secondary" size="sm">
                Plans
              </ButtonLink>
            ) : null}
          </>
        ) : null
      }
    >
      <p>
        {monitoring.reason === "plan_limit"
          ? "Your account has more active domains than its plan monitors, so this newer domain was paused."
          : "Monitoring was paused from this page."}{" "}
        Its history stays readable. New reports for it are not collected until it is resumed.
      </p>
      {used ? <p className="mt-1 tnum">{used}{full ? " Pause another domain or choose a larger plan to resume this one." : ""}</p> : null}
      {error ? <p className="mt-1 text-fail">{error}</p> : null}
    </Notice>
  );
}
