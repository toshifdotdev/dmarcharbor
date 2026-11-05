import type { DeletionSummary } from "./ops-client";

/**
 * What a deletion takes with it, as words: "1 domain, 412 reports, 2 share
 * links". Shared by the delete dialogs (before) and the notice after, so the
 * two say the same thing.
 */
const SUMMARY_WORDS: Array<[keyof DeletionSummary, string, string]> = [
  ["domains", "domain", "domains"],
  ["dmarcReports", "report", "reports"],
  ["forensicReports", "forensic report", "forensic reports"],
  ["alertRules", "alert rule", "alert rules"],
  ["alertEvents", "alert event", "alert events"],
  ["reportDigests", "digest", "digests"],
  ["scans", "scan", "scans"],
  ["reportShares", "share link", "share links"],
  ["compliancePacks", "compliance pack", "compliance packs"],
];

export function summariseDeletion(s: DeletionSummary, options: { skipDomains?: boolean } = {}): string {
  const parts = SUMMARY_WORDS.filter(([k]) => (options.skipDomains ? k !== "domains" : true) && (s[k] ?? 0) > 0).map(
    ([k, one, many]) => `${s[k].toLocaleString("en-GB")} ${s[k] === 1 ? one : many}`,
  );
  return parts.length ? parts.join(", ") : "nothing else was attached";
}
