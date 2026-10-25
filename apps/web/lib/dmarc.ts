/**
 * dmarc.ts — the one rule every screen uses to decide whether a message failed.
 *
 * dkimResult and spfResult are the policy_evaluated verdicts: already aligned.
 * DMARC passes when either one passed (RFC 9989 section 4.4), so a sender that
 * passes aligned DKIM and fails aligned SPF is not a failure. p=reject would
 * deliver that mail.
 */

export function isPassResult(value: string | null | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "pass";
}

export function passesDmarc(record: { dkimResult: string | null; spfResult: string | null }): boolean {
  return isPassResult(record.dkimResult) || isPassResult(record.spfResult);
}

/** Messages in these records that failed DMARC: both aligned checks failed. */
export function dmarcFailedMessages(
  records: Array<{ messageCount: number; dkimResult: string | null; spfResult: string | null }>,
): number {
  return records.reduce((total, record) => (passesDmarc(record) ? total : total + record.messageCount), 0);
}
