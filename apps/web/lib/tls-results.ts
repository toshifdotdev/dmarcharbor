/**
 * Plain-English TLS-RPT failure reasons, in one place so the summary and the
 * expanded report cannot describe the same result type differently. Registry
 * values this build does not know are shown as written.
 */
const EXPLANATIONS: Record<string, string> = {
  'starttls-not-supported': 'The receiving server did not offer encryption (STARTTLS).',
  'certificate-host-mismatch': "The server's certificate does not name this mail server.",
  'certificate-expired': "The server's certificate has expired.",
  'certificate-not-trusted': 'The certificate is not issued by an authority the sender trusts.',
  'validation-failure': 'The certificate or connection failed validation for another reason.',
  'tlsa-invalid': 'The published DANE (TLSA) record is not valid.',
  'dnssec-invalid': 'DNSSEC validation failed for this domain.',
  'dane-required': 'The sender required DANE and it was not available.',
  'sts-policy-fetch-error': 'The MTA-STS policy file could not be fetched.',
  'sts-policy-invalid': 'The MTA-STS policy file is not valid.',
  'sts-webpki-invalid': "The MTA-STS policy host's certificate is not valid.",
};

export function tlsResultExplanation(resultType: string): string {
  return EXPLANATIONS[resultType] ?? 'Not a standard result type.';
}

export function isKnownTlsResult(resultType: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXPLANATIONS, resultType);
}
