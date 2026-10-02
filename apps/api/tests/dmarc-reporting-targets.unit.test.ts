import { describe, it, expect } from 'vitest';
import {
  canCollectAggregateReports,
  extractAggregateTargets,
  hasAggregateReporting,
  readDmarcRecord,
} from '../src/scanner/dmarc-tags.js';
import { scanDomain } from '../src/scanner/scanner.js';
import type { DnsReader } from '../src/scanner/types.js';

/**
 * These cases exist because the parser used to keep only mailto targets, which
 * made a domain publishing rua=https:// look identical to a domain with no rua
 * at all. The consequence was not cosmetic: the scanner recommended adding a
 * rua=mailto: address to a record that was already correct.
 */

describe('DMARC reporting targets', () => {
  it('reads a web-published rua as configured reporting', () => {
    const record =
      'v=DMARC1; p=reject; rua=https://reports.example.com/v1/domain-report/abc123; adkim=s; aspf=s';

    const tags = readDmarcRecord(record);

    expect(tags.aggregateWebTargets).toEqual([
      'https://reports.example.com/v1/domain-report/abc123',
    ]);
    // Reporting is genuinely on. This is the assertion the old parser failed.
    expect(hasAggregateReporting(tags)).toBe(true);
  });

  it('distinguishes configured reporting from reporting we can collect', () => {
    const webOnly = readDmarcRecord('v=DMARC1; p=none; rua=https://r.example.com/x');

    // We cannot read it. Reporting that it is missing would send the customer to
    // change DNS that works.
    expect(canCollectAggregateReports(webOnly)).toBe(false);
    expect(hasAggregateReporting(webOnly)).toBe(true);
  });

  it('counts either transport as configured', () => {
    const both = readDmarcRecord(
      'v=DMARC1; p=none; rua=mailto:agg@example.com, https://r.example.com/x',
    );

    expect(hasAggregateReporting(both)).toBe(true);
    expect(canCollectAggregateReports(both)).toBe(true);
    expect(both.aggregateMailtoTargets).toEqual(['agg@example.com']);
    expect(both.aggregateWebTargets).toEqual(['https://r.example.com/x']);
  });

  it('still reports a genuinely absent rua as unconfigured', () => {
    const tags = readDmarcRecord('v=DMARC1; p=reject');

    expect(hasAggregateReporting(tags)).toBe(false);
    expect(canCollectAggregateReports(tags)).toBe(false);
    expect(tags.aggregateMailtoTargets).toEqual([]);
    expect(tags.aggregateWebTargets).toEqual([]);
  });

  it('does not treat an http rua as a web target we would fetch', () => {
    // These arrive from DNS, so fetching them over http would mean trusting XML
    // anyone on the path can rewrite.
    expect(extractAggregateTargets('http://r.example.com/x').web).toEqual([]);
    expect(extractAggregateTargets('https://r.example.com/x').web).toHaveLength(1);
  });

  it('ignores a rua value that is neither mailto nor https', () => {
    const tags = readDmarcRecord('v=DMARC1; p=none; rua=ftp://r.example.com/x');

    expect(hasAggregateReporting(tags)).toBe(false);
  });

  it('drops the mailto query string but keeps the rua path intact', () => {
    const both = extractAggregateTargets(
      'mailto:agg@example.com?to=agg, https://r.example.com/v1/abc?x=1',
    );

    expect(both.mailto).toEqual(['agg@example.com']);
    expect(both.web).toEqual(['https://r.example.com/v1/abc?x=1']);
  });
});

describe('scanner advice for web-published reports', () => {
  const readerFor = (dmarcRecord: string): DnsReader => ({
    async resolveTxt(name: string) {
      if (name.startsWith('_dmarc.')) {
        return { status: 'found', value: [[dmarcRecord]] };
      }
      return { status: 'missing' };
    },
    async resolveMx() {
      return { status: 'found', value: [] };
    },
  });

  const scan = (dmarcRecord: string) =>
    scanDomain('example.com', readerFor(dmarcRecord));

  it('does not tell a correctly configured domain to add a rua address', async () => {
    const result = await scan('v=DMARC1; p=reject; rua=https://reports.example.com/v1/abc');
    const codes = result.issues.map((issue) => issue.code);

    expect(result.dmarc.hasAggregateReports).toBe(true);
    expect(codes).not.toContain('dmarc_no_aggregate_reports');
    expect(codes).toContain('dmarc_aggregate_reports_not_collected');
  });

  it('says the reports are going somewhere we cannot read', async () => {
    const result = await scan('v=DMARC1; p=reject; rua=https://reports.example.com/v1/abc');
    const issue = result.issues.find((entry) => entry.code === 'dmarc_aggregate_reports_not_collected');

    expect(issue?.title).toContain('cannot read');
    // Telling the customer to add a mailto: address after we just told them
    // their record is fine is advice that contradicts itself.
    expect(issue?.recommendation).not.toMatch(/add a rua=/i);
    expect(issue?.recommendation).toMatch(/leave the rua record as it is/i);
  });

  it('still advises adding rua when there is genuinely no rua', async () => {
    const result = await scan('v=DMARC1; p=reject');
    const issue = result.issues.find((entry) => entry.code === 'dmarc_no_aggregate_reports');

    expect(result.dmarc.hasAggregateReports).toBe(false);
    expect(issue?.recommendation).toMatch(/add a rua=/i);
  });

  it('stays quiet when reports arrive by mail as they always did', async () => {
    const result = await scan('v=DMARC1; p=reject; rua=mailto:agg@reports.dmarcharbor.com');
    const codes = result.issues.map((issue) => issue.code);

    expect(result.dmarc.hasAggregateReports).toBe(true);
    expect(codes).not.toContain('dmarc_aggregate_reports_not_collected');
    expect(codes).not.toContain('dmarc_no_aggregate_reports');
  });
});