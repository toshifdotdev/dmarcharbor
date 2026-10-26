import { describe, expect, it } from 'vitest';
import {
  bimiDmarcQualification,
  inspectBimiSvg,
  mxCoveredBy,
  parseBimiTxt,
  parseMtaStsPolicy,
  parseMtaStsTxt,
  parseTlsRptTxt,
} from '../src/scanner/transport-records.js';

const VALID_POLICY = [
  'version: STSv1',
  'mode: enforce',
  'mx: mx1.example.com',
  'mx: mx2.example.com',
  'max_age: 604800',
].join('\n');

const VALID_SVG = Buffer.from(
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 100 100">',
    '  <title>Example logo</title>',
    '  <circle cx="50" cy="50" r="40"/>',
    '</svg>',
  ].join('\n'),
);

function dmarc(overrides: Record<string, unknown> = {}) {
  return {
    status: 'found' as const,
    policy: 'reject' as const,
    effectivePolicy: 'reject' as const,
    tags: { p: 'reject' },
    ...overrides,
  };
}

describe('MTA-STS TXT records', () => {
  it('joins strings without a separator and discards unrelated TXT records', () => {
    const result = parseMtaStsTxt([
      ['v=STSv1; ', 'id=abc123;'],
      ['google-site-verification=keep'],
    ]);
    expect(result.status).toBe('found');
    expect(result.id).toBe('abc123');
    expect(result.record).toBe('v=STSv1; id=abc123;');
  });

  it('reports multiple records, missing or invalid ids', () => {
    const multiple = parseMtaStsTxt([
      ['v=STSv1; id=one'],
      ['v=STSv1; id=two'],
    ]);
    expect(multiple.recordProblem).toContain('More than one');

    expect(parseMtaStsTxt([['v=STSv1;']]).recordProblem).toContain('id');
    expect(parseMtaStsTxt([[`v=STSv1; id=${'a'.repeat(33)}`]]).recordProblem).toContain('id');
    expect(parseMtaStsTxt([['v=STSv1; id=abc!']]).recordProblem).toContain('id');
  });

  it('is missing when none starts with v=STSv1', () => {
    expect(parseMtaStsTxt([['v=spf1 -all']])).toMatchObject({ status: 'missing', policy: null });
  });
});

describe('MTA-STS policy', () => {
  it('parses CRLF and LF, first-wins keys and repeated mx', () => {
    const crlf = parseMtaStsPolicy(VALID_POLICY.replace(/\n/g, '\r\n'), 'text/plain; charset=utf-8');
    expect(crlf.valid).toBe(true);
    expect(crlf.mode).toBe('enforce');
    expect(crlf.mx).toEqual(['mx1.example.com', 'mx2.example.com']);
    expect(crlf.maxAge).toBe(604800);

    const lf = parseMtaStsPolicy(
      ['version: STSv1', 'mode: testing', 'mode: enforce', 'mx: mx1.example.com', 'max_age: 60'].join('\n'),
      'text/plain',
    );
    expect(lf.mode).toBe('testing');
  });

  it('accepts max_age 31,557,600 and refuses one more', () => {
    expect(parseMtaStsPolicy(VALID_POLICY.replace('604800', '31557600')).valid).toBe(true);
    expect(parseMtaStsPolicy(VALID_POLICY.replace('604800', '31557601')).valid).toBe(false);
  });

  it('accepts mode none with no mx and ignores unknown keys', () => {
    const result = parseMtaStsPolicy(
      ['version: STSv1', 'mode: none', 'max_age: 86400', 'unknown: value'].join('\n'),
      'text/plain',
    );
    expect(result.valid).toBe(true);
    expect(result.mode).toBe('none');
    expect(result.mx).toBeUndefined();
  });

  it('refuses an unknown mode and a wrong content type', () => {
    const badMode = parseMtaStsPolicy(VALID_POLICY.replace('enforce', 'strict'), 'text/plain');
    expect(badMode.valid).toBe(false);
    expect(badMode.problems.join(' ')).toContain('mode');

    const wrongType = parseMtaStsPolicy(VALID_POLICY, 'text/html');
    expect(wrongType.valid).toBe(false);
    expect(wrongType.contentTypeProblem).toContain('not text/plain');
  });
});

