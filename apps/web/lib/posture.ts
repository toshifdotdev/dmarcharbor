/**
 * posture.ts — the five postures, and Rule Zero as executable code.
 *
 * An unmeasured state NEVER renders as a pass. A domain that has sent no
 * reports has proved nothing. Precedence:
 *
 *   never measured → stale → blocking → unverified → aligned
 *
 * Never-measured outranks blocking: a domain that stopped reporting cannot be
 * called blocking, and a domain that never reported cannot be called anything
 * but unknown. First ask what we can SEE at all (absence is the loudest lie if
 * hidden), then whether the window has aged out, then observed harm, then
 * attribution gaps, and only then may the word "aligned" appear.
 *
 * STALE and NOT MEASURED are different facts and must never read as one:
 *   stale        = we HAVE a measurement window and it has aged past the
 *                  threshold (measured, then quiet);
 *   not measured = no measurement exists (never measured).
 * Both stay out of the aligned count and out of any pass rate.
 */

import type { DomainSignals } from "./types";

export type Posture = "pass" | "block" | "unverified" | "stale" | "unmeasured";

export const POSTURE_META: Record<
  Posture,
  { label: string; action: string; meaning: string }
> = {
  pass: {
    label: "Aligned",
    action: "Maintain",
    meaning: "All attributed senders authenticated within the window.",
  },
  block: {
    label: "Blocking",
    action: "Investigate",
    meaning:
      "Observed traffic failed alignment while a rejecting policy is live — mail is being denied.",
  },
  unverified: {
    label: "Unverified",
    action: "Attribute",
    meaning:
      "Traffic is seen but senders are not attributed. Not a pass — an open question.",
  },
  stale: {
    label: "Stale",
    action: "Recheck",
    meaning:
      "Measured once, then the feed went quiet. The window has aged out — past measurements are shown, not current health.",
  },
  unmeasured: {
    label: "Not measured",
    action: "Watch",
    meaning:
      "No measurement exists. Absence of data is not compliance.",
  },
};

export const UNKNOWN_SHARE_FLOOR = 0.25;
export const STALE_AFTER_DAYS = 5;

export type ResolvedPosture = { posture: Posture; reason: string };

export function fmtVolume(n: number): string {
  return n.toLocaleString("en-US");
}

export function resolvePosture(s: DomainSignals): ResolvedPosture {
  const ageDays =
    s.lastReportAt === null
      ? Infinity
      : (Date.now() - new Date(s.lastReportAt).getTime()) / 86_400_000;

  // 1. Never measured outranks everything: nothing was ever observed.
  if (s.messageCount === 0) {
    return s.reportCount === 0
      ? { posture: "unmeasured", reason: "never measured — no aggregate reports received" }
      : { posture: "unmeasured", reason: "never measured — reports received, but no messages in them" };
  }

  // 2. Stale outranks blocking: a feed that went quiet cannot be read as
  //    current failure, and its past measurements must not masquerade as
  //    present state.
  if (ageDays > STALE_AFTER_DAYS) {
    return {
      posture: "stale",
      reason: `measured, then quiet — ${fmtVolume(s.messageCount)} messages, last report ${Math.floor(ageDays)} days ago`,
    };
  }

  // 3-5. Only a live window can speak to harm, then attribution, then health.
  if (s.failedMessages > 0) {
    return {
      posture: "block",
      reason: `${fmtVolume(s.failedMessages)} messages failed alignment`,
    };
  }
  const unattributedShare = s.unattributedMessages / s.messageCount;
  if (s.unattributedMessages > 0 && unattributedShare >= UNKNOWN_SHARE_FLOOR) {
    return {
      posture: "unverified",
      reason: `${Math.round(unattributedShare * 100)}% of volume from senders not attributed to this domain`,
    };
  }
  return { posture: "pass", reason: `${fmtVolume(s.messageCount)} messages aligned` };
}

/** Action-priority order: what needs a person today sorts to the top. */
export const POSTURE_ORDER: Record<Posture, number> = {
  block: 0,
  unverified: 1,
  stale: 2,
  unmeasured: 3,
  pass: 4,
};

/** Rows whose signals failed to load sort below every resolved posture. */
export const UNRESOLVED_ORDER = Number.MAX_SAFE_INTEGER;

/** The policy a domain actually publishes, from DNS scan or report evidence. */
export function policyLabel(dnsPolicy: string | null, reportedPolicy: string | null): string {
  return dnsPolicy ?? reportedPolicy ?? "not observed";
}
