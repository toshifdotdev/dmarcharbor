import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { looksLikeTlsReportEmail } from '../src/services/tls-report/detect.js';
import { parseTlsReport, TlsReportParseError } from '../src/services/tls-report/parse.js';
import { tlsReportJsonFromAttachment } from '../src/services/tls-report/attachment.js';

const appendixB = {
  'organization-name': 'Example.com',
  'date-range': {
    'start-datetime': '2016-04-01T00:00:00Z',
    'end-datetime': '2016-04-01T23:59:59Z',
  },
  'contact-info': 'smtp-tls-reporting@example.com',
  'report-id': '2016-04-01T00:00:00Z_example.com',
  policies: [
    {
      policy: {
        'policy-type': 'sts',
        'policy-string': ['version: STSv1', 'mode: enforce', 'mx: mx.example.com', 'max_age: 604800'],
        'policy-domain': 'example.com',
        'mx-host': 'mx.example.com',
      },
      summary: { 'total-successful-session-count': 100, 'total-failure-session-count': 5 },
      'failure-details': [
        {
          'result-type': 'certificate-expired',
          'sending-mta-ip': '192.0.2.1',
          'receiving-mx-hostname': 'mx.example.com',
          'receiving-mx-helo': 'mx.example.com',
          'receiving-ip': '192.0.2.2',
          'failed-session-count': 5,
          'additional-information': 'certificate expired',
          'failure-reason-code': 'expired',
        },
      ],
    },
  ],
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe('parseTlsReport, reporter variations', () => {
  it('accepts mx-host as a list of patterns instead of refusing the report', () => {
    const variant = structuredClone(appendixB) as unknown as {
      policies: Array<{ policy: Record<string, unknown> }>;
    };
    variant.policies[0]!.policy['mx-host'] = ['mx1.example.com', '*.backup.example.com'];
    const report = parseTlsReport(json(variant));
    expect(report.policies[0]!.mxHost).toBe('mx1.example.com, *.backup.example.com');
  });
});

describe('parseTlsReport', () => {
  it('parses the RFC 8460 Appendix B example and totals its sessions', () => {
    const report = parseTlsReport(json(appendixB));
    expect(report.organizationName).toBe('Example.com');
    expect(report.policyDomain).toBe('example.com');
    expect(report.successfulSessions).toBe(100);
    expect(report.failedSessions).toBe(5);
    expect(report.policies).toHaveLength(1);
    expect(report.policies[0]!.policyString).toContain('version: STSv1\nmode: enforce');
    expect(report.policies[0]!.failures[0]).toMatchObject({
      resultType: 'certificate-expired',
      failedSessions: 5,
    });
    expect(report.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(report.reportIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(report.truncated).toBe(false);
  });

  it('keeps an unknown result type as written', () => {
    const value = structuredClone(appendixB);
    (value.policies[0] as Record<string, unknown>)['failure-details'] = [
      {
        'result-type': 'some-new-registry-value',
        'failed-session-count': 1,
      },
    ];
    const report = parseTlsReport(json(value));
    expect(report.policies[0]!.failures[0]!.resultType).toBe('some-new-registry-value');
  });

  it('caps failure details at 1,000 and marks the report truncated', () => {
    const value = structuredClone(appendixB);
    (value.policies[0] as Record<string, unknown>)['failure-details'] = Array.from(
      { length: 1_001 },
      () => ({ 'result-type': 'validation-failure', 'failed-session-count': 1 }),
    );
    const report = parseTlsReport(json(value));
    expect(report.policies[0]!.failures).toHaveLength(1_000);
    expect(report.truncated).toBe(true);
  });

  it('rejects missing required fields, bad counts and a reversed range', () => {
    const missing = structuredClone(appendixB) as Record<string, unknown>;
    delete missing['organization-name'];
    expect(() => parseTlsReport(json(missing))).toThrow(TlsReportParseError);
    expect(() => parseTlsReport(json(missing))).toThrow(/missing organization-name/);

    const negative = structuredClone(appendixB);
    negative.policies[0]!.summary['total-failure-session-count'] = -1;
    expect(() => parseTlsReport(json(negative))).toThrow(/non-negative integer/);

    const huge = structuredClone(appendixB);
    huge.policies[0]!.summary['total-successful-session-count'] = 1_000_000_000_001;
    expect(() => parseTlsReport(json(huge))).toThrow(/10\^12/);

    const reversed = structuredClone(appendixB);
    reversed['date-range'] = {
      'start-datetime': '2016-04-02T00:00:00Z',
      'end-datetime': '2016-04-01T00:00:00Z',
    };
    expect(() => parseTlsReport(json(reversed))).toThrow(/ends before it starts/);
  });

  it('rejects a report that covers more than one domain', () => {
    const value = structuredClone(appendixB);
    value.policies.push({
      ...structuredClone(appendixB.policies[0]!),
      policy: { ...appendixB.policies[0]!.policy, 'policy-domain': 'other.example' },
    });
    expect(() => parseTlsReport(json(value))).toThrow('The report covers more than one domain.');
  });
});

describe('tlsReportJsonFromAttachment', () => {
  it('decodes gzip and plain JSON', async () => {
    const text = json(appendixB);
    expect(await tlsReportJsonFromAttachment(Buffer.from(text, 'utf8'))).toContain('"report-id"');
    const gz = gzipSync(Buffer.from(text, 'utf8'));
    expect(await tlsReportJsonFromAttachment(gz)).toContain('"report-id"');
    expect(await tlsReportJsonFromAttachment(Buffer.from(`\uFEFF \n${text}`, 'utf8'))).toContain('"report-id"');
  });

  it('refuses a decompressed report over 5 MB', async () => {
    await expect(
      tlsReportJsonFromAttachment(gzipSync(Buffer.alloc(5 * 1024 * 1024 + 16, 0x20))),
    ).rejects.toThrow(/more than 5 MB/);
    await expect(tlsReportJsonFromAttachment(Buffer.alloc(5 * 1024 * 1024 + 1, 0x20))).rejects.toThrow(
      /more than 5 MB/,
    );
  });

  it('refuses anything that is not a TLS report', async () => {
    await expect(tlsReportJsonFromAttachment(Buffer.from('<xml />'))).rejects.toThrow(
      'The attachment is not a TLS report.',
    );
  });
});

describe('looksLikeTlsReportEmail', () => {
  it('matches each TLS-RPT marker', () => {
    expect(looksLikeTlsReportEmail('Content-Type: application/tlsrpt+gzip')).toBe(true);
    expect(looksLikeTlsReportEmail('Content-Type: application/tlsrpt+json')).toBe(true);
    expect(looksLikeTlsReportEmail('TLS-Report-Domain: example.com\r\n')).toBe(true);
    expect(looksLikeTlsReportEmail('Content-Type: multipart/report; report-type=tlsrpt')).toBe(true);
    expect(looksLikeTlsReportEmail('Content-Type: multipart/report; report-type="tlsrpt"')).toBe(true);
  });

  it('does not match aggregate or forensic mail', () => {
    expect(
      looksLikeTlsReportEmail(
        'Content-Type: multipart/report; report-type=feedback-report\r\nSubject: Report Domain: example.com\r\n',
      ),
    ).toBe(false);
    expect(
      looksLikeTlsReportEmail(
        'Content-Type: application/gzip; name="report.xml.gz"\r\nSubject: Report Domain: example.com\r\n',
      ),
    ).toBe(false);
    expect(looksLikeTlsReportEmail('Content-Type: message/feedback-report')).toBe(false);
  });
});
