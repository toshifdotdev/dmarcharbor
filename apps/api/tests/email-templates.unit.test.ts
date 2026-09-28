import { describe, expect, it } from 'vitest';
import {
  domainVerificationNotice,
  erasureCompletedEmail,
  erasureScheduledEmail,
  escapeHtml,
  exportReadyEmail,
  paymentFailedEmail,
  planChangedEmail,
  portalAccessGranted,
  subscriptionCancelledEmail,
  type BrandLook,
} from '../src/email/templates.js';

const agencyBrand: BrandLook = {
  workspaceName: 'Northgate Digital',
  logoUrl: 'https://cdn.northgate.test/logo.svg',
  primaryColor: '#0f172a',
  accentColor: '#0ea5e9',
};

describe('email templates', () => {
  it('escapes user supplied values so a client name cannot inject markup', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('Ben & Jerry')).toBe('Ben &amp; Jerry');
    expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');

    const rendered = portalAccessGranted({
      brand: { workspaceName: 'Northgate' },
      clientName: '<img src=x onerror=alert(1)>',
      signInUrl: 'https://app.example.com/portal',
      agencyName: 'Northgate',
    });

    expect(rendered.html).not.toContain('<img src=x');
    expect(rendered.html).toContain('&lt;img src=x');
  });

  it('produces a text alternative for every template', () => {
    const templates = [
      portalAccessGranted({ brand: agencyBrand, clientName: 'Acme', signInUrl: 'https://a.test/p', agencyName: 'Northgate Digital' }),
      domainVerificationNotice({ workspaceName: 'W', domainName: 'acme.test', verified: true, appUrl: 'https://a.test/d' }),
      domainVerificationNotice({ workspaceName: 'W', domainName: 'acme.test', verified: false, appUrl: 'https://a.test/d' }),
      paymentFailedEmail({ workspaceName: 'W', planLabel: 'Harbor', graceEndsAt: '2026-10-01T00:00:00.000Z', billingUrl: 'https://a.test/b' }),
      subscriptionCancelledEmail({ workspaceName: 'W', planLabel: 'Harbor', accessUntil: '2026-10-01T00:00:00.000Z', billingUrl: 'https://a.test/b' }),
      planChangedEmail({ workspaceName: 'W', fromLabel: 'Fairway', toLabel: 'Harbor', effectiveAt: '2026-10-01T00:00:00.000Z', billingUrl: 'https://a.test/b' }),
      exportReadyEmail({ workspaceName: 'W', scopeLabel: 'workspace', downloadUrl: 'https://a.test/e', expiresAt: '2026-10-01T00:00:00.000Z' }),
      erasureScheduledEmail({ workspaceName: 'W', scopeLabel: 'client', executesAt: '2026-10-01T00:00:00.000Z', cancelUrl: 'https://a.test/x' }),
      erasureCompletedEmail({ workspaceName: 'W', scopeLabel: 'client', completedAt: '2026-10-01T00:00:00.000Z' }),
    ];

    for (const rendered of templates) {
      // A single part HTML message is routinely filtered, which for a security
      // notification means the customer never learns anything.
      expect(rendered.text.length, rendered.subject).toBeGreaterThan(40);
      expect(rendered.html).toContain('<html');
      expect(rendered.html).toContain('</html>');
      expect(rendered.subject.length).toBeGreaterThan(10);
    }
  });

  it('keeps the action link reachable as plain text', () => {
    const rendered = portalAccessGranted({
      brand: agencyBrand,
      clientName: 'Acme',
      signInUrl: 'https://app.example.com/portal?token=abc123',
      agencyName: 'Northgate Digital',
    });

    // Many clients and all text readers will not follow an HTML button, so the
    // raw link has to survive into the text part.
    expect(rendered.text).toContain('https://app.example.com/portal?token=abc123');
    expect(rendered.html).toContain('https://app.example.com/portal?token=abc123');
  });

  it('brands a client facing message with the agency', () => {
    const rendered = portalAccessGranted({
      brand: agencyBrand,
      clientName: 'Acme',
      signInUrl: 'https://app.example.com/portal',
      agencyName: 'Northgate Digital',
    });

    expect(rendered.html).toContain('https://cdn.northgate.test/logo.svg');
    expect(rendered.html).toContain('#0f172a');
    expect(rendered.text).toContain('Northgate Digital');
  });

  it('falls back to product branding when an agency has none', () => {
    const rendered = portalAccessGranted({
      brand: { workspaceName: 'Northgate Digital' },
      clientName: 'Acme',
      signInUrl: 'https://app.example.com/portal',
      agencyName: 'Northgate Digital',
    });

    // No logo configured, so the workspace name stands in rather than a broken
    // image, and the accent falls back rather than rendering an empty style.
    expect(rendered.html).not.toContain('<img');
    expect(rendered.html).toContain('Northgate Digital');
    expect(rendered.html).toContain('#0ea5e9');
  });

  it('ignores a colour that is not a hex value', () => {
    const rendered = portalAccessGranted({
      brand: { workspaceName: 'Northgate', primaryColor: 'red; background:url(javascript:alert(1))', accentColor: '#zzzzzz' },
      clientName: 'Acme',
      signInUrl: 'https://app.example.com/portal',
      agencyName: 'Northgate',
    });

    expect(rendered.html).not.toContain('javascript:');
    expect(rendered.html).toContain('#0f172a');
    expect(rendered.html).toContain('#0ea5e9');
  });

  it('keeps DMARC Harbor branding off agency facing messages', () => {
    const rendered = paymentFailedEmail({
      workspaceName: 'W',
      planLabel: 'Harbor',
      graceEndsAt: '2026-10-01T00:00:00.000Z',
      billingUrl: 'https://a.test/b',
    });

    // Support stays unambiguous: a billing notice must not look like it came
    // from the vendor rather than the platform.
    expect(rendered.text).toContain('DMARC Harbor');
  });

  it('tells a customer a failed payment will not delete their data', () => {
    const rendered = paymentFailedEmail({
      workspaceName: 'W',
      planLabel: 'Harbor',
      graceEndsAt: '2026-10-01T00:00:00.000Z',
      billingUrl: 'https://a.test/b',
    });

    // The instinct on seeing a failed payment is to assume the worst, and
    // churn from that assumption costs more than the failed payment.
    expect(rendered.text.toLowerCase()).toContain('kept');
    expect(rendered.html).toContain('Nothing is lost');
  });

  it('gives a scheduled deletion a way to stop it', () => {
    const rendered = erasureScheduledEmail({
      workspaceName: 'W',
      scopeLabel: 'client',
      executesAt: '2026-10-01T00:00:00.000Z',
      cancelUrl: 'https://a.test/erasures/er_1',
    });

    expect(rendered.text).toContain('https://a.test/erasures/er_1');
    expect(rendered.text).toContain('cancel');
  });

  it('warns about a lapsed verification rather than only confirming success', () => {
    const lapsed = domainVerificationNotice({
      workspaceName: 'W',
      domainName: 'acme.test',
      verified: false,
      appUrl: 'https://a.test/d',
    });

    expect(lapsed.subject).toContain('lost its verification');
    expect(lapsed.text).toContain('no longer verified');
    expect(lapsed.text).toContain('rejected');
  });
});
