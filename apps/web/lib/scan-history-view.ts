import { instantLabel } from "./instant";
import type { ScanRow, ScanRunStatus } from "./types";

/**
 * A DNS scan row with its times formatted before it reaches the browser.
 *
 * Kept out of components/harbor/scan-history.tsx on purpose: that file is a
 * client module, and a function exported from one cannot be called by a
 * server component. The domain page called it on the server, which threw as
 * soon as a domain had a single scan.
 */
export interface ScanHistoryRow {
  id: string;
  status: ScanRunStatus;
  trigger: "MANUAL" | "SCHEDULED";
  changeCount: number;
  startedLabel: string;
  completedLabel: string | null;
  requestedBy: string;
  error: string | null;
}

/** The API row, in the strings the server already formatted. */
export function toScanHistoryRow(scan: ScanRow): ScanHistoryRow {
  return {
    id: scan.id,
    status: scan.status,
    trigger: scan.trigger,
    changeCount: scan.changeCount ?? 0,
    startedLabel: instantLabel(scan.startedAt),
    completedLabel: scan.completedAt ? instantLabel(scan.completedAt) : null,
    requestedBy: scan.requestedBy?.name?.trim() || scan.requestedBy?.email?.trim() || "an automated job",
    error: scan.error,
  };
}
