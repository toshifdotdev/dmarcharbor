/**
 * portal-verdict.ts — one plain-language verdict per domain, for the agency's
 * client.
 *
 * The reader is a business owner or office manager, not an operator. They want
 * three answers: is my mail protected, is anything wrong, what do I have to do.
 * So each domain gets exactly one verdict, a sentence that says what it means,
 * and a next step, in words that need no knowledge of DMARC.
 *
 * Only what the portal API returns is used: the domain's published policy (from
 * the DNS check), the aggregate counts, the report window, and the possible
 * impersonation sources. Sender attribution is shown beside the verdict, never
 * folded into it: the verdict is about whether messages passed, not about
 * which service sent them.
 *
 * Order of precedence, first match wins:
 *   waiting     no measurement yet
 *   silent      reports stopped more than STALE_AFTER_DAYS ago
 *   attention   something failed, or a possible impersonator was seen
 *   protected   everything passed and the domain asks for rejection/quarantine
 *   watching    everything passed, the domain only monitors (p=none)
 *   passing     everything passed, the domain's setting has not been checked
 */

import { STALE_AFTER_DAYS, daysSinceReport } from "./posture";
import type { PortalDomainDetail } from "./types";

export type VerdictKind = "attention" | "silent" | "waiting" | "watching" | "passing" | "protected" | "unknown";

export interface Verdict {
  kind: VerdictKind;
  /** The verdict as a short headline. */
  title: string;
  /** What it means, in one or two sentences. */
  meaning: string;
  /** What the reader should do, or "Nothing to do." */
  next: string;
  tone: "fail" | "warn" | "ok" | "neutral";
  /** Lower sorts first: what needs a person comes first. */
  rank: number;
}

export function policyKind(policy: string | null | undefined): "reject" | "quarantine" | "none" | null {
  const p = (policy ?? "").toLowerCase();
  return p === "reject" || p === "quarantine" || p === "none" ? p : null;
}

