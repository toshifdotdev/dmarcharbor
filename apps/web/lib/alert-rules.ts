/**
 * alert-rules.ts — what each alert metric measures, in the API's own terms.
 *
 * Read from apps/api/src/services/alert.service.ts (observedFor, summarise,
 * riskByMetric) and the zod schema in models/alert.model.ts. Nothing here is a
 * product decision: it is the contract, written down once so the form, the
 * rules table and the events list all say the same thing.
 *
 *   FAILURE_COUNT              failed DMARC messages in the window
 *   FAILURE_RATE               DMARC failures as a share of messages in the
 *                              window, a whole percent (the API rounds;
 *                              thresholds are integers)
 *   SOURCE_IP_VOLUME           messages from the single busiest source IP in
 *                              the window
 *   FORENSIC_FAILURES          forensic reports with a reject or quarantine
 *                              disposition in the window
 *   REPORT_SILENCE             hours since the last report of any kind; the
 *                              window is not used
 *   NEW_UNAUTHENTICATED_SOURCE sources seen in the last 7 days that failed both
 *                              SPF and DKIM; the window is not used
 *
 * Every metric is "high" risk except REPORT_SILENCE ("medium"), which is what
 * the "only high risk alerts" preference filters on.
 */

import type { AlertEventRow, AlertMetric, AlertOperator, AlertRuleRow, EntitlementKey } from "./types";

export interface MetricMeta {
  label: string;
  /** The unit of the threshold and the observed value. */
  unit: { one: string; many: string; suffix?: string };
  /** One sentence: what the number is. */
  measures: string;
  /** Whether windowMinutes changes what is measured. */
  usesWindow: boolean;
  feature: EntitlementKey;
  risk: "high" | "medium";
  /** A starting threshold that makes sense for the metric. */
  suggested: { operator: AlertOperator; threshold: number };
}

export const METRICS: Record<AlertMetric, MetricMeta> = {
  FAILURE_COUNT: {
    label: "Failed DMARC (count)",
    unit: { one: "message", many: "messages" },
    measures: "Failed DMARC: messages where both SPF and DKIM failed alignment, across every sender.",
    usesWindow: true,
    feature: "alerts.email",
    risk: "high",
    suggested: { operator: "GREATER_THAN", threshold: 10 },
  },
  FAILURE_RATE: {
    label: "Failed DMARC (% of volume)",
    unit: { one: "%", many: "%", suffix: "%" },
    measures: "The share of all messages in the window that failed DMARC: both SPF and DKIM failed alignment. A whole percent.",
    usesWindow: true,
    feature: "alerts.email",
    risk: "high",
    suggested: { operator: "GREATER_THAN", threshold: 5 },
  },
  SOURCE_IP_VOLUME: {
    label: "Source IP volume",
    unit: { one: "message", many: "messages" },
    measures: "Messages from the single busiest sending IP in the window.",
    usesWindow: true,
    feature: "alerts.email",
    risk: "high",
    suggested: { operator: "GREATER_THAN", threshold: 1000 },
  },
  FORENSIC_FAILURES: {
    label: "Forensic failures",
    unit: { one: "report", many: "reports" },
    measures: "Forensic reports in the window where the receiver rejected or quarantined the message.",
    usesWindow: true,
    feature: "alerts.email",
    risk: "high",
    suggested: { operator: "GREATER_THAN_OR_EQUAL", threshold: 1 },
  },
  REPORT_SILENCE: {
    label: "Report silence",
    unit: { one: "hour", many: "hours", suffix: "h" },
    measures:
      "Hours since the last DMARC report of any kind arrived. A feed that stopped is not quiet and not healthy: this rule names the silence.",
    usesWindow: false,
    feature: "alerts.email",
    risk: "medium",
    suggested: { operator: "GREATER_THAN", threshold: 48 },
  },
  NEW_UNAUTHENTICATED_SOURCE: {
    label: "New unauthenticated source",
    unit: { one: "source", many: "sources" },
    measures: "Sending sources seen in the last 7 days that failed both SPF and DKIM: what spoofing usually looks like.",
    usesWindow: false,
    feature: "alerts.spoofing",
    risk: "high",
    suggested: { operator: "GREATER_THAN_OR_EQUAL", threshold: 1 },
  },
};

