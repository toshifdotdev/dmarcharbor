import { describe, expect, it } from 'vitest';
import {
  buildCutoverRecord,
  buildDualRecord,
  readRuaUris,
  splitDmarcRecord,
} from '../src/services/switch-kit/record-rewrite.js';

const OUR = 'dmarc-reports+abcdef012345@reports.dmarcharbor.com';

function codes(warnings: Array<{ code: string }>): string[] {
  return warnings.map((warning) => warning.code);
}

describe('splitting a record', () => {
  it('keeps every tag exactly as written and every empty segment', () => {
    const segments = splitDmarcRecord('v=DMARC1 ; p=none;  rua =  mailto:a@b.test ;');

    expect(segments.map((segment) => segment.raw)).toEqual([
      'v=DMARC1 ',
      ' p=none',
      '  rua =  mailto:a@b.test ',
      '',
    ]);
    expect(segments.map((segment) => segment.key)).toEqual(['v', 'p', 'rua', '']);
  });

  it('keeps each rua URI raw, including a size suffix', () => {
    expect(readRuaUris('mailto:A@B.test!10m, mailto:c@d.test')).toEqual([
      'mailto:A@B.test!10m',
      ' mailto:c@d.test',
    ]);
  });
});

describe('building the dual record', () => {
  it('puts ours first and preserves every other tag exactly', () => {
    const record =
      'v=DMARC1; p=none; rua=mailto:agg@dmarcian.com; ruf=mailto:fr@dmarcian.com; adkim=r; pct=25';
    const dual = buildDualRecord(record, OUR);

    expect(dual.value).toBe(
      `v=DMARC1; p=none; rua=mailto:${OUR},mailto:agg@dmarcian.com; ruf=mailto:fr@dmarcian.com; adkim=r; pct=25`,
    );
    expect(dual.value).toContain('; ruf=mailto:fr@dmarcian.com; adkim=r; pct=25');
    expect(codes(dual.warnings)).toEqual(['pct_present', 'no_policy_change']);
  });

  it('replaces our shared address and keeps ours exactly once', () => {
    const record =
      'v=DMARC1; p=none; rua=mailto:dmarc-reports@reports.dmarcharbor.com,mailto:dmarc-reports+abcdef012345@reports.dmarcharbor.com,mailto:agg@dmarcian.com';
    const dual = buildDualRecord(record, OUR);

    expect(dual.value.match(/mailto:dmarc-reports\+abcdef012345@reports\.dmarcharbor\.com/g)).toHaveLength(1);
    expect(dual.value).not.toContain('mailto:dmarc-reports@reports.dmarcharbor.com');
    expect(dual.value).toContain(`rua=mailto:${OUR},mailto:agg@dmarcian.com`);
  });

  it('warns about addresses beyond the second and names them', () => {
    const record =
      'v=DMARC1; p=none; rua=mailto:a@dmarcian.com,mailto:b@easydmarc.us,mailto:c@powerdmarc.com';
    const dual = buildDualRecord(record, OUR);
    const warning = dual.warnings.find((entry) => entry.code === 'third_address');

    expect(warning).toBeDefined();
    expect(warning!.message).toContain('mailto:b@easydmarc.us');
    expect(warning!.message).toContain('mailto:c@powerdmarc.com');
    expect(warning!.message).toMatch(/may not reach|not reach/i);
  });

  it('keeps t=y and pct unchanged and says pct was retired', () => {
    const record = 'v=DMARC1; p=quarantine; rua=mailto:agg@dmarcian.com; t=y; pct=0';
    const dual = buildDualRecord(record, OUR);
    const warning = dual.warnings.find((entry) => entry.code === 'pct_present');

    expect(dual.value).toContain('t=y');
    expect(dual.value).toContain('pct=0');
    expect(warning!.message).toContain('kept unchanged');
    expect(warning!.message).toContain('RFC 9989');
  });

  it('appends a rua tag when the record has none', () => {
    const dual = buildDualRecord('v=DMARC1; p=reject; adkim=s', OUR);

    expect(dual.value).toBe(`v=DMARC1; p=reject; adkim=s; rua=mailto:${OUR}`);
    expect(codes(dual.warnings)).toEqual(['no_policy_change']);
  });

  it('preserves a trailing semicolon and odd whitespace', () => {
    const dual = buildDualRecord(
      'v=DMARC1 ; p=none;  rua =  mailto:agg@dmarcian.com !10m ;',
      OUR,
    );

    expect(dual.value).toBe(
      `v=DMARC1 ; p=none;  rua =  mailto:${OUR},mailto:agg@dmarcian.com !10m ;`,
    );
  });
});

describe('building the cutover record', () => {
  it('removes the incumbent from rua and ruf, drops an empty ruf, and keeps self-hosted URIs', () => {
    const record =
      'v=DMARC1; p=reject; rua=mailto:dmarc-reports+abcdef012345@reports.dmarcharbor.com,mailto:agg@dmarcian.com,mailto:dmarc@example.com; ruf=mailto:fr@dmarcian.com; adkim=r';
    const cutover = buildCutoverRecord(record, [
      'mailto:agg@dmarcian.com',
      'mailto:fr@dmarcian.com!10m',
    ]);

    expect(cutover.value).toBe(
      `v=DMARC1; p=reject; rua=mailto:${OUR},mailto:dmarc@example.com; adkim=r`,
    );
    expect(cutover.value).not.toContain('ruf=');
    expect(codes(cutover.warnings)).toEqual(['forensic_removed']);
  });

  it('is idempotent', () => {
    const record =
      'v=DMARC1; p=reject; rua=mailto:dmarc-reports+abcdef012345@reports.dmarcharbor.com,mailto:agg@dmarcian.com; ruf=mailto:fr@dmarcian.com';
    const incumbents = ['mailto:agg@dmarcian.com', 'mailto:fr@dmarcian.com'];

    const first = buildCutoverRecord(record, incumbents);
    const second = buildCutoverRecord(first.value, incumbents);

    expect(second.value).toBe(first.value);
    expect(second.warnings).toEqual([]);
  });

  it('removes an https incumbent by exact lowercase match', () => {
    const record =
      'v=DMARC1; p=none; rua=https://reports.easydmarc.us/v1/x,mailto:dmarc@example.com';
    const cutover = buildCutoverRecord(record, ['HTTPS://reports.easydmarc.us/v1/x']);

    expect(cutover.value).toBe('v=DMARC1; p=none; rua=mailto:dmarc@example.com');
  });

  it('inserts our address when every rua URI was the incumbent', () => {
    const cutover = buildCutoverRecord(
      'v=DMARC1; p=none; rua=mailto:agg@dmarcian.com',
      ['mailto:agg@dmarcian.com'],
      OUR,
    );

    expect(cutover.value).toBe(`v=DMARC1; p=none; rua=mailto:${OUR}`);
  });
});
