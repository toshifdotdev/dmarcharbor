/**
 * sender-domain.ts — whether a sender authenticated as the domain itself.
 *
 * Pure, so the server (deriveSignals) and the browser (domain-routes, drawn
 * beside the senders table) answer the same way. A name under the domain is
 * the domain's own: Resend signing as mail.example.com aligns with
 * example.com, and the API stores that aligned name as the sender's domain.
 * Session 4 found it read as "signs as another domain" and as 100% of mail
 * unattributed.
 */
export function signsAsDomain(senderDomain: string | null | undefined, domainName: string): boolean {
  const signed = (senderDomain ?? "").trim().toLowerCase().replace(/\.+$/, "");
  const domain = domainName.trim().toLowerCase().replace(/\.+$/, "");
  return signed !== "" && (signed === domain || signed.endsWith(`.${domain}`));
}