describe('MTA-STS MX coverage', () => {
  it('matches exact hosts and exactly one wildcard label, ignoring case and trailing dots', () => {
    expect(mxCoveredBy('MX1.Example.COM.', ['mx1.example.com'])).toBe(true);
    expect(mxCoveredBy('mx1.example.com', ['*.example.com'])).toBe(true);
    expect(mxCoveredBy('a.b.example.com', ['*.example.com'])).toBe(false);
    expect(mxCoveredBy('example.com', ['*.example.com'])).toBe(false);
    expect(mxCoveredBy('other.example.com', ['mx1.example.com'])).toBe(false);
  });
});

describe('TLS-RPT records', () => {
  it('sorts mailto and https targets and refuses other schemes', () => {
    const result = parseTlsRptTxt([
      ['v=TLSRPTv1; rua=', 'mailto:tls@example.com,https://reports.example.com/tls'],
    ]);
    expect(result).toMatchObject({ status: 'found', valid: true });
    expect(result.mailtoTargets).toEqual(['mailto:tls@example.com']);
    expect(result.httpsTargets).toEqual(['https://reports.example.com/tls']);

    const badScheme = parseTlsRptTxt([['v=TLSRPTv1; rua=ftp://reports.example.com']]);
    expect(badScheme.valid).toBe(false);
    expect(badScheme.problems.join(' ')).toContain('ftp');
  });

  it('refuses a missing rua and multiple records', () => {
    expect(parseTlsRptTxt([['v=TLSRPTv1;']]).valid).toBe(false);
    expect(parseTlsRptTxt([['v=TLSRPTv1; rua=mailto:a@example.com'], ['v=TLSRPTv1; rua=mailto:b@example.com']]).valid).toBe(false);
  });

  it('is missing without a v=TLSRPTv1 record', () => {
    expect(parseTlsRptTxt([['unrelated=1']])).toMatchObject({
      status: 'missing',
      mailtoTargets: [],
      httpsTargets: [],
    });
  });
});

describe('BIMI records', () => {
  it('treats an empty l= as declined and allows a= to be absent', () => {
    const declined = parseBimiTxt([['v=BIMI1; l=']]);
    expect(declined.declined).toBe(true);
    expect(declined.problems).toEqual([]);
    expect(declined.authorityUrl).toBeNull();
  });

  it('refuses an http logo and a non-https authority URL', () => {
    const http = parseBimiTxt([['v=BIMI1; l=http://example.com/logo.svg']]);
    expect(http.declined).toBe(false);
    expect(http.logoUrl).toBeNull();
    expect(http.problems.join(' ')).toContain('https');

    const authority = parseBimiTxt([['v=BIMI1; l=https://example.com/logo.svg; a=http://example.com/vmc.pem']]);
    expect(authority.authorityUrl).toBeNull();
    expect(authority.problems.join(' ')).toContain('a must be');
  });

  it('reports multiple records', () => {
    const result = parseBimiTxt([
      ['v=BIMI1; l=https://example.com/one.svg'],
      ['v=BIMI1; l=https://example.com/two.svg'],
    ]);
    expect(result.multiple).toBe(true);
    expect(result.problems.join(' ')).toContain('More than one');
  });
});

