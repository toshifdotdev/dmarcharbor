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

// The sample agency's look. `accentColor` is the text set ON the primary
// colour (the web settings call it "Text on the brand colour").
const agencyBrand: BrandLook = {
  workspaceName: 'Wistholm IT',
  logoUrl: 'https://app.dmarcharbor.example/brand-logos/wistholm.png',
  primaryColor: '#0f766e',
  accentColor: '#fdfcf7',
};

/** The primary action's fill and label colour, read from the pill's markup. */
function pill(html: string): { fill: string; label: string } {
  const match = /<td align="center" bgcolor="(#[0-9a-f]{6})"[^>]*><a href="[^"]*" style="[^"]*;color:(#[0-9a-f]{6});/i.exec(html);
  if (!match) throw new Error('No action pill in the message.');
  return { fill: match[1]!, label: match[2]! };
}

describe('email templates', () => {
  it('escapes user supplied values so a client name cannot inject markup', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('Ben & Jerry')).toBe('Ben &amp; Jerry');
    expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');

    const rendered = portalAccessGranted({
      brand: { workspaceName: 'Wistholm IT' },
      clientName: '<img src=x onerror=alert(1)>',
      signInUrl: 'https://app.example.com/portal',
      agencyName: 'Wistholm IT',
    });

    expect(rendered.html).not.toContain('<img src=x');
    expect(rendered.html).toContain('&lt;img src=x');
  });

  it('produces a text alternative for every template', () => {
    const templates = [
      portalAccessGranted({ brand: agencyBrand, clientName: 'Pellowyn Dental', signInUrl: 'https://a.test/p', agencyName: 'Wistholm IT' }),
      domainVerificationNotice({ workspaceName: 'W', domainName: 'acme.test', verified: true, appUrl: 'https://a.test/d' }),
      domainVerificationNotice({ workspaceName: 'W', domainName: 'acme.test', verified: false, appUrl: 'https://a.test/d' }),
      paymentFailedEmail({ workspaceName: 'W', planLabel: 'Harbor', graceEndsAt: '2026-10-01T00:00:00.000Z', billingUrl: 'https://a.test/b' }),
      subscriptionCancelledEmail({ workspaceName: 'W', planLabel: 'Harbor', accessUntil: '2026-10-01T00:00:00.000Z', billingUrl: 'https://a.test/b' }),
      planChangedEmail({ workspaceName: 'W', fromLabel: 'Fairway', toLabel: 'Harbor', effectiveAt: '2026-10-01T00:00:00.000Z', timing: 'cycle_end', billingUrl: 'https://a.test/b' }),
      planChangedEmail({ workspaceName: 'W', fromLabel: 'Fairway', toLabel: 'Harbor', effectiveAt: '2026-10-01T00:00:00.000Z', timing: 'immediate', billingUrl: 'https://a.test/b' }),
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

  it('words a plan change by when it actually takes effect', () => {
    const base = { workspaceName: 'W', fromLabel: 'Fairway', toLabel: 'Harbor', effectiveAt: '2026-10-01T00:00:00.000Z', billingUrl: 'https://a.test/b' };
    const scheduled = planChangedEmail({ ...base, timing: 'cycle_end' });
    const immediate = planChangedEmail({ ...base, timing: 'immediate' });

    expect(scheduled.text).toContain('already paid for');
    expect(scheduled.text).toContain('not charged a mid-cycle amount');
    // Paddle applies at once and prorates, so promising no mid-cycle charge
    // or a future date would be false.
    expect(immediate.text).not.toContain('mid-cycle');
    expect(immediate.text).not.toContain('already paid for');
    expect(immediate.text).toContain('adjusts the charge');
  });

  it('keeps the action link reachable as plain text', () => {
    const rendered = portalAccessGranted({
      brand: agencyBrand,
      clientName: 'Pellowyn Dental',
      signInUrl: 'https://app.example.com/portal?token=abc123',
      agencyName: 'Wistholm IT',
    });

    // Many clients and all text readers will not follow an HTML button, so the
    // raw link has to survive into the text part.
    expect(rendered.text).toContain('https://app.example.com/portal?token=abc123');
    expect(rendered.html).toContain('https://app.example.com/portal?token=abc123');
  });

  it('brands a client facing message with the agency: its logo, its colour on the button, its text colour on that', () => {
    const rendered = portalAccessGranted({
      brand: agencyBrand,
      clientName: 'Pellowyn Dental',
      signInUrl: 'https://app.example.com/portal',
      agencyName: 'Wistholm IT',
    });

    expect(rendered.html).toContain('https://app.dmarcharbor.example/brand-logos/wistholm.png');
    // accentColor is the text on the brand colour, not a second fill.
    expect(pill(rendered.html)).toEqual({ fill: '#0f766e', label: '#fdfcf7' });
    expect(rendered.text).toContain('Wistholm IT');
  });

  it('picks ink or white for the button text by contrast when the agency set none', () => {
    const on = (primaryColor: string) =>
      pill(
        portalAccessGranted({
          brand: { workspaceName: 'Wistholm IT', primaryColor },
          clientName: 'Pellowyn Dental',
          signInUrl: 'https://app.example.com/portal',
          agencyName: 'Wistholm IT',
        }).html,
      );

    expect(on('#0f766e')).toEqual({ fill: '#0f766e', label: '#ffffff' });
    // A pale brand colour takes the Routes ink, not black and not white.
    expect(on('#f2b705')).toEqual({ fill: '#f2b705', label: '#15171b' });
    // A mid blue reads better in white (5.0:1) than in dark ink.
    expect(on('#2266dd')).toEqual({ fill: '#2266dd', label: '#ffffff' });
  });

  it('tells a portal contact how to sign in, truthfully', () => {
    const rendered = portalAccessGranted({
      brand: agencyBrand,
      clientName: 'Pellowyn Dental',
      signInUrl: 'https://reports.wistholm.example/portal',
      agencyName: 'Wistholm IT',
    });

    // Contacts sign in with an email address and a password. The old copy
    // promised there was no account to create and no password to remember.
    expect(rendered.text).toContain('Sign in with this email address');
    expect(rendered.text).toContain('The first time, choose Create an account and use this same address.');
    expect(rendered.text).not.toContain('no password');
    expect(rendered.text).not.toContain('no separate account');
    expect(rendered.text).toContain('https://reports.wistholm.example/portal');
  });

  it('falls back to product branding when an agency has none', () => {
    const rendered = portalAccessGranted({
      brand: { workspaceName: 'Wistholm IT' },
      clientName: 'Pellowyn Dental',
      signInUrl: 'https://app.example.com/portal',
      agencyName: 'Wistholm IT',
    });

    // No logo configured, so the workspace name stands in rather than a broken
    // image, and the button falls back to the Routes ink rather than rendering
    // an empty style.
    expect(rendered.html).not.toContain('<img');
    expect(rendered.html).toContain('Wistholm IT');
    expect(pill(rendered.html)).toEqual({ fill: '#15171b', label: '#ffffff' });
  });

  it('ignores a colour that is not a hex value', () => {
    const rendered = portalAccessGranted({
      brand: { workspaceName: 'Wistholm IT', primaryColor: 'red; background:url(javascript:alert(1))', accentColor: '#zzzzzz' },
      clientName: 'Pellowyn Dental',
      signInUrl: 'https://app.example.com/portal',
      agencyName: 'Wistholm IT',
    });

    expect(rendered.html).not.toContain('javascript:');
    expect(rendered.html).not.toContain('#zzzzzz');
    expect(pill(rendered.html)).toEqual({ fill: '#15171b', label: '#ffffff' });
  });

  it('ignores a text colour that has no brand colour to sit on', () => {
    const rendered = portalAccessGranted({
      brand: { workspaceName: 'Wistholm IT', accentColor: '#15171b' },
      clientName: 'Pellowyn Dental',
      signInUrl: 'https://app.example.com/portal',
      agencyName: 'Wistholm IT',
    });

    // Ink text on the ink button would be invisible.
    expect(pill(rendered.html)).toEqual({ fill: '#15171b', label: '#ffffff' });
  });

  it('keeps our own mail ink, whatever look it is handed', () => {
    const rendered = paymentFailedEmail({
      workspaceName: 'Wistholm IT',
      planLabel: 'Harbor',
      graceEndsAt: '2026-10-01T00:00:00.000Z',
      billingUrl: 'https://a.test/b',
    });

    expect(pill(rendered.html)).toEqual({ fill: '#15171b', label: '#ffffff' });
    expect(rendered.html).not.toContain('#0f766e');
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
