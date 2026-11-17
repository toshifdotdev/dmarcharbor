"use client";

/**
 * domain-monitoring.tsx — whether this domain stores new reports.
 *
 * While an account has more counted domains than its plan monitors, the newest
 * are paused: history stays, new reports are not collected. An owner can pause
 * a domain to free a place and resume one when a place is free.
 *
 * Two parts: the notice under the header while the domain is paused, and the
 * header's Pause monitoring action. The action is offered only when the plan
 * is full, which is the one time freeing a place matters, and it asks first,
 * because reports that arrive while paused are not kept.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { setDomainMonitoring } from "@/lib/ops-client";
import type { DomainMonitoringView } from "@/lib/types";

const FAILED = "The change could not be saved. Nothing was changed.";

function places(m: DomainMonitoringView): string | null {
  if (m.limit === null) return null;
  return `${m.used} of ${m.limit} active domain${m.limit === 1 ? "" : "s"} in use on your plan.`;
}

/** The plan is full: no place is free for another domain. */
function planFull(m: DomainMonitoringView): boolean {
  return m.limit !== null && m.used >= m.limit;
}

export function PauseMonitoringButton({
  organizationId,
  domainId,
  domainName,
  monitoring,
}: {
  organizationId: string;
  domainId: string;
  domainName: string;
  monitoring: DomainMonitoringView;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pause() {
    setBusy(true);
    setError(null);
    const result = await setDomainMonitoring(organizationId, domainId, true);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message ?? FAILED);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} data-testid="monitoring-pause">
        Pause monitoring
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={pause}
        busy={busy}
        error={error}
        testId="monitoring-pause"
        title="Pause monitoring?"
        confirmLabel="Pause monitoring"
        body={
          <>
            <p>
              New DMARC reports for <span className="data">{domainName}</span> will not be collected while it is paused, and
              reports that arrive in that time are not kept. Its history stays readable.
            </p>
            <p className="mt-2 tnum">
              {places(monitoring)} Pausing frees a place for another domain. You can resume it when a place is free.
            </p>
          </>
        }
      />
    </>
  );
}

export function MonitoringPausedNotice({
  organizationId,
  domainId,
  monitoring,
  canEdit,
}: {
  organizationId: string;
  domainId: string;
  monitoring: DomainMonitoringView;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const full = planFull(monitoring);

  async function resume() {
    setBusy(true);
    setError(null);
    const result = await setDomainMonitoring(organizationId, domainId, false);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message ?? FAILED);
      return;
    }
    router.refresh();
  }

  return (
    <Notice
      tone="warn"
      testId="domain-monitoring"
      title="Monitoring paused"
      action={
        canEdit ? (
          <>
            <Button variant="primary" size="sm" busy={busy} disabled={full} onClick={resume} data-testid="monitoring-resume">
              Resume monitoring
            </Button>
            {full ? (
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
          ? "Your account has more active domains than its plan monitors, and this is one of the newest, so it was paused."
          : "Monitoring was paused from this page to free a place on the plan."}{" "}
        Its history stays readable. New reports for it are not collected until it is resumed.
      </p>
      {places(monitoring) ? (
        <p className="mt-1 tnum">
          {places(monitoring)}
          {full ? " Pause another domain or choose a larger plan to resume this one." : " A place is free, so it can be resumed now."}
        </p>
      ) : null}
      {error ? <p className="mt-1 text-fail">{error}</p> : null}
    </Notice>
  );
}
