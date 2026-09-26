import { describe, expect, it } from 'vitest';
import { DmarcReportParseError, parseDmarcReport } from '../src/services/report-parser.service.js';

const aggregateReport = `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>Google LLC</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <extra_contact_info>https://support.google.com</extra_contact_info>
    <report_id>google-report-123</report_id>
    <date_range>
      <begin>1712188800</begin>
      <end>1712275199</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>example.com</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>none</p>
    <sp>none</sp>
    <fraction>100</fraction>
  </policy_published>
  <record>
    <row>
      <source_ip>192.0.2.10</source_ip>
      <count>1250</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>example.com</header_from>
      <envelope_from>example.com</envelope_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>example.com</domain>
        <selector>google</selector>
        <result>pass</result>
      </dkim>
      <spf>
        <domain>example.com</domain>
        <scope>mfrom</scope>
        <result>pass</result>
      </spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>198.51.100.20</source_ip>
      <count>3</count>
      <policy_evaluated>
        <disposition>quarantine</disposition>
        <dkim>fail</dkim>
        <spf>fail</spf>
        <reason>
          <type>forwarded</type>
          <comment>Untrusted forwarder</comment>
        </reason>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>example.com</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>example.com</domain>
        <selector>legacy</selector>
        <result>fail</result>
      </dkim>
    </auth_results>
  </record>
</feedback>`;

describe('DMARC report parser', () => {
  it('parses aggregate report metadata, policy, records, and auth results', () => {
    const report = parseDmarcReport(aggregateReport);

    expect(report.reportType).toBe('AGGREGATE');
    expect(report.reportId).toBe('google-report-123');
    expect(report.reportingOrganization).toBe('Google LLC');
    expect(report.policyDomain).toBe('example.com');
    expect(report.policyP).toBe('none');
    expect(report.policyFraction).toBe(100);
    expect(report.dateRangeBegin?.toISOString()).toBe('2024-04-04T00:00:00.000Z');
    expect(report.records).toHaveLength(2);
    expect(report.records[0]).toMatchObject({
      sourceIp: '192.0.2.10',
      messageCount: 1250,
      dkimResult: 'pass',
      spfResult: 'pass',
      headerFrom: 'example.com',
    });
    expect(report.records[0].authResults).toEqual([
      { type: 'DKIM', domain: 'example.com', selector: 'google', result: 'pass' },
      { type: 'SPF', domain: 'example.com', scope: 'mfrom', result: 'pass' },
    ]);
    expect(report.records[1].policyReason).toBe('forwarded: Untrusted forwarder');
  });

  it('rejects reports that are not aggregate XML', () => {
    expect(() => parseDmarcReport('<feedback><record></record></feedback>')).toThrow(DmarcReportParseError);
  });

  it('rejects malformed XML', () => {
    expect(() => parseDmarcReport('<feedback>')).toThrow(DmarcReportParseError);
  });
});