export const METRIC_ORDER: AlertMetric[] = [
  "FAILURE_COUNT",
  "FAILURE_RATE",
  "SOURCE_IP_VOLUME",
  "FORENSIC_FAILURES",
  "REPORT_SILENCE",
  "NEW_UNAUTHENTICATED_SOURCE",
];

/** The three operators the API accepts. LESS_THAN_OR_EQUAL and EQUAL are 400s. */
export const OPERATORS: Array<{ value: AlertOperator; label: string; symbol: string }> = [
  { value: "GREATER_THAN", label: "greater than", symbol: ">" },
  { value: "GREATER_THAN_OR_EQUAL", label: "greater than or equal", symbol: "≥" },
  { value: "LESS_THAN", label: "less than", symbol: "<" },
];

export const LIMITS = {
  name: { min: 3, max: 100 },
  threshold: { min: 0, max: 1_000_000 },
  minutes: { min: 5, max: 43_200 },
  reminders: { min: 1, max: 5 },
  recipients: { min: 1, max: 50 },
} as const;

/** The API's defaults when a field is omitted (alert.controller.ts). */
export const DEFAULTS = { windowMinutes: 1440, cooldownMinutes: 1440, maxReminderLevel: 3 } as const;

export function isMetric(v: string): v is AlertMetric {
  return v in METRICS;
}

/** "1 day", "6 hours", "90 minutes": a duration a person reads at a glance. */
export function minutesLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (minutes % 1440 === 0) return plural(minutes / 1440, "day");
  if (minutes % 60 === 0) return plural(minutes / 60, "hour");
  if (minutes > 120) return `${plural(Math.floor(minutes / 60), "hour")} ${plural(minutes % 60, "minute")}`;
  return plural(minutes, "minute");
}

export function valueWithUnit(metric: AlertMetric | string, value: number): string {
  const meta = isMetric(metric) ? METRICS[metric] : null;
  if (!meta) return String(value);
  if (meta.unit.suffix) return `${value}${meta.unit.suffix}`;
  return `${value.toLocaleString("en-GB")} ${value === 1 ? meta.unit.one : meta.unit.many}`;
}

/** "Failed messages (count) > 10 messages in 1 day" — the rule as one line. */
export function conditionLabel(rule: Pick<AlertRuleRow, "metric" | "operator" | "threshold" | "windowMinutes">): string {
  const meta = METRICS[rule.metric];
  const op = OPERATORS.find((o) => o.value === rule.operator)?.label ?? rule.operator.toLowerCase().replace(/_/g, " ");
  const base = `${meta?.label ?? rule.metric} ${op} ${valueWithUnit(rule.metric, rule.threshold)}`;
  return meta?.usesWindow ? `${base}, over ${minutesLabel(rule.windowMinutes)}` : base;
}

export type EventState = "open" | "acknowledged" | "resolved";

export function eventState(e: Pick<AlertEventRow, "acknowledgedAt" | "resolvedAt">): EventState {
  if (e.resolvedAt) return "resolved";
  if (e.acknowledgedAt) return "acknowledged";
  return "open";
}

/**
 * When the next reminder for an open event can go out, by the scheduler's own
 * rule: triggeredAt + cooldown × current level, and none once the level has
 * reached the rule's maximum. "Not before" is the honest phrasing: the
 * scheduler runs on an interval, so the send lands at or after this time.
 */
export function nextReminderAt(
  e: Pick<AlertEventRow, "triggeredAt" | "reminderLevel" | "acknowledgedAt" | "resolvedAt">,
  rule: Pick<AlertRuleRow, "cooldownMinutes" | "maxReminderLevel"> | undefined,
): Date | null {
  if (!rule || eventState(e) !== "open") return null;
  if (e.reminderLevel >= rule.maxReminderLevel) return null;
  const t = new Date(e.triggeredAt).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + rule.cooldownMinutes * 60_000 * Math.max(1, e.reminderLevel));
}
