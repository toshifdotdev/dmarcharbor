/**
 * A cheap "is this a TLS-RPT email?" test, run before a full MIME parse.
 *
 * It looks for the markers RFC 8460 section 5.3 and its MIME registrations
 * define, in the raw message text. A false negative sends the message down the
 * aggregate path, where it is ignored; this test exists to make the common
 * shapes reliable without paying for simpleParser on every inbound message.
 */
export function looksLikeTlsReportEmail(rawEmail: string): boolean {
  const lower = rawEmail.toLowerCase();
  if (lower.includes('application/tlsrpt+gzip') || lower.includes('application/tlsrpt+json')) {
    return true;
  }
  if (/^tls-report-domain\s*:/im.test(rawEmail)) {
    return true;
  }
  return /report-type\s*=\s*"?tlsrpt"?/i.test(rawEmail);
}
