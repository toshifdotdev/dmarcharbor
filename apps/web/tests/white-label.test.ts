import { describe, expect, it } from 'vitest';
import { absoluteHttpUrl, httpOrigin, isVendorRoute, signedOutPortalNext } from '../lib/white-label.js';

/**
 * What an agency's verified custom domain serves.
 *
 * On that domain the reader is the agency's client, so every page about us
 * goes to the portal, and everything a client is sent to keeps working. A
 * route wrongly on the first list breaks a client's link; one missing from it
 * shows our pricing under the agency's name.
 */

describe('isVendorRoute', () => {
  it('sends our landing, marketing, docs and legal pages to the portal', () => {
    for (const path of [
      '/',
      '/pricing',
      '/tools',
      '/tools/dmarc',
      '/tools/dmarc-generator',
      '/glossary',
      '/guides',
      '/guides/hubspot',
      '/guide',
      '/faq',
      '/docs',
      '/docs/api',
      '/docs/api/webhooks',
      '/support',
      '/privacy',
      '/terms',
      '/dpa',
      '/refunds',
      '/acceptable-use',
      '/security',
      '/sub-processors',
      '/complaints',
      '/cookies',
      '/welcome',
      '/pricing/',
    ]) {
      expect(isVendorRoute(path), path).toBe(true);
    }
  });

  it('keeps everything a client is sent to, and the staff screens', () => {
    for (const path of [
      '/portal',
      '/portal/domain/corriwick-example',
      '/sign-in',
      '/sign-up',
      '/share/abc123',
      '/trust/haskerley-law',
      '/prospect/tok',
      '/reports/download',
      '/verify',
      '/exports/download',
      '/api/auth/sign-in/email',
      '/brand-icon/48-tab-png',
      '/favicon.ico',
      '/manifest.webmanifest',
      '/docs-media/trust-center.png',
      '/settings/security',
      '/clients',
      '/security.txt',
    ]) {
      expect(isVendorRoute(path), path).toBe(false);
    }
  });
});

describe('signedOutPortalNext', () => {
  const none = new URLSearchParams();

  it('sends the portal without a session straight to sign-in', () => {
    expect(signedOutPortalNext('/portal', none, false)).toBe('/portal');
  });

  it("keeps the provider choice for a contact with several", () => {
    expect(signedOutPortalNext('/portal', new URLSearchParams('org=org_1&x=1'), false)).toBe('/portal?org=org_1');
  });

  it('leaves a session, a failed verification link and other pages to the page', () => {
    expect(signedOutPortalNext('/portal', none, true)).toBeNull();
    expect(signedOutPortalNext('/portal', new URLSearchParams('error=TOKEN_EXPIRED'), false)).toBeNull();
    expect(signedOutPortalNext('/portal/domain/x', none, false)).toBeNull();
    expect(signedOutPortalNext('/sign-in', none, false)).toBeNull();
  });
});

describe('client links from the API', () => {
  it('passes an absolute web address through', () => {
    expect(absoluteHttpUrl('https://reports.wistholm.example/share/tok')).toBe('https://reports.wistholm.example/share/tok');
    expect(httpOrigin('https://reports.wistholm.example/')).toBe('https://reports.wistholm.example');
    expect(httpOrigin('http://localhost:3100')).toBe('http://localhost:3100');
  });

  it('refuses anything that is not one', () => {
    for (const raw of [undefined, null, '', '   ', '/share/tok', 'javascript:alert(1)', 'data:text/html,x', 42]) {
      expect(absoluteHttpUrl(raw), String(raw)).toBeNull();
      expect(httpOrigin(raw), String(raw)).toBeNull();
    }
  });
});
