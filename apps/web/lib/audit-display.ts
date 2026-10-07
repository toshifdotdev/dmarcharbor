/**
 * audit-display.ts — the audit trail, read as English.
 *
 * An audit log is written by the API in SCREAMING_SNAKE and stored as JSON,
 * because it is a machine record. Nobody investigates an incident by reading
 * `FORENSIC_IDENTITY_ENABLED`. Everything in this module is the translation from
 * that record to a sentence, and it is a PURE function of the row: no clock, no
 * fetch, no formatting guess about which plan is current. The page calls it on
 * the server and passes strings down, so what is rendered here is what was
 * rendered on the server.
 *
 * Two rules run through all of it:
 *
 * 1. Nothing is invented. An action with no sentence of its own falls back to
 *    reading its own name out loud, and a target type nobody has seen yet falls
 *    back the same way. A new enum value shows as words, not as a blank.
 * 2. Nothing is implied. There is no FAILED outcome, so nothing here claims a
 *    refused action is a crash; and the log is not complete, so no label on a
 *    row says it is the whole story.
 */

import type { AuditAction, AuditDetail, AuditEventRow, AuditOutcome } from "./types";

/**
 * One sentence per action, and the reason it is a Record rather than a switch:
 * the type system now refuses to compile until every value of the API's enum
 * has a sentence. An action added on the API side without one here is a build
 * failure rather than a row that reads as noise.
 */
const ACTION_SENTENCES: Record<AuditAction, string> = {
  FORENSIC_IDENTITY_ENABLED: "Forensic sender identities turned on",
  FORENSIC_IDENTITY_DISABLED: "Forensic sender identities turned off",
  FORENSIC_PURGE_SINGLE: "One forensic report erased",
  FORENSIC_PURGE_DOMAIN: "Every forensic report for a domain erased",
  REPORT_SHARE_CREATED: "Report share link created",
  REPORT_SHARE_REVOKED: "Report share link revoked",
  REPORT_DIGEST_CREATED: "Report digest created",
  REPORT_DIGEST_UPDATED: "Report digest changed",
  REPORT_DIGEST_DELETED: "Report digest deleted",
  ALERT_RULE_CREATED: "Alert rule created",
  ALERT_RULE_UPDATED: "Alert rule changed",
  ALERT_RULE_DELETED: "Alert rule deleted",
  ALERT_ACKNOWLEDGED: "Alert acknowledged",
  SESSION_REVOKED: "One session revoked",
  SESSIONS_REVOKED_OTHERS: "Signed out of every other device",
  SESSIONS_REVOKED_ALL: "Signed out everywhere, including this device",
  PASSWORD_CHANGED: "Password changed",
  PLAN_CHANGED: "Plan changed",
  ENTITLEMENT_OVERRIDE_SET: "Plan limit overridden",
  ENTITLEMENT_OVERRIDE_REMOVED: "Plan limit override removed",
  EXPORT_REQUESTED: "Data export requested",
  EXPORT_DOWNLOADED: "Data export downloaded",
  EXPORT_REVOKED: "Data export revoked",
  ERASURE_REQUESTED: "Erasure requested",
  ERASURE_CANCELLED: "Erasure cancelled",
  ERASURE_COMPLETED: "Erasure completed",
  API_KEY_CREATED: "API key issued",
  API_KEY_REVOKED: "API key revoked",
  CLIENTS_BULK_IMPORTED: "Clients imported in bulk",
  DOMAINS_BULK_IMPORTED: "Domains imported in bulk",
  REFUND_ISSUED: "Refund issued",
  REFUND_REFUSED: "Refund refused",
  WEBHOOK_ENDPOINT_CREATED: "Webhook endpoint added",
  WEBHOOK_ENDPOINT_UPDATED: "Webhook endpoint changed",
  WEBHOOK_ENDPOINT_DELETED: "Webhook endpoint deleted",
  WEBHOOK_ENDPOINT_SUSPENDED: "Webhook endpoint suspended",
  WEBHOOK_ENDPOINT_PROBED: "Webhook endpoint test sent",
  PORTAL_ACCESS_GRANTED: "Client portal access granted",
  PORTAL_ACCESS_REVOKED: "Client portal access revoked",
  SUBSCRIPTION_UPDATED: "Subscription updated",
  BILLING_CHECKOUT_STARTED: "Checkout started",
  BILLING_PLAN_CHANGE_REQUESTED: "Plan change requested",
  BILLING_PLAN_CHANGE_REFUSED: "Plan change refused",
  BILLING_CANCELLED: "Subscription cancelled",
  BILLING_RESUMED: "Subscription resumed",
  DPA_ACCEPTED: "Data Processing Agreement accepted",
  TRUST_CENTER_CREATED: "Trust Center published",
  TRUST_CENTER_REVOKED: "Trust Center withdrawn",
  COMPLIANCE_PACK_ISSUED: "Compliance pack issued",
  PAYMENT_FAILED: "Payment failed",
  BRANDING_UPDATED: "White label changed",
  CUSTOM_DOMAIN_VERIFIED: "Custom domain verified",
  REPORT_INBOX_CONFIGURED: "Report inbox configured",
  REPORT_INBOX_REMOVED: "Report inbox removed",
  SSO_CONNECTION_CREATED: "Single sign-on connection added",
  SSO_CONNECTION_REMOVED: "Single sign-on connection removed",
  SSO_SIGN_IN: "Signed in through single sign-on",
};

