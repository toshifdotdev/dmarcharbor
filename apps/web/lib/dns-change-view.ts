import { instantLabel } from "./instant";
import type { DnsChangeRow } from "./types";

/** A change row with the time strings formatted before it reaches the browser. */
export interface DnsChangeView extends DnsChangeRow {
  detectedLabel: string;
  detectedRelative: string;
  acknowledgedLabel: string | null;
  acknowledgedRelative: string | null;
}

function relativeLabel(value: string, now: Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "time not recorded";
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} day${days === 1 ? "" : "s"} ago`;
  return instantLabel(value);
}

export function toDnsChangeView(row: DnsChangeRow, now = new Date()): DnsChangeView {
  return {
    ...row,
    detectedLabel: instantLabel(row.detectedAt),
    detectedRelative: relativeLabel(row.detectedAt, now),
    acknowledgedLabel: row.acknowledgedAt ? instantLabel(row.acknowledgedAt) : null,
    acknowledgedRelative: row.acknowledgedAt ? relativeLabel(row.acknowledgedAt, now) : null,
  };
}