export function policyPlain(policy: string | null | undefined): { name: string; meaning: string } {
  switch (policyKind(policy)) {
    case "reject":
      return { name: "Block", meaning: "Mail servers are asked to refuse any message that fails the checks." };
    case "quarantine":
      return { name: "Send to spam", meaning: "Mail servers are asked to put any message that fails the checks in the spam folder." };
    case "none":
      return {
        name: "Monitor only",
        meaning: "Mail servers deliver messages as normal and report back. Nothing is blocked yet, fakes included.",
      };
    default:
      return { name: "Not checked yet", meaning: "The domain's setting has not been read yet." };
  }
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export function verdictFor(detail: PortalDomainDetail | null, agency: string, now: number): Verdict {
  if (!detail) {
    return {
      kind: "unknown",
      title: "Could not be read just now",
      meaning: "This domain's report did not load. That is a problem reaching the report, not a problem with your mail.",
      next: "Try again in a few minutes.",
      tone: "neutral",
      rank: 5,
    };
  }
  const name = detail.domain.name;
  const agg = detail.aggregate;
  const spoof = detail.possibleSpoofingSources.length;

  if (!agg || agg.messageCount === 0) {
    return {
      kind: "waiting",
      title: "No reports yet",
      meaning:
        "Mail servers send a report about your domain about once a day. None has arrived yet, so there is nothing to judge. This is normal in the first few days.",
      next: `Nothing to do. If this has not changed after a week, ask ${agency}.`,
      tone: "neutral",
      rank: 4,
    };
  }

  const age = daysSinceReport(agg.lastReportAt, now);
  if (age !== null && age > STALE_AFTER_DAYS) {
    return {
      kind: "silent",
      title: "Reports have stopped",
      meaning: `The last report about ${name} arrived ${age} days ago. Until reports arrive again, nobody can tell whether your mail is protected. The figures below are from before they stopped.`,
      next: `Ask ${agency} to check. A change to your domain's settings can stop the reports.`,
      tone: "warn",
      rank: 1,
    };
  }

  const policy = policyKind(detail.domain.dmarcPolicy);
  if (agg.failedMessages > 0 || spoof > 0) {
    const consequence =
      policy === "reject"
        ? "Your domain asks mail servers to refuse messages that fail, so any genuine ones among them did not arrive. This is the usual reason for bounced email."
        : policy === "quarantine"
          ? "Your domain asks mail servers to send failing messages to spam, so genuine ones may have landed in junk folders."
          : policy === "none"
            ? "Your domain does not yet ask mail servers to block failing messages, so they may have been delivered, fakes included."
            : "";
    return {
      kind: "attention",
      title: spoof > 0 ? "Someone may be sending email as you" : "Some email sent as you is failing the checks",
      meaning: `${agg.failedMessages.toLocaleString("en-GB")} of ${agg.messageCount.toLocaleString("en-GB")} messages sent as ${name} (${pct(agg.failedMessages, agg.messageCount)}%) did not prove they really came from you. ${consequence}`.trim(),
      next: `Forward this report to ${agency}. If you send email through a service that is not listed under “Who is sending as you”, such as a newsletter tool, invoicing system or CRM, tell them its name: that is a common cause.`,
      tone: "fail",
      rank: 0,
    };
  }

  if (policy === "reject" || policy === "quarantine") {
    return {
      kind: "protected",
      title: "Protected",
      meaning: `Every message sent as ${name} that mail servers reported passed the checks, and your domain asks them to ${policy === "reject" ? "refuse" : "send to spam"} any message that fails.`,
      next: "Nothing to do.",
      tone: "ok",
      rank: 3,
    };
  }
  if (policy === "none") {
    return {
      kind: "watching",
      title: "Passing, not yet blocking fakes",
      meaning: `Every message sent as ${name} that mail servers reported passed the checks. Your domain is in monitor-only mode: it does not yet ask them to block messages that fail.`,
      next: `Nothing to do now. Once your genuine email passes consistently, the domain can be set to block fakes, and ${agency} makes that change.`,
      tone: "warn",
      rank: 2,
    };
  }
  return {
    kind: "passing",
    title: "Passing the checks",
    meaning: `Every message sent as ${name} that mail servers reported passed the checks. Whether your domain blocks fakes has not been checked yet.`,
    next: "Nothing to do.",
    tone: "ok",
    rank: 3,
  };
}

/** A sender's name as a person would recognise it. */
export function senderName(s: {
  senderDomain: string | null;
  senderKey: string;
  service?: { name: string } | null;
  serviceName?: string | null;
  confidence?: string;
}): { name: string; known: boolean } {
  if (s.service && (s.confidence === "confirmed" || s.confidence === "likely")) {
    return { name: s.service.name, known: true };
  }
  if (s.serviceName) {
    return { name: s.serviceName, known: true };
  }
  if (s.senderDomain) return { name: s.senderDomain, known: true };
  const ip = s.senderKey.split("|")[0];
  return { name: `An unidentified server (${ip})`, known: false };
}

export function senderPlain(s: PortalDomainDetail["senders"][number]): { line: string; tone: "fail" | "warn" | "ok" | "neutral" } {
  const n = (v: number) => v.toLocaleString("en-GB");
  switch (s.status) {
    case "clean":
      return { line: `All ${n(s.totalMessages)} messages passed DMARC.`, tone: "ok" };
    case "degraded":
      return { line: `${n(s.dmarcFailedMessages)} of ${n(s.totalMessages)} messages failed DMARC; the rest passed.`, tone: "warn" };
    case "failing":
      return { line: `${n(s.dmarcFailedMessages)} of ${n(s.totalMessages)} messages failed DMARC.`, tone: "fail" };
    default:
      return { line: `${n(s.totalMessages)} message${s.totalMessages === 1 ? "" : "s"}: too few to judge yet.`, tone: "neutral" };
  }
}

export function dayLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** A plain-text summary to forward by email or chat. */
export function summaryText(detail: PortalDomainDetail, verdict: Verdict, agency: string): string {
  const agg = detail.aggregate;
  const lines = [
    `Email protection report: ${detail.domain.name}`,
    `Prepared by ${agency}${detail.domain.client.name ? ` for ${detail.domain.client.name}` : ""}.`,
    "",
    `Verdict: ${verdict.title}`,
    verdict.meaning,
    "",
    `What to do: ${verdict.next}`,
  ];
  if (agg && agg.messageCount > 0) {
    const from = dayLabel(agg.messageWindow.begin);
    const to = dayLabel(agg.messageWindow.end);
    lines.push(
      "",
      `Messages reported${from && to ? ` between ${from} and ${to}` : ""}: ${agg.messageCount.toLocaleString("en-GB")}`,
      `Failed the checks: ${agg.failedMessages.toLocaleString("en-GB")}`,
      `Last report received: ${dayLabel(agg.lastReportAt) ?? "not recorded"}`,
    );
  }
  lines.push(`Domain setting: ${policyPlain(detail.domain.dmarcPolicy).name}`);
  const failing = detail.senders.filter((s) => s.dmarcFailedMessages > 0).slice(0, 5);
  if (failing.length) {
    lines.push("", "Sending sources with failures:");
    for (const s of failing) lines.push(`- ${senderName(s).name}: ${s.dmarcFailedMessages} of ${s.totalMessages} failed DMARC`);
  }
  return lines.join("\n");
}