describe('BIMI DMARC qualification', () => {
  it('fails at p=none and passes at enforcement', () => {
    expect(bimiDmarcQualification(dmarc({ policy: 'none', effectivePolicy: 'none', tags: { p: 'none' } }), 'example.com')).toMatchObject({
      qualifies: false,
    });
    expect(bimiDmarcQualification(dmarc(), 'example.com').qualifies).toBe(true);
  });

  it('uses the effective policy for t=y', () => {
    expect(
      bimiDmarcQualification(
        dmarc({ policy: 'reject', effectivePolicy: 'quarantine', tags: { p: 'reject', t: 'y' } }),
        'example.com',
      ).qualifies,
    ).toBe(true);
    expect(
      bimiDmarcQualification(
        dmarc({ policy: 'quarantine', effectivePolicy: 'none', tags: { p: 'quarantine', t: 'y' } }),
        'example.com',
      ).qualifies,
    ).toBe(false);
  });

  it('fails quarantine below pct=100 and sp=none', () => {
    expect(
      bimiDmarcQualification(
        dmarc({ policy: 'quarantine', effectivePolicy: 'quarantine', tags: { p: 'quarantine', pct: '50' } }),
        'example.com',
      ).qualifies,
    ).toBe(false);
    expect(
      bimiDmarcQualification(
        dmarc({ policy: 'reject', effectivePolicy: 'reject', tags: { p: 'reject', sp: 'none' } }),
        'example.com',
      ).qualifies,
    ).toBe(false);
  });

  it('adds the parent-domain note without changing qualification', () => {
    const result = bimiDmarcQualification(dmarc(), 'mail.example.com');
    expect(result.qualifies).toBe(true);
    expect(result.reasons.join(' ')).toContain('example.com');
  });

  it('defers to the parent when a subdomain publishes no DMARC record of its own', () => {
    const subdomain = bimiDmarcQualification(dmarc({ status: 'missing' }), 'mail.example.com');
    expect(subdomain).toMatchObject({ qualifies: false, dependsOnParent: true });
    expect(subdomain.reasons.join(' ')).toContain('example.com');

    // An organisational domain with no record is a plain failure.
    const apex = bimiDmarcQualification(dmarc({ status: 'missing' }), 'example.com');
    expect(apex.qualifies).toBe(false);
    expect(apex.dependsOnParent).toBeUndefined();
  });
});

describe('BIMI SVG basic checks', () => {
  it('accepts a valid tiny-ps example', () => {
    expect(inspectBimiSvg(VALID_SVG)).toEqual({
      svgRoot: true,
      tinyPsProfile: true,
      version12: true,
      title: true,
      noForbiddenElements: true,
      noExternalReferences: true,
      withinSizeLimit: true,
    });
  });

  it.each(['script', 'foreignObject', 'image', 'animate', 'switch', 'set'])(
    'rejects <%s>',
    (element) => {
      const svg = Buffer.from(VALID_SVG.toString().replace('<circle', `<${element}></${element}><circle`));
      expect(inspectBimiSvg(svg).noForbiddenElements).toBe(false);
    },
  );

  it('rejects an a element and an event attribute', () => {
    expect(inspectBimiSvg(Buffer.from(VALID_SVG.toString().replace('<circle', '<a href="https://example.com">x</a><circle'))).noForbiddenElements).toBe(false);
    expect(inspectBimiSvg(Buffer.from(VALID_SVG.toString().replace('<svg ', '<svg onload="alert(1)" '))).noForbiddenElements).toBe(false);
  });

  it('rejects external hrefs', () => {
    const svg = Buffer.from(VALID_SVG.toString().replace('<circle', '<use href="//example.com/x"/><circle'));
    expect(inspectBimiSvg(svg).noExternalReferences).toBe(false);
  });

  it('rejects a missing or empty title', () => {
    const missing = Buffer.from(VALID_SVG.toString().replace('<title>Example logo</title>', ''));
    expect(inspectBimiSvg(missing).title).toBe(false);
    const empty = Buffer.from(VALID_SVG.toString().replace('Example logo', '   '));
    expect(inspectBimiSvg(empty).title).toBe(false);
  });

  it('fails the size limit at 32,769 bytes', () => {
    const padded = Buffer.concat([VALID_SVG, Buffer.alloc(32_769 - VALID_SVG.length, 0x20)]);
    expect(padded.length).toBe(32_769);
    expect(inspectBimiSvg(padded).withinSizeLimit).toBe(false);
  });
});
