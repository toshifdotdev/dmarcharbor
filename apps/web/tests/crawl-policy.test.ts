import { describe, expect, it } from 'vitest';
import { resolveRobots, resolveSitemap } from 'next/dist/build/webpack/loaders/metadata/resolve-route-data.js';
import {
  INDEXABLE_ROUTES,
  NAMED_CRAWLERS,
  PUBLIC_PATHS,
  ROBOTS_DISALLOW,
  SECURITY_TXT_VALID_DAYS,
  realDate,
  robotsFile,
  robotsFor,
  robotsForRequest,
  securityTxt,
  sitemapEntries,
} from '../lib/crawl-policy';
import { DEVELOPER_DOCS } from '../lib/docs-registry';
import { LEGAL_DOCS } from '../lib/legal-docs';

/**
 * What a crawler may index, crawl and read. The robots.txt and sitemap.xml
 * text is rendered with Next's own serialisers, so the assertions are on the
 * files a crawler actually receives.
 */

const SITE = 'https://dmarcharbor.com';
const index = { index: true, follow: true };

describe('robotsFor: an allowlist of public pages, by exact path', () => {
  it('indexes every public page', () => {
    const expected = [
      '/',
      '/pricing',
      '/verify',
      '/support',
      '/faq',
      '/guide',
      '/docs/api',
      ...LEGAL_DOCS.map((d) => `/${d.slug}`),
      ...DEVELOPER_DOCS.map((d) => d.path),
    ];
    for (const path of expected) expect(robotsFor(path), path).toEqual(index);
  });

  it('noindexes everything else, including routes no prefix list ever named', () => {
    for (const path of [
      '/account',
      '/account/security',
      '/exports/download',
      '/reports/download',
      '/brand-icon/48-tab-png',
      '/clients/switch',
      '/clients',
      '/settings/api-keys',
      '/sign-in',
      '/sign-up',
      '/welcome',
      '/docs',
      '/pricing/extra',
      '/a-path-nobody-planned',
    ]) {
      const robots = robotsFor(path) as { index: boolean; follow: boolean };
      expect(robots.index, path).toBe(false);
      expect(robots.follow, path).toBe(true);
    }
  });

  it('noindexes and nofollows the tenant artefacts', () => {
    for (const path of ['/portal', '/portal/domain/x', '/share/tok', '/trust/slug', '/prospect/tok']) {
      expect(robotsFor(path), path).toMatchObject({ index: false, follow: false });
    }
  });
});

describe('robotsForRequest', () => {
  it('keeps the allowlist on our host and on an agency domain, except the verifier there', () => {
    expect(robotsForRequest('/pricing', 'own')).toEqual(index);
    expect(robotsForRequest('/verify', 'own')).toEqual(index);
    expect(robotsForRequest('/verify', 'agency')).toMatchObject({ index: false, follow: false });
    expect(robotsForRequest('/portal', 'agency')).toMatchObject({ index: false, follow: false });
  });

  it('noindexes every page on any other host', () => {
    for (const path of ['/', '/pricing', '/faq', '/docs/api', '/verify']) {
      expect(robotsForRequest(path, 'other'), path).toMatchObject({ index: false, follow: true });
    }
  });
});