/**
 * The filter's option list, derived from the sentences so the two cannot drift.
 * Sorted by the sentence rather than by the enum, because the sentence is what
 * a reader is scanning for.
 */
export const AUDIT_ACTIONS: readonly AuditAction[] = (
  Object.keys(ACTION_SENTENCES) as AuditAction[]
).sort((a, b) => ACTION_SENTENCES[a].localeCompare(ACTION_SENTENCES[b]));

/**
 * Whether a value from the URL is a real action.
 *
 * The page takes `?action=` from a string and must not forward it unexamined:
 * listAuditEvents casts it into the Prisma enum without validating, so anything
 * unrecognised is a database error and a 500. An unrecognised filter is dropped
 * here and reported to the reader, rather than being sent and failing.
 */
export function isAuditAction(value: string): value is AuditAction {
  return Object.prototype.hasOwnProperty.call(ACTION_SENTENCES, value);
}

export function auditActionLabel(action: string): string {
  return isAuditAction(action) ? ACTION_SENTENCES[action] : spokenWords(action);
}

// ─── target ───────────────────────────────────────────────────────────────────

/**
 * The nouns the API writes into `targetType`. It is a free-text column and one
 * caller writes PascalCase ('ReportInbox'), so this map is a set of nicer
 * names, not the whole vocabulary: anything missing falls through to
 * `auditTargetLabel`, which reads whatever it is given.
 */
const TARGET_SENTENCES: Record<string, string> = {
  organization: "Workspace",
  workspace: "Workspace",
  subscription: "Subscription",
  user: "Account",
  session: "Session",
  domain: "Domain",
  client: "Client",
  client_portal_access: "Client portal access",
  report_share: "Report share",
  report_digest: "Report digest",
  alert_rule: "Alert rule",
  alert_event: "Alert event",
  api_key: "API key",
  webhook_endpoint: "Webhook endpoint",
  sso_connection: "Single sign-on connection",
  export_job: "Data export",
  erasure_request: "Erasure request",
  forensic_report: "Forensic report",
  compliance_pack: "Compliance pack",
};

