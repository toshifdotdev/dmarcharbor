import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import {
  classifyReportAddress,
  clientAggregateAddress,
  isOurAddress,
  normaliseReportUri,
  reportTokenPattern,
} from '../src/services/report-address.service.js';

const originalMode = env.REPORT_ADDRESS_SUBADDRESSING;
const originalAddress = env.REPORT_AGGREGATE_ADDRESS;

afterEach(() => {
  env.REPORT_ADDRESS_SUBADDRESSING = originalMode;
  env.REPORT_AGGREGATE_ADDRESS = originalAddress;
});

describe('client report addresses', () => {
  it('returns the shared address when subaddressing is off', () => {
    env.REPORT_ADDRESS_SUBADDRESSING = 'off';
    expect(clientAggregateAddress('abcdef012345')).toBe(env.REPORT_AGGREGATE_ADDRESS);
  });

  it('builds local+token@domain when subaddressing is plus', () => {
    env.REPORT_ADDRESS_SUBADDRESSING = 'plus';
    env.REPORT_AGGREGATE_ADDRESS = 'dmarc-reports@reports.dmarcharbor.com';

    expect(clientAggregateAddress('abcdef012345')).toBe(
      'dmarc-reports+abcdef012345@reports.dmarcharbor.com',
    );
  });

  it('treats a twelve character lowercase hex token as the pattern', () => {
    expect(reportTokenPattern.test('abcdef012345')).toBe(true);
    expect(reportTokenPattern.test('ABCDEF012345')).toBe(false);
    expect(reportTokenPattern.test('abcdef01234')).toBe(false);
    expect(reportTokenPattern.test('abcdef0123456')).toBe(false);
    expect(reportTokenPattern.test('abcdef01234g')).toBe(false);
  });
});

describe('normalising a report URI', () => {
  it('strips mailto, a size suffix, case whitespace and percent encoding', () => {
    expect(normaliseReportUri(' MAILTO:DMARC-Reports%2Babcdef012345@Reports.DMARCHARBOR.com ')).toBe(
      'dmarc-reports+abcdef012345@reports.dmarcharbor.com',
    );
    expect(normaliseReportUri('mailto:Aggregator@Example.COM!10m')).toBe('aggregator@example.com');
    expect(normaliseReportUri('mailto:dmarc-reports%2Babcdef012345%40reports.dmarcharbor.com')).toBe(
      'dmarc-reports+abcdef012345@reports.dmarcharbor.com',
    );
  });

  it('rejects anything that is not a usable mailto address', () => {
    expect(normaliseReportUri('https://reports.example.com/rua')).toBeNull();
    expect(normaliseReportUri('mailto:')).toBeNull();
    expect(normaliseReportUri('mailto:not-an-address')).toBeNull();
    expect(normaliseReportUri('mailto:%E0%A4%A@example.com')).toBeNull();
  });
});

describe('classifying a report address', () => {
  it('recognises the shared address, with or without mailto and in any case', () => {
    env.REPORT_ADDRESS_SUBADDRESSING = 'off';
    env.REPORT_AGGREGATE_ADDRESS = 'dmarc-reports@reports.dmarcharbor.com';

    expect(classifyReportAddress('mailto:dmarc-reports@reports.dmarcharbor.com')).toEqual({ kind: 'shared' });
    expect(classifyReportAddress('DMARC-REPORTS@REPORTS.DMARCHARBOR.COM')).toEqual({ kind: 'shared' });
    expect(classifyReportAddress('mailto:dmarc-reports@reports.dmarcharbor.com!10m')).toEqual({ kind: 'shared' });
  });

  it('recognises a client token even while subaddressing is off', () => {
    env.REPORT_ADDRESS_SUBADDRESSING = 'off';

    expect(classifyReportAddress('mailto:dmarc-reports+abcdef012345@reports.dmarcharbor.com')).toEqual({
      kind: 'client',
      token: 'abcdef012345',
    });
    expect(classifyReportAddress('dmarc-reports+abcdef012345@reports.dmarcharbor.com')).toEqual({
      kind: 'client',
      token: 'abcdef012345',
    });
  });

  it('recognises a percent encoded client address', () => {
    env.REPORT_ADDRESS_SUBADDRESSING = 'plus';

    expect(
      classifyReportAddress('mailto:dmarc-reports%2Babcdef012345%40reports.dmarcharbor.com'),
    ).toEqual({ kind: 'client', token: 'abcdef012345' });
  });

  it('treats another domain as foreign and keeps its host', () => {
    expect(classifyReportAddress('mailto:aggregate@ag.dmarcian.com')).toEqual({
      kind: 'foreign',
      host: 'ag.dmarcian.com',
    });
  });

  it('refuses a token of the wrong length instead of calling it ours', () => {
    expect(classifyReportAddress('mailto:dmarc-reports+abcdef01234@reports.dmarcharbor.com')).toEqual({
      kind: 'foreign',
      host: 'reports.dmarcharbor.com',
    });
    expect(classifyReportAddress('mailto:dmarc-reports+abcdef0123456@reports.dmarcharbor.com')).toEqual({
      kind: 'foreign',
      host: 'reports.dmarcharbor.com',
    });
  });

  it('returns invalid for input that is not a mail address', () => {
    expect(classifyReportAddress('https://reports.example.com/rua')).toEqual({ kind: 'invalid' });
    expect(classifyReportAddress('')).toEqual({ kind: 'invalid' });
    expect(classifyReportAddress('mailto:%E0%A4%A@example.com')).toEqual({ kind: 'invalid' });
  });

  it('counts shared and client addresses as ours, and nothing else', () => {
    env.REPORT_ADDRESS_SUBADDRESSING = 'plus';

    expect(isOurAddress('mailto:dmarc-reports@reports.dmarcharbor.com')).toBe(true);
    expect(isOurAddress('mailto:dmarc-reports+abcdef012345@reports.dmarcharbor.com')).toBe(true);
    expect(isOurAddress('mailto:aggregate@ag.dmarcian.com')).toBe(false);
    expect(isOurAddress('https://reports.example.com/rua')).toBe(false);
  });
});