describe('robots.txt', () => {
  const ours = resolveRobots(robotsFile({ kind: 'own', origin: SITE }));
  const agency = resolveRobots(robotsFile({ kind: 'agency', origin: 'https://portal.agency.example' }));
  const other = resolveRobots(robotsFile({ kind: 'other', origin: SITE }));

  /** The robots.txt groups: user agents, and the rule lines they share. */
  function groups(text: string) {
    return text
      .trim()
      .split(/\n\n+/)
      .filter((block) => block.startsWith('User-Agent'))
      .map((block) => {
        const lines = block.split('\n');
        return {
          agents: lines.filter((l) => l.startsWith('User-Agent: ')).map((l) => l.slice(12)),
          rules: lines.filter((l) => !l.startsWith('User-Agent: ') && !l.startsWith('Sitemap: ')),
        };
      });
  }

  it('names every search and AI crawler, with exactly the rules `*` has', () => {
    const g = groups(ours);
    const star = g.find((x) => x.agents.includes('*'))!;
    expect(star.rules).toContain('Allow: /');
    for (const bot of NAMED_CRAWLERS) {
      const group = g.find((x) => x.agents.includes(bot));
      expect(group, bot).toBeDefined();
      expect(group!.rules, bot).toEqual(star.rules);
    }
    for (const bot of ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Bingbot', 'Googlebot']) {
      expect(ours).toContain(`User-Agent: ${bot}\n`);
    }
  });

  it('disallows the API, the signed-in app and the auth screens', () => {
    for (const path of ['/api/', '/sign-in', '/sign-up', '/welcome', '/account', '/clients', '/settings', '/exports', '/reports']) {
      expect(ours).toContain(`Disallow: ${path}\n`);
    }
    expect(ROBOTS_DISALLOW).toContain('/api/');
  });

  it('leaves the tenant artefacts crawlable, so their noindex can be read', () => {
    for (const path of ['/share', '/trust', '/prospect', '/portal']) {
      // Exact lines: /prospects (the operator's prospect list) is disallowed,
      // and as a robots.txt prefix it does not cover /prospect/<token>.
      expect(ours).not.toMatch(new RegExp(`^Disallow: ${path}/?$`, 'm'));
      expect(agency).not.toMatch(new RegExp(`^Disallow: ${path}/?$`, 'm'));
    }
  });

  it('never disallows a public page', () => {
    for (const path of PUBLIC_PATHS) {
      if (path === '/') continue;
      expect(ROBOTS_DISALLOW.some((d) => path === d || path.startsWith(d.endsWith('/') ? d : `${d}/`)), path).toBe(false);
    }
  });

  it('names the sitemap on our canonical origin', () => {
    expect(ours).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });

  it('keeps the rules on an agency domain and names no sitemap there', () => {
    expect(groups(agency)).toEqual(groups(ours));
    expect(agency).not.toContain('Sitemap:');
  });

  it('disallows everything, with no sitemap, on any other host', () => {
    expect(other).toBe('User-Agent: *\nDisallow: /\n\n');
  });
});

describe('sitemap.xml', () => {
  it('lists exactly the public allowlist on the canonical origin', () => {
    const entries = sitemapEntries(SITE);
    expect(entries.map((e) => e.url)).toEqual(PUBLIC_PATHS.map((p) => new URL(p, SITE).toString()));
    expect(new Set(PUBLIC_PATHS)).toEqual(new Set([...INDEXABLE_ROUTES, ...DEVELOPER_DOCS.map((d) => d.path)]));
    expect(PUBLIC_PATHS).not.toContain('/llms.txt');
    for (const entry of entries) expect(entry.url.startsWith(`${SITE}/`)).toBe(true);
  });

  it('carries no lastModified while the effective date is a placeholder', () => {
    const entries = sitemapEntries(SITE);
    for (const entry of entries) expect(entry.lastModified, entry.url).toBeUndefined();
    expect(resolveSitemap(entries)).not.toContain('<lastmod>');
  });

  it('dates the legal documents, and only them, once the effective date is real', () => {
    const entries = sitemapEntries(SITE, '2026-03-01');
    const dated = entries.filter((e) => e.lastModified).map((e) => new URL(e.url).pathname);
    expect(dated).toContain('/terms');
    expect(dated).toContain('/privacy');
    for (const undated of ['/', '/pricing', '/verify', '/support', '/faq', '/guide', '/docs/api']) {
      expect(dated).not.toContain(undated);
    }
    expect(entries.find((e) => e.url.endsWith('/terms'))?.lastModified).toBe('2026-03-01');
  });

  it('accepts only real calendar dates', () => {
    expect(realDate('2026-03-01')).toBe('2026-03-01');
    expect(realDate('to be set at launch')).toBeNull();
    expect(realDate('2026-02-30')).toBeNull();
    expect(realDate('2026-3-1')).toBeNull();
  });
});

describe('security.txt', () => {
  const now = new Date('2026-01-10T12:00:00.000Z');
  const text = securityTxt({ origin: SITE, now });
  const field = (name: string) => text.split('\n').find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);

  it('carries the RFC 9116 fields against the canonical origin', () => {
    expect(field('Contact')).toBe('mailto:support@dmarcharbor.com');
    expect(field('Policy')).toBe(`${SITE}/security`);
    expect(field('Preferred-Languages')).toBe('en');
    expect(field('Canonical')).toBe(`${SITE}/.well-known/security.txt`);
  });

  it('expires 180 days from now, in ISO 8601', () => {
    expect(SECURITY_TXT_VALID_DAYS).toBe(180);
    expect(field('Expires')).toBe('2026-07-09T12:00:00Z');
  });

  it('never invents a security@ mailbox', () => {
    expect(text).not.toContain('security@');
  });
});
