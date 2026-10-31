"use client";

/**
 * usage-export.tsx — download a month of per-client usage, to bill clients from.
 *
 * One row per client: domains, active domains, reports, messages, DMARC pass
 * rate, forensic reports and alerts, plus a totals row. Complete months only,
 * so a figure on an invoice never changes after it was sent. The month list is
 * built on the server and passed in, so the server markup and the browser agree.
 *
 * Shown on every plan; below Harbor the API's refusal names the plan that has
 * it, which is how a smaller agency finds out it exists.
 *
 * Test hooks: usage-month, usage-download.
 */

import { useState } from "react";
import { downloadClientBook, downloadUsageExport } from "@/lib/ops-client";
import { ActionRefusal, type ActionError } from "@/components/harbor/plan-refusal";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";

function save(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

export function UsageExport({
  organizationId,
  months,
}: {
  organizationId: string;
  months: Array<{ value: string; label: string }>;
}) {
  const [month, setMonth] = useState(months[0]?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);

  async function download() {
    if (!month || busy) return;
    setBusy(true);
    setError(null);
    const res = await downloadUsageExport(organizationId, month);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    save(res.data.bytes, res.data.filename);
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor="usage-month">
          Month to export
        </label>
        <Select
          id="usage-month"
          size="sm"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          data-testid="usage-month"
          aria-label="Month to export"
        >
          {months.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          variant="secondary"
          onClick={download}
          busy={busy}
          busyLabel="Preparing the file"
          data-testid="usage-download"
          title="One row per client for the chosen month: domains, reports, messages, pass rate and alerts, to bill clients from"
        >
          Usage CSV
        </Button>
      </div>
      <ActionRefusal error={error} className="max-w-[28rem]" />
    </div>
  );
}

/**
 * The client book as a spreadsheet: one row per domain with its client, slug,
 * ids, report address, ownership state and policy, for a PSA or CRM import or
 * to hand to a client. On every plan, because it is the client list itself.
 *
 * Test hook: client-book-download.
 */
export function ClientBookExport({ organizationId }: { organizationId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);

  async function download() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await downloadClientBook(organizationId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    save(res.data.bytes, res.data.filename);
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        size="sm"
        variant="secondary"
        onClick={download}
        busy={busy}
        busyLabel="Preparing the file"
        data-testid="client-book-download"
        title="Every client and domain: ids, report address, ownership and policy, one row per domain"
      >
        Client book CSV
      </Button>
      <ActionRefusal error={error} className="max-w-[28rem]" />
    </div>
  );
}
