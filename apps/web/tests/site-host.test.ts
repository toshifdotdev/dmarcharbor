import { describe, expect, it } from 'vitest';
import { DEVELOPER_DOCS } from '../lib/docs-registry';
import {
  DOCS_INDEX_TARGET,
  canonicalOriginFor,
  docsIndexRedirect,
  hostKind,
  hostnameOf,
  parseHostKind,
  robotsHeaderFor,
  siteOriginFrom,
  type HostState,
} from '../lib/site-host';

/**
 * Which host a request is on decides whether its pages may be indexed and
 * which origin they name as canonical. Our own host is the only indexable one;
 * an agency's verified domain is canonical for its own pages; anything else
 * pointed at us is a duplicate or a stranger, and says noindex.
 */

const SITE = 'https://dmarcharbor.com';

describe('siteOriginFrom', () => {
  it('reads an http(s) SITE_URL as its origin', () => {
    expect(siteOriginFrom('https://dmarcharbor.com')).toBe(SITE);
    expect(siteOriginFrom(' https://dmarcharbor.com/some/path ')).toBe(SITE);
    expect(siteOriginFrom('http://localhost:3100')).toBe('http://localhost:3100');
  });

  it('treats unset, blank, malformed and non-web values as unset', () => {
    for (const raw of [undefined, null, '', '   ', 'dmarcharbor.com', 'ftp://dmarcharbor.com', 'javascript:alert(1)']) {
      expect(siteOriginFrom(raw)).toBeNull();
    }
  });
});

describe('hostnameOf', () => {
  it('drops the port, lower-cases and takes the first forwarded value', () => {
    expect(hostnameOf('DMARCHarbor.com:443')).toBe('dmarcharbor.com');
    expect(hostnameOf('dmarcharbor.com, proxy.internal')).toBe('dmarcharbor.com');
    expect(hostnameOf('[::1]:3100')).toBe('[::1]');
    expect(hostnameOf('localhost')).toBe('localhost');
  });

  it('answers null when there is no host', () => {
    expect(hostnameOf(null)).toBeNull();
    expect(hostnameOf('')).toBeNull();
  });
});

describe('hostKind', () => {
  const states: HostState[] = ['default', 'miss', 'unverified', 'verified'];

  it('is always "agency" on a verified custom domain, SITE_URL or not', () => {
    for (const siteOrigin of [SITE, null]) {
      expect(hostKind({ state: 'verified', hostname: 'portal.agency.example', siteOrigin })).toBe('agency');
      // Even if a verified record somehow named our own hostname.
      expect(hostKind({ state: 'verified', hostname: 'dmarcharbor.com', siteOrigin })).toBe('agency');
    }
  });

  it('with SITE_URL unset, our own hosts ("default") are own and every other state is other', () => {
    expect(hostKind({ state: 'default', hostname: 'localhost', siteOrigin: null })).toBe('own');
    expect(hostKind({ state: 'miss', hostname: 'random.example', siteOrigin: null })).toBe('other');
    expect(hostKind({ state: 'unverified', hostname: 'pending.agency.example', siteOrigin: null })).toBe('other');
  });

  it("with SITE_URL set, only its hostname is own, whatever the brand state", () => {
    for (const state of states.filter((s) => s !== 'verified')) {
      expect(hostKind({ state, hostname: 'dmarcharbor.com', siteOrigin: SITE })).toBe('own');
      expect(hostKind({ state, hostname: 'www.dmarcharbor.com', siteOrigin: SITE })).toBe('other');
      expect(hostKind({ state, hostname: 'app.dmarcharbor.com', siteOrigin: SITE })).toBe('other');
      expect(hostKind({ state, hostname: '203.0.113.7', siteOrigin: SITE })).toBe('other');
      expect(hostKind({ state, hostname: 'localhost', siteOrigin: SITE })).toBe('other');
      expect(hostKind({ state, hostname: null, siteOrigin: SITE })).toBe('other');
    }
  });
});

describe('parseHostKind', () => {
  it('reads back the three stamps and nothing else', () => {
    expect(parseHostKind('own')).toBe('own');
    expect(parseHostKind('agency')).toBe('agency');
    expect(parseHostKind('other')).toBe('other');
    expect(parseHostKind('OWN')).toBeNull();
    expect(parseHostKind(null)).toBeNull();
  });
});

describe('canonicalOriginFor', () => {
  it("names the agency's own origin on its domain, never ours", () => {
    expect(canonicalOriginFor({ kind: 'agency', requestOrigin: 'https://portal.agency.example', siteOrigin: SITE })).toBe(
      'https://portal.agency.example',
    );
  });

  it('names SITE_URL on our host and on every duplicate or unknown host', () => {
    expect(canonicalOriginFor({ kind: 'own', requestOrigin: SITE, siteOrigin: SITE })).toBe(SITE);
    expect(canonicalOriginFor({ kind: 'other', requestOrigin: 'https://www.dmarcharbor.com', siteOrigin: SITE })).toBe(SITE);
    expect(canonicalOriginFor({ kind: 'other', requestOrigin: 'https://pointed.example', siteOrigin: SITE })).toBe(SITE);
  });

  it('falls back to the request origin when SITE_URL is unset', () => {
    expect(canonicalOriginFor({ kind: 'own', requestOrigin: 'http://localhost:3100', siteOrigin: null })).toBe(
      'http://localhost:3100',
    );
    expect(canonicalOriginFor({ kind: 'other', requestOrigin: 'https://pointed.example', siteOrigin: null })).toBe(
      'https://pointed.example',
    );
  });
});

describe('robotsHeaderFor', () => {
  it('sends noindex, nofollow for every tenant artefact on every host', () => {
    for (const kind of ['own', 'agency', 'other'] as const) {
      for (const pathname of ['/portal', '/portal/domain/abc', '/share/tok', '/trust/acme', '/prospect/tok']) {
        expect(robotsHeaderFor({ kind, pathname })).toBe('noindex, nofollow');
      }
    }
  });

  it('sends noindex for every page on a host that is neither ours nor an agency\'s', () => {
    for (const pathname of ['/', '/pricing', '/docs/api', '/robots.txt', '/clients']) {
      expect(robotsHeaderFor({ kind: 'other', pathname })).toBe('noindex');
    }
  });

  it("makes the verifier noindex, nofollow on an agency's domain and leaves it alone on ours", () => {
    expect(robotsHeaderFor({ kind: 'agency', pathname: '/verify' })).toBe('noindex, nofollow');
    expect(robotsHeaderFor({ kind: 'own', pathname: '/verify' })).toBeNull();
  });

  it('sends nothing for our public pages on our host (the meta tag decides the rest)', () => {
    for (const pathname of ['/', '/pricing', '/faq', '/docs/api', '/sign-in']) {
      expect(robotsHeaderFor({ kind: 'own', pathname })).toBeNull();
    }
  });
});

describe('docsIndexRedirect', () => {
  it('sends /docs to the one developer document', () => {
    expect(docsIndexRedirect('/docs')).toBe('/docs/api');
    expect(docsIndexRedirect('/docs/')).toBe('/docs/api');
    expect(docsIndexRedirect('/docs/api')).toBeNull();
    expect(docsIndexRedirect('/documents')).toBeNull();
  });

  it('only while there is exactly one developer document, and it is the target', () => {
    // A second document needs a /docs index page instead of this redirect.
    expect(DEVELOPER_DOCS).toHaveLength(1);
    expect(DEVELOPER_DOCS[0]!.path).toBe(DOCS_INDEX_TARGET);
  });
});
