import { describe, expect, it } from 'vitest';
import {
  containsForensicParts,
  ForensicReportParseError,
  parseForensicReport,
} from '../src/services/forensic-report-parser.service.js';

const boundary = 'ruf-boundary';

function feedbackPart(fields: string | string[], transferEncoding = '7bit'): string {
  const body = Array.isArray(fields) ? fields.join('\r\n') : fields;
  return [
    'Content-Type: application/feedback-report',
    `Content-Transfer-Encoding: ${transferEncoding}`,
    '',
    transferEncoding === 'base64' ? Buffer.from(body).toString('base64') : body,
  ].join('\r\n');
}

function forensicEmail(options: { deliveryStatus?: string; feedback?: string[] } = {}): string {
  const deliveryStatus =
    options.deliveryStatus ??
    [
      'Reporting-MTA: dns; mx.google.com',
      'Source-IP: 192.0.2.10',
      'Arrival-Date: Sat, 06 Apr 2024 12:00:01 +0000',
      '',
      'Final-Recipient: rfc822; alice@example.com',
      'Original-Recipient: rfc822; alice@example.com',
      'Action: fail',
      'Status: 5.7.1',
      'Diagnostic-Code: smtp; 550 5.7.1 Message rejected due to DMARC policy for alice@example.com',
      'Remote-MTA: dns; mx1.spammer.test',
    ].join('\r\n');

  const feedback =
    options.feedback ??
    [
      'Feedback-Type: feedback-report',
      'Version: 1',
      'User-Agent: Google SMTP',
      'Original-Mail-From: <attacker@spammer.test>',
      'Original-Rcpt-To: <alice@example.com>',
      'Arrival-Date: Sat, 06 Apr 2024 12:00:01 +0000',
      'Reporting-MTA: dns; mx.google.com',
      'Source-IP: 192.0.2.10',
      'Reported-Domain: example.com',
      'Authentication-Results: mx.google.com; spf=fail smtp.mailfrom=spammer.test; dkim=fail header.i=@spammer.test header.s=key1 header.d=spammer.test',
    ].join('\r\n');

  return [
    'From: noreply-dmarc-support@google.com',
    'To: dmarc-reports@reports.dmarcharbor.com',
    'Subject: DMARC failure report for example.com',
    'MIME-Version: 1.0',
    `Content-Type: multipart/report; report-type=feedback-report; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'This is a DMARC failure report.',
    `--${boundary}`,
    'Content-Type: message/delivery-status',
    '',
    deliveryStatus,
    `--${boundary}`,
    feedbackPart(feedback),
    `--${boundary}`,
    'Content-Type: text/rfc822-headers',
    '',
    'From: attacker@spammer.test',
    'To: alice@example.com',
    'Subject: Wire transfer details',
    'Date: Sat, 06 Apr 2024 11:59:00 +0000',
    'Message-ID: <abc123@spammer.test>',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

const hexFingerprint = /^[0-9a-f]{64}$/;

describe('forensic report parser', () => {
  it('detects forensic mail and extracts the DMARC failure evidence', () => {
    const raw = forensicEmail();
    expect(containsForensicParts(raw)).toBe(true);

    const report = parseForensicReport(raw);

    expect(report.feedbackType).toBe('feedback-report');
    expect(report.reportedDomain).toBe('example.com');
    expect(report.sourceIp).toBe('192.0.2.10');
    expect(report.disposition).toBe('reject');
    expect(report.deliveryAction).toBe('fail');
    expect(report.deliveryStatus).toBe('5.7.1');
    expect(report.dkimResult).toBe('fail');
    expect(report.spfResult).toBe('fail');
    expect(report.reportingMta).toBe('mx.google.com');
    expect(report.remoteMta).toBe('mx1.spammer.test');
    expect(report.userAgent).toBe('Google SMTP');
    expect(report.recipientCount).toBe(1);
    expect(report.hasOriginalHeaders).toBe(true);
    expect(report.hasOriginalMessageIncluded).toBe(false);
    expect(report.arrivedAt?.toISOString()).toBe('2024-04-06T12:00:01.000Z');
    expect(report.authResults).toEqual([
      { type: 'SPF', result: 'fail', domain: 'spammer.test', scope: 'mfrom' },
      { type: 'DKIM', result: 'fail', domain: 'spammer.test', selector: 'key1' },
    ]);
  });

  it('carries personal data only inside the explicit identifiers block', () => {
    const report = parseForensicReport(forensicEmail());
    const serialized = JSON.stringify(report);
    const withoutIdentifiers = JSON.stringify({ ...report, identifiers: undefined });

    expect(report.recipientPseudonyms[0]).toMatch(hexFingerprint);
    expect(report.subjectPseudonym).toMatch(hexFingerprint);
    expect(report.messageIdPseudonym).toMatch(hexFingerprint);
    expect(report.envelopeFromPseudonym).toMatch(hexFingerprint);
    expect(report.diagnosticCodes[0]).toContain('[redacted:');

    expect(withoutIdentifiers).not.toContain('alice@example.com');
    expect(withoutIdentifiers).not.toContain('attacker@spammer.test');
    expect(withoutIdentifiers).not.toContain('Wire transfer details');
    expect(withoutIdentifiers).not.toContain('abc123@spammer.test');

    expect(report.identifiers.recipientAddresses).toEqual(['alice@example.com']);
    expect(report.identifiers.envelopeFrom).toBe('attacker@spammer.test');
    expect(report.identifiers.subjectLine).toBe('Wire transfer details');
    expect(serialized).toContain('identifiers');
  });

  it('produces a stable fingerprint and stable pseudonyms across deliveries', () => {
    const first = parseForensicReport(forensicEmail());
    const second = parseForensicReport(forensicEmail());

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.recipientPseudonyms).toEqual(second.recipientPseudonyms);
    expect(first.subjectPseudonym).toBe(second.subjectPseudonym);
  });

  it('decodes base64 feedback parts', () => {
    const fields = [
      'Feedback-Type: feedback-report',
      'Source-IP: 198.51.100.7',
      'Reported-Domain: encoded.test',
      'Original-Rcpt-To: <bob@encoded.test>',
    ].join('\r\n');
    const raw = [
      'From: reporter@encoded.test',
      'Subject: failure',
      `Content-Type: multipart/report; report-type=feedback-report; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      feedbackPart(fields, 'base64'),
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const report = parseForensicReport(raw);

    expect(report.reportedDomain).toBe('encoded.test');
    expect(report.sourceIp).toBe('198.51.100.7');
    expect(report.recipientCount).toBe(1);
  });

  it('reads original headers from a full message part without exposing the body', () => {
    const raw = [
      'From: reporter@full.test',
      'Subject: failure',
      `Content-Type: multipart/report; report-type=feedback-report; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      feedbackPart([
        'Feedback-Type: feedback-report',
        'Source-IP: 203.0.113.9',
        'Reported-Domain: full.test',
      ]),
      `--${boundary}`,
      'Content-Type: message/rfc822',
      '',
      'From: attacker@spammer.test',
      'To: carol@full.test',
      'Subject: Confidential payroll change',
      'Message-ID: <full-1@spammer.test>',
      '',
      'Transfer 50000 to account 12345.',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const report = parseForensicReport(raw);
    const withoutIdentifiers = JSON.stringify({ ...report, identifiers: undefined });

    expect(report.hasOriginalMessageIncluded).toBe(true);
    expect(report.subjectPseudonym).toMatch(hexFingerprint);
    expect(withoutIdentifiers).not.toContain('Confidential payroll change');
    expect(withoutIdentifiers).not.toContain('Transfer 50000');
    expect(JSON.stringify(report)).not.toContain('Transfer 50000');
  });

  it('falls back to the authentication results when Reported-Domain is absent', () => {
    const raw = [
      'From: reporter@noreported.test',
      'Subject: failure',
      `Content-Type: multipart/report; report-type=feedback-report; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      feedbackPart('Feedback-Type: feedback-report\nSource-IP: 203.0.113.11\nAuthentication-Results: mx.google.com; spf=softfail smtp.mailfrom=relay.partner.test; dkim=pass header.d=partner.test'),
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const report = parseForensicReport(raw);

    expect(report.reportedDomain).toBe('partner.test');
    expect(report.dkimResult).toBe('pass');
    expect(report.spfResult).toBe('softfail');
  });

  it('rejects mail without a feedback part', () => {
    expect(() =>
      parseForensicReport(['From: a@b.test', 'Subject: hi', 'Content-Type: text/plain', '', 'no report here'].join('\r\n')),
    ).toThrow(ForensicReportParseError);
  });

  it('rejects forensic mail without a source IP', () => {
    const raw = [
      'From: reporter@nosource.test',
      'Subject: failure',
      `Content-Type: multipart/report; report-type=feedback-report; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      feedbackPart('Feedback-Type: feedback-report\nReported-Domain: nosource.test'),
      `--${boundary}--`,
      '',
    ].join('\r\n');

    expect(() => parseForensicReport(raw)).toThrow(ForensicReportParseError);
  });
});