export function auditTargetLabel(targetType: string): string {
  const known = TARGET_SENTENCES[targetType];
  if (known) return known;
  const words = splitWords(targetType);
  if (words.length === 0) return targetType;
  const [first = "", ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

// ─── detail ───────────────────────────────────────────────────────────────────

export interface AuditDetailRow {
  key: string;
  value: string;
  /** The untruncated value, so a shortened row can still be read in full. */
  full: string | null;
}

/** How deep a nested object is expanded before the display gives up. */
const DETAIL_MAX_DEPTH = 3;
/** Past this length a value is shortened, with the whole thing on the title. */
const DETAIL_MAX_LENGTH = 140;

const ACRONYMS: Record<string, string> = {
  api: "API",
  dkim: "DKIM",
  dmarc: "DMARC",
  dpa: "DPA",
  ip: "IP",
  mfa: "MFA",
  mta: "MTA",
  spf: "SPF",
  sso: "SSO",
  ttl: "TTL",
  url: "URL",
};

/** `priceMinor` / `price_minor` / `PriceMinor` all read the same way out. */
function splitWords(value: string): string[] {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ACRONYMS[word.toLowerCase()] ?? word.toLowerCase());
}

/** Reads an identifier out loud: FORENSIC_PURGE_SINGLE becomes words. */
function spokenWords(value: string): string {
  const words = splitWords(value);
  return words.length === 0 ? value : words.join(" ");
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
/** `cycle_end`, `FAILURE_COUNT`: whole words joined by a mark, nothing else. */
const MARKED_WORDS = /^[A-Za-z0-9]+([_-][A-Za-z0-9]+)+$/;

/**
 * A stored value, formatted for a reader.
 *
 * Three rewrites and no more: an ISO timestamp becomes a local date, a value
 * that is one marked identifier becomes its words, and everything else is
 * quoted as stored. An address, an email, a URL and a cuid all pass through
 * untouched, because mangling an identifier would be worse than showing it raw.
 *
 * The case follows the input, on purpose. `FAILURE_COUNT` is an enum and reads
 * as "failure count"; `stale_event_ignored` is an event name and reads as itself;
 * `MOORING` is a plan tier with no separator, so the rule does not fire and the
 * brand name survives in its own capitals.
 */
function formatDetailText(value: string): string {
  if (ISO_TIMESTAMP.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  }
  if (MARKED_WORDS.test(value)) {
    const spoken = spokenWords(value);
    return value === value.toUpperCase() ? spoken.toLowerCase() : spoken;
  }
  return value;
}

function renderDetailValue(value: AuditDetail, depth: number): string {
  if (depth > DETAIL_MAX_DEPTH) return "…";
  if (value === null) return "none";
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    return value.map((item) => renderDetailValue(item, depth + 1)).join(", ");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "none";
    return renderObject(entries, depth);
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  return formatDetailText(value);
}

/**
 * A nested object as one phrase, led by its own name where it has one.
 *
 * The quota overage on a refused plan change is the case this exists for: stored
 * as `{ limit: 3, label: "clients" }`, a key-then-value dump reads "limit: 3;
 * label: clients", which puts the number before the thing it counts. Led by the
 * label it reads "clients; limit: 3", which is the order anyone scanning for the
 * cause wants.
 */
function renderObject(entries: Array<[string, AuditDetail]>, depth: number): string {
  const lead = entries.find(([key, value]) => key === "label" && typeof value === "string");
  const parts: string[] = [];
  if (lead) parts.push(renderDetailValue(lead[1], depth + 1));
  for (const [key, value] of entries) {
    if (lead && key === "label") continue;
    parts.push(`${spokenWords(key)}: ${renderDetailValue(value, depth + 1)}`);
  }
  return parts.join("; ");
}

/**
 * The `detail` JSON as rows a person can read.
 *
 * A raw dump of a detail blob is the one thing an investigator cannot use: it
 * is a wall of braces with no key order and no distinction between a null, a
 * false and a zero. So each top-level key becomes a row, nested values are
 * spelled out in place, and anything too long for a row is shortened with the
 * whole value still available on the row.
 */
export function auditDetailRows(detail: AuditDetail): AuditDetailRow[] {
  if (detail === null) return [];
  if (typeof detail !== "object" || Array.isArray(detail)) {
    const value = renderDetailValue(detail, 0);
    return [{ key: "detail", value: shorten(value), full: fullOf(value) }];
  }
  return Object.entries(detail).map(([key, value]) => {
    const rendered = renderDetailValue(value, 0);
    return { key: spokenWords(key), value: shorten(rendered), full: fullOf(rendered) };
  });
}

function shorten(value: string): string {
  return value.length > DETAIL_MAX_LENGTH ? `${value.slice(0, DETAIL_MAX_LENGTH - 1)}…` : value;
}

function fullOf(value: string): string | null {
  return value.length > DETAIL_MAX_LENGTH ? value : null;
}

// ─── time ─────────────────────────────────────────────────────────────────────

/** The local calendar day, as `YYYY-MM-DD`, so rows can be grouped by it. */
function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function parseInstant(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * How long ago, in words.
 *
 * A row stamped ahead of this render is a clock that disagrees, not an event in
 * the future, so it reads as "just now" rather than as a duration nobody can
 * check. Past a month the date is the honest answer: "47 days ago" stops
 * meaning anything.
 */
export function auditRelativeTime(createdAt: string, now: Date): string {
  const then = parseInstant(createdAt);
  if (!then) return "time not recorded";
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} day${days === 1 ? "" : "s"} ago`;
  return auditAbsoluteTime(createdAt);
}

/** The exact moment, for the row that has to be cited rather than read. */
export function auditAbsoluteTime(createdAt: string): string {
  const parsed = parseInstant(createdAt);
  if (!parsed) return "time not recorded";
  return parsed.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** A day heading: today and yesterday by name, everything else by date. */
export function auditDayLabel(dayKey: string, now: Date): string {
  if (dayKey === localDayKey(now)) return "Today";
  const yesterday = new Date(now.getTime());
  // setDate rather than subtracting a day of milliseconds: a clock change makes
  // 86,400,000 ms the wrong distance to yesterday.
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey === localDayKey(yesterday)) return "Yesterday";
  const day = new Date(`${dayKey}T00:00:00`);
  if (Number.isNaN(day.getTime())) return dayKey;
  return day.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// ─── the timeline ─────────────────────────────────────────────────────────────

/** One row, already written in English. */
export interface AuditTimelineEntry {
  id: string;
  /** Kept verbatim for the DOM hook, so a row can be found by its raw action. */
  action: string;
  actionLabel: string;
  outcome: AuditOutcome;
  /** outcome === "DENIED". Named here because that is the row being looked for. */
  denied: boolean;
  dayKey: string;
  dayLabel: string;
  absoluteTime: string;
  relativeTime: string;
  actor: string;
  /** The email, when it says something the name does not. */
  actorDetail: string | null;
  targetLabel: string;
  targetId: string | null;
  domainName: string | null;
  requestId: string | null;
  detailRows: AuditDetailRow[];
}

export interface AuditDay {
  key: string;
  label: string;
  entries: AuditTimelineEntry[];
}

export interface AuditTimeline {
  days: AuditDay[];
  total: number;
  denied: number;
}

/**
 * `now` is a parameter, not a call to the clock.
 *
 * That is the whole reason this runs on the server: a relative time computed in
 * the browser is a different string from the one the server rendered, and
 * React reports that as a hydration mismatch on every row. Given one instant,
 * every string below is reproducible.
 */
export function buildAuditTimeline(
  events: readonly AuditEventRow[],
  now: Date,
): AuditTimeline {
  // Keyed by day rather than appended to the open day. The API orders by
  // createdAt desc, so consecutive rows share a day and the two approaches
  // agree; keying means a day still comes out as ONE section if the ordering is
  // ever anything other than strictly contiguous, instead of appearing twice.
  const byDay = new Map<string, AuditTimelineEntry[]>();
  let total = 0;
  let denied = 0;

  for (const event of events) {
    const created = parseInstant(event.createdAt);
    const dayKey = created ? localDayKey(created) : "unknown";
    const deniedRow = event.outcome === "DENIED";
    const name = event.actorUser?.name?.trim() ?? "";
    const email = event.actorUser?.email?.trim() ?? "";

    const entry: AuditTimelineEntry = {
      id: event.id,
      action: event.action,
      actionLabel: auditActionLabel(event.action),
      outcome: event.outcome,
      denied: deniedRow,
      dayKey,
      dayLabel: auditDayLabel(dayKey, now),
      absoluteTime: auditAbsoluteTime(event.createdAt),
      relativeTime: auditRelativeTime(event.createdAt, now),
      /**
       * An absent actor is one of two real things: a platform task, or a member
       * whose account has since been deleted (the relation is SetNull). The API
       * stores the same null for both, so the row says neither.
       */
      actor: name || email ? name || email : "Unattributed",
      actorDetail: name && email && name !== email ? email : null,
      targetLabel: auditTargetLabel(event.targetType),
      targetId: event.targetId,
      domainName: event.domain?.name ?? null,
      requestId: event.requestId,
      detailRows: auditDetailRows(event.detail),
    };

    const openDay = byDay.get(dayKey);
    if (openDay) openDay.push(entry);
    else byDay.set(dayKey, [entry]);

    total += 1;
    if (deniedRow) denied += 1;
  }

  // Newest day first. `YYYY-MM-DD` sorts lexicographically, so the date is the
  // order without asking Intl for one. Within a day the API's own order stands.
  const days = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([key, entries]) => ({ key, label: auditDayLabel(key, now), entries }));

  return { days, total, denied };
}
