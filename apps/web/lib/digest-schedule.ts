/**
 * digest-schedule.ts — when a digest goes out, by the scheduler's own rule.
 *
 * apps/api/src/services/report-digest.service.ts (isDigestDue): a digest is
 * due when the UTC day matches (weekday for WEEKLY, day of month for MONTHLY),
 * the UTC hour has reached sendHourUtc, and it has not already been sent that
 * UTC date. So the next send is the next matching UTC day at that hour, or
 * "due now" when today matches, the hour has passed and nothing went out yet:
 * it then leaves on the scheduler's next pass.
 */

import type { ReportDigestRow } from "./types";

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

type Schedule = Pick<ReportDigestRow, "frequency" | "sendHourUtc" | "weekday" | "dayOfMonth" | "lastSentAt">;

function matches(d: Schedule, day: Date): boolean {
  return d.frequency === "WEEKLY" ? day.getUTCDay() === d.weekday : day.getUTCDate() === d.dayOfMonth;
}

/** The next time the scheduler will send it, or "now" when it is due already. */
export function nextDigestDue(d: Schedule, now: Date): Date | "now" {
  const today = now.toISOString().slice(0, 10);
  const sentToday = d.lastSentAt ? new Date(d.lastSentAt).toISOString().slice(0, 10) === today : false;
  if (matches(d, now) && !sentToday && now.getUTCHours() >= d.sendHourUtc) return "now";

  // Walk forward a day at a time; a monthly digest is at most ~31 days out.
  for (let i = 0; i <= 62; i++) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i, d.sendHourUtc));
    if (!matches(d, day)) continue;
    if (i === 0 && (sentToday || now.getUTCHours() >= d.sendHourUtc)) continue;
    return day;
  }
  return new Date(NaN);
}

function hourLabel(h: number): string {
  return `${String(h).padStart(2, "0")}:00 UTC`;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}

/** "Every Monday at 09:00 UTC" / "Monthly on the 1st at 09:00 UTC". */
export function scheduleLabel(d: Pick<ReportDigestRow, "frequency" | "sendHourUtc" | "weekday" | "dayOfMonth">): string {
  return d.frequency === "WEEKLY"
    ? `Every ${WEEKDAYS[d.weekday] ?? "week"} at ${hourLabel(d.sendHourUtc)}`
    : `Monthly on the ${ordinal(d.dayOfMonth)} at ${hourLabel(d.sendHourUtc)}`;
}

export const DIGEST_LIMITS = { recipients: 20, dayOfMonth: 28 } as const;

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** Recipients as typed: split, trimmed, lower-cased, deduplicated; the bad ones named. */
export function parseRecipients(raw: string): { valid: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const v = part.trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    (EMAIL.test(v) ? valid : invalid).push(v);
  }
  return { valid, invalid };
}
