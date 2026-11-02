import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every email the product sends, in the Routes design: a white page, ink type,
 * Albert Sans first in the font stack, red only on mail about a failure, and
 * the agency's colour on the button only under its white label.
 *
 * The text parts are pinned to the exact strings they were before the restyle.
 * The seed script reads the verification email's text from the console
 * provider and the integration tests read the reset link from the first URL in
 * the text, so a text part that drifts breaks more than a test.
 */

const enqueueEmail = vi.hoisted(() => vi.fn());
vi.mock('../src/services/email-queue.service.js', () => ({ enqueueEmail }));

const {
  clientContact,
  dnsChangesEmail,
  domainExpiryEmail,
  domainVerificationNotice,
  emailVerificationEmail,
  erasureCompletedEmail,
  erasureScheduledEmail,
  existingAccountSignUpEmail,
  exportReadyEmail,
  monthlyReportEmail,
  passwordResetEmail,
  paymentFailedEmail,
  planChangedEmail,
  planPausedFeaturesEmail,
  plainTextEmail,
  policyApprovalRequestedEmail,
  policyProposalDecidedEmail,
  portalAccessGranted,
  securityNoticeEmail,
  subscriptionCancelledEmail,
  workspaceInvitationEmail,
} = await import('../src/email/templates.js');
const { alertEmail, alertEmailBody, escalationSubject, rollupEmailBody, rollupEmailSubject } = await import(
  '../src/services/alert-email.js'
);
const { digestEmail, digestEnvelope, digestLines } = await import('../src/services/report-digest-text.js');
const { readDmarcRecord } = await import('../src/scanner/dmarc-tags.js');
const { queueAuthEmail } = await import('../src/email/email.service.js');

type Rendered = { subject: string; html: string; text: string };

const appUrl = 'https://app.dmarcharbor.example';
const when = '2026-12-14T09:30:00.000Z';
const agencyBrand = { workspaceName: 'Wistholm IT', primaryColor: '#0f766e', accentColor: null };
const agencyBranding = {
  branded: true,
  workspaceName: 'Wistholm IT',
  logoUrl: null,
  primaryColor: '#0f766e',
  accentColor: null,
  supportEmail: 'help@wistholm.example',
  supportUrl: null,
};
const contact = clientContact(agencyBranding);
const authAgency = { name: 'Wistholm IT', brand: agencyBrand, supportEmail: 'help@wistholm.example' };

const fontStack = "'Albert Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const red = '#d9342b';

const alertRule = {
  organizationName: 'Wistholm IT',
  domainName: 'pellowyn-dental.example',
  ruleName: 'Failure rate',
  metric: 'FAILURE_RATE',
  summary: '12% of 4,210 messages failed DMARC.',
  operator: 'GT',
  threshold: 5,
  windowMinutes: 60,
  reminderLevel: 1,
  maxReminderLevel: 3,
  spoofingSources: null,
};

const rollupEvents = [
  { domainName: 'pellowyn-dental.example', ruleName: 'Failure rate', summary: '12% failed DMARC' },
  { domainName: 'corriwick-cafe.example', ruleName: 'Report silence', summary: 'No reports for 52 hours' },
];

const digestFigures = {
  domain: { name: 'pellowyn-dental.example', score: 86, dmarcPolicy: 'quarantine', client: { name: 'Pellowyn Dental' } },
  insights: {
    aggregate: {
      reportCount: 41,
      messageCount: 11840,
      failedMessages: 96,
      dmarcPassRate: 99.2,
      spfPassRate: 97.4,
      dkimPassRate: 98.9,
      lastReportAt: '2026-12-14T06:02:11.000Z',
    },
    forensic: { count: 3, rejectedMessages: 3, affectedRecipients: 2, lastReportAt: null },
    sources: [
      { sourceIp: '40.107.22.53', failedMessages: 0, totalMessages: 8210, risk: 'low' as const },
      { sourceIp: '203.0.113.24', failedMessages: 64, totalMessages: 64, risk: 'high' as const },
    ],
  },
  readiness: { ready: false, level: 'reject' as const, blockers: ['One sender still fails DKIM alignment.'] },
  tags: readDmarcRecord('v=DMARC1; p=quarantine; rua=mailto:dmarc@reports.dmarcharbor.example'),
  includeForensics: true,
};

function digest(branded: boolean): Rendered {
  const envelope = digestEnvelope({
    domainName: 'pellowyn-dental.example',
    organizationName: 'Wistholm IT',
    branded,
    lines: digestLines({ ...digestFigures, branded }),
  });
  const text = branded ? `${envelope.text}\n\nQuestions? Contact Wistholm IT at help@wistholm.example.` : envelope.text;
  return digestEmail({ subject: envelope.subject, text, branding: branded ? agencyBranding : null });
}

/** Each message whose state is a failure, by name. Only these may use red. */
const failing = new Set(['domain-lost-verification', 'payment-failed', 'domain-expiry-expired']);

function everyRendering(): Array<[string, Rendered]> {
  return [
    ['workspace-invitation', workspaceInvitationEmail({ workspaceName: 'Wistholm IT', inviterName: 'Ffion', role: 'admin', signInUrl: `${appUrl}/welcome`, expiresAt: when })],
    ['portal-access', portalAccessGranted({ brand: { workspaceName: 'Wistholm IT' }, clientName: 'Pellowyn Dental', signInUrl: `${appUrl}/portal`, agencyName: 'Wistholm IT' })],
    ['portal-access-agency', portalAccessGranted({ brand: agencyBrand, clientName: 'Pellowyn Dental', signInUrl: 'https://reports.wistholm.example/portal', agencyName: 'Wistholm IT', contact })],
    [
      'policy-approval-request-agency',
      policyApprovalRequestedEmail({
        brand: agencyBrand,
        agencyName: 'Wistholm IT',
        clientName: 'Pellowyn Dental',
        domainName: 'pellowyn-dental.example',
        headline: 'Move pellowyn-dental.example to p=reject',
        effect: 'Mail that fails DMARC is refused.',
        trial: null,
        risk: 'A misconfigured sender would have its mail refused.',
        evidence: null,
        note: null,
        openPoints: ['One sender not seen yet.'],
        expiresAt: when,
        url: 'https://reports.wistholm.example/portal/domain/d1',
        contact,
      }),
    ],
    ['policy-decided-approved', policyProposalDecidedEmail({ workspaceName: 'Wistholm IT', title: 'Approved', body: 'Pellowyn Dental approved the change.', url: `${appUrl}/domains/d`, decision: 'approved' })],
    ['policy-decided-declined', policyProposalDecidedEmail({ workspaceName: 'Wistholm IT', title: 'Declined', body: 'Pellowyn Dental declined the change.', url: `${appUrl}/domains/d`, decision: 'declined' })],
    ['dns-changes', dnsChangesEmail({ workspaceName: 'Wistholm IT', appUrl, changes: [{ domainName: 'pellowyn-dental.example', domainSlug: 'p', summary: 'The policy changed.' }] })],
    ['domain-expiry', domainExpiryEmail({ workspaceName: 'Wistholm IT', appUrl, domains: [{ domainSlug: 'p', sentence: 'pellowyn-dental.example: The registration expires in 14 days.', registrar: null }] })],
    ['domain-expiry-expired', domainExpiryEmail({ workspaceName: 'Wistholm IT', appUrl, domains: [{ domainSlug: 'p', sentence: 'pellowyn-dental.example: The registration expired.', registrar: null, expired: true }] })],
    ...(['', '-agency'] as const).map((suffix): [string, Rendered] => [
      `monthly-report${suffix}`,
      monthlyReportEmail({
        brand: suffix ? agencyBrand : { workspaceName: 'Wistholm IT' },
        branded: Boolean(suffix),
        agencyName: 'Wistholm IT',
        clientName: 'Pellowyn Dental',
        periodLabel: 'November 2026',
        messages: 1200,
        passRate: '99%',
        domainsAtReject: 1,
        downloadUrl: `${appUrl}/reports/download?token=t`,
        reference: 'MR-1',
        verifyUrl: `${appUrl}/verify?reference=MR-1`,
        contact: suffix ? contact : null,
      }),
    ]),
    ['domain-verified', domainVerificationNotice({ workspaceName: 'W', domainName: 'pellowyn-dental.example', verified: true, appUrl })],
    ['domain-lost-verification', domainVerificationNotice({ workspaceName: 'W', domainName: 'pellowyn-dental.example', verified: false, appUrl })],
    ['payment-failed', paymentFailedEmail({ workspaceName: 'W', planLabel: 'Harbor', graceEndsAt: when, billingUrl: `${appUrl}/b` })],
    ['subscription-cancelled', subscriptionCancelledEmail({ workspaceName: 'W', planLabel: 'Harbor', accessUntil: when, billingUrl: `${appUrl}/b` })],
    ['plan-changed', planChangedEmail({ workspaceName: 'W', fromLabel: 'Fairway', toLabel: 'Harbor', effectiveAt: when, timing: 'immediate', billingUrl: `${appUrl}/b` })],
    ['plan-paused', planPausedFeaturesEmail({ workspaceName: 'W', planLabel: 'Fairway', hostedRecords: ['1 hosted DMARC record'], sso: null, appUrl, billingUrl: `${appUrl}/b` })],
    ['export-ready', exportReadyEmail({ workspaceName: 'W', scopeLabel: 'workspace', downloadUrl: `${appUrl}/e`, expiresAt: when })],
    ['erasure-scheduled', erasureScheduledEmail({ workspaceName: 'W', scopeLabel: 'client', executesAt: when, cancelUrl: `${appUrl}/x` })],
    ['erasure-completed', erasureCompletedEmail({ workspaceName: 'W', scopeLabel: 'client', completedAt: when })],
    ['password-reset', passwordResetEmail({ url: `${appUrl}/api/auth/reset-password/t` })],
    ['password-reset-agency', passwordResetEmail({ url: 'https://reports.wistholm.example/api/auth/reset-password/t', agency: authAgency })],
    ['email-verification', emailVerificationEmail({ url: `${appUrl}/api/auth/verify-email?token=t` })],
    ['email-verification-agency', emailVerificationEmail({ url: 'https://reports.wistholm.example/api/auth/verify-email?token=t', agency: authAgency })],
    ['existing-account', existingAccountSignUpEmail()],
    ['security-notice', securityNoticeEmail({ subject: 'Two-step verification was turned on', notice: 'Two-step verification was turned on for your DMARC Harbor account.', appUrl })],
    ['alert', alertEmail({ subject: escalationSubject({ domain: { name: 'pellowyn-dental.example' }, name: 'Failure rate' }, 1), body: alertEmailBody(alertRule), kind: 'ALERT', appUrl })],
    ['alert-rollup', alertEmail({ subject: rollupEmailSubject(2), body: rollupEmailBody({ organizationName: 'Wistholm IT', outstanding: rollupEvents }), kind: 'ROLLUP', appUrl })],
    ['digest', digest(false)],
    ['digest-agency', digest(true)],
    ['plain-text', plainTextEmail({ subject: 'Plain', text: 'One paragraph.\n\nAnother.' })],
  ];
}

describe('the Routes look on every message', () => {
  it('has none of the old slate palette', () => {
    for (const [name, rendered] of everyRendering()) {
      for (const old of ['#f1f5f9', '#0f172a', '#0ea5e9', '#f8fafc', '#334155', '#64748b', '#475569', '#e2e8f0']) {
        expect(rendered.html.toLowerCase(), `${name} still uses ${old}`).not.toContain(old);
      }
    }
  });

  it('is a white page in Albert Sans, light only, with no shadow, gradient or remote font', () => {
    for (const [name, rendered] of everyRendering()) {
      expect(rendered.html, name).toContain(fontStack);
      expect(rendered.html, name).toContain('<body style="margin:0;padding:0;background:#ffffff;');
      expect(rendered.html, name).toContain('<meta name="color-scheme" content="light">');
      expect(rendered.html, name).not.toMatch(/box-shadow|linear-gradient|radial-gradient/);
      // A remote font request would hand every reader's IP address to its host.
      expect(rendered.html, name).not.toMatch(/fonts\.googleapis|@import|@font-face|<link/i);
      expect(rendered.html, name).toContain('<html');
      expect(rendered.html, name).toContain('</html>');
    }
  });

  it('uses red only on mail about a failure', () => {
    for (const [name, rendered] of everyRendering()) {
      if (failing.has(name)) {
        expect(rendered.html, name).toContain(red);
      } else {
        expect(rendered.html, name).not.toContain(red);
      }
    }
  });

  it('says each state with a word and a shape', () => {
    const states = Object.fromEntries(everyRendering());
    expect(states['payment-failed']!.html).toContain('&#9670;</span>&nbsp;&nbsp;Payment failed');
    expect(states['domain-verified']!.html).toContain('&#9632;</span>&nbsp;&nbsp;Verified');
    expect(states['domain-lost-verification']!.html).toContain('&#9670;</span>&nbsp;&nbsp;Not verified');
    expect(states['erasure-scheduled']!.html).toContain('&#9679;</span>&nbsp;&nbsp;Scheduled');
    expect(states['policy-decided-declined']!.html).toContain('&#9675;</span>&nbsp;&nbsp;Declined');
    expect(states['dns-changes']!.html).toContain('&#9679;</span>&nbsp;&nbsp;Changed');
    expect(states['domain-expiry-expired']!.html).toContain('&#9670;</span>&nbsp;&nbsp;Expired');
  });

  it('names its kind in the masthead beside the sender', () => {
    const all = Object.fromEntries(everyRendering());
    expect(all['payment-failed']!.html).toContain('>DMARC Harbor</span>&ensp;<span style="font-weight:400;color:#6c717a;">Billing</span>');
    expect(all['digest-agency']!.html).toContain('>Wistholm IT</span>&ensp;<span style="font-weight:400;color:#6c717a;">Domain summary</span>');
    expect(all['alert']!.html).toContain('>Alerts</span>');
  });
});

describe('the button under white label', () => {
  it('takes the agency primary colour and ink or white by contrast', () => {
    const all = Object.fromEntries(everyRendering());
    for (const name of ['portal-access-agency', 'policy-approval-request-agency', 'monthly-report-agency', 'password-reset-agency', 'email-verification-agency']) {
      const html = all[name]!.html;
      expect(html, name).toContain('bgcolor="#0f766e" style="border-radius:999px;background:#0f766e;"');
      expect(html, name).toMatch(/border-radius:999px;background:#0f766e;"><a href="[^"]+" style="[^"]*;color:#ffffff;/);
    }
    // A digest has no button (its readers may have no portal account), so the
    // agency's colour is on its links.
    expect(all['digest-agency']!.html).toContain('<a href="mailto:help@wistholm.example" style="color:#0f766e;');
  });

  it('stays ink on our own mail, and on client mail without white label', () => {
    for (const name of ['payment-failed', 'monthly-report', 'password-reset', 'alert', 'digest']) {
      const html = Object.fromEntries(everyRendering())[name]!.html;
      expect(html, name).not.toContain('#0f766e');
    }
  });

  it('keeps links ink when the brand colour is too pale to read on white', () => {
    const pale = portalAccessGranted({
      brand: { workspaceName: 'Wistholm IT', primaryColor: '#f2b705' },
      clientName: 'Pellowyn Dental',
      signInUrl: 'https://reports.wistholm.example/portal',
      agencyName: 'Wistholm IT',
      contact: { agencyName: 'Wistholm IT', email: 'help@wistholm.example' },
    });
    expect(pale.html).toContain('<a href="mailto:help@wistholm.example" style="color:#15171b;');
    // The button still wears it, with ink on it.
    expect(pale.html).toMatch(/background:#f2b705;"><a href="[^"]+" style="[^"]*;color:#15171b;/);

    const readable = portalAccessGranted({
      brand: agencyBrand,
      clientName: 'Pellowyn Dental',
      signInUrl: 'https://reports.wistholm.example/portal',
      agencyName: 'Wistholm IT',
      contact: { agencyName: 'Wistholm IT', email: 'help@wistholm.example' },
    });
    expect(readable.html).toContain('<a href="mailto:help@wistholm.example" style="color:#0f766e;');
  });
});

describe('account mail', () => {
  const url = 'https://api.dmarcharbor.example/api/auth/reset-password/tok?callbackURL=%2Fsign-in';
  const agencyUrl = 'https://reports.wistholm.example/api/auth/reset-password/tok?callbackURL=%2Fsign-in';

  it('keeps every subject and text part exactly as it was', () => {
    expect(passwordResetEmail({ url })).toMatchObject({
      subject: 'Reset your DMARC Harbor password',
      text: `Reset your password using this link: ${url}\n\nIf you did not request this, you can ignore this email.`,
    });
    expect(passwordResetEmail({ url: agencyUrl, agency: { name: 'Wistholm IT' } })).toMatchObject({
      subject: 'Reset your password for Wistholm IT',
      text: `Reset your password using this link: ${agencyUrl}\n\nIf you did not request this, you can ignore this email.`,
    });
    expect(passwordResetEmail({ url: agencyUrl, agency: authAgency })).toMatchObject({
      subject: 'Reset your password for Wistholm IT',
      text: `Reset your password using this link: ${agencyUrl}\n\nIf you did not request this, you can ignore this email.\n\nQuestions? Contact Wistholm IT at help@wistholm.example.`,
    });

    const verify = 'https://api.dmarcharbor.example/api/auth/verify-email?token=jwt.part.sig';
    expect(emailVerificationEmail({ url: verify })).toMatchObject({
      subject: 'Verify your DMARC Harbor email',
      text: `Verify your email address using this link: ${verify}\n\nThe link expires in 24 hours.`,
    });
    expect(emailVerificationEmail({ url: verify, agency: { name: 'Wistholm IT' } })).toMatchObject({
      subject: 'Verify your email for Wistholm IT',
      text: `Verify your email address for Wistholm IT using this link: ${verify}\n\nThe link expires in 24 hours.`,
    });
    expect(emailVerificationEmail({ url: verify, agency: authAgency })).toMatchObject({
      subject: 'Verify your email for Wistholm IT',
      text: `Verify your email address for Wistholm IT using this link: ${verify}\n\nThe link expires in 24 hours.\n\nQuestions? Contact Wistholm IT at help@wistholm.example.`,
    });

    expect(existingAccountSignUpEmail()).toMatchObject({
      subject: 'Someone tried to sign up with your email',
      text: 'Someone tried to create an account using this email address. If this was you, sign in instead. If not, you can ignore this email.',
    });

    const footer = 'If this was not you, reset your password and contact your workspace owner.';
    for (const [subject, notice] of [
      ['Two-step verification was turned on', 'Two-step verification was turned on for your DMARC Harbor account.'],
      ['Two-step verification was turned off', 'Two-step verification was turned off for your DMARC Harbor account.'],
      ['A backup code was used to sign in', 'A backup code was used to sign in. 2 left. Generate new ones in Account security.'],
      ['New backup codes were generated', 'New backup codes were generated; the old ones no longer work.'],
      ['Your two-step verification was reset', 'Your two-step verification was reset by an owner of Wistholm IT. Sign in with your password and set it up again.'],
      ['Your two-step verification was reset', 'Your two-step verification was reset by DMARC Harbor support. Sign in with your password and set it up again.'],
    ] as const) {
      expect(securityNoticeEmail({ subject, notice, appUrl })).toMatchObject({ subject, text: `${notice}\n\n${footer}` });
    }
  });

  it('keeps the seed script able to find the verification token', () => {
    // apps/web/scripts/seed.mjs: the subject, then "?token=" within 400 characters.
    const rendered = emailVerificationEmail({ url: 'http://localhost:4000/api/auth/verify-email?token=abc.def&callbackURL=%2F' });
    expect(`${rendered.subject} for owner@dmarcharbor.test\n${rendered.text}`).toMatch(
      /Verify your DMARC Harbor email for owner@dmarcharbor\.test[\s\S]{0,400}?\?(?:amp;)?token=([A-Za-z0-9_.-]+)/,
    );
  });

  it("puts an agency's reset in the agency's name, button and contact line, and never ours", () => {
    const rendered = passwordResetEmail({ url: agencyUrl, agency: authAgency });
    expect(rendered.html).not.toContain('DMARC Harbor');
    expect(rendered.html).toContain('>Wistholm IT</span>');
    expect(rendered.html).toContain(`<a href="${agencyUrl.replace(/&/g, '&amp;')}" style="display:inline-block;`);
    expect(rendered.html).toContain('<a href="mailto:help@wistholm.example"');
    expect(rendered.html.indexOf('Questions?')).toBeLessThan(rendered.html.indexOf('If you did not request this'));
  });

  it('names no product in the existing-account warning, in either part', () => {
    const rendered = existingAccountSignUpEmail();
    for (const part of [rendered.subject, rendered.text, rendered.html]) {
      expect(part).not.toMatch(/DMARC Harbor|dmarcharbor/i);
    }
    // No button: the hook is not told which host the attempt came from.
    expect(rendered.html).not.toContain('border-radius:999px');
    expect(rendered.html).toContain('>Account security</p>');
  });

  it('gives a security notice a way to Account security', () => {
    const rendered = securityNoticeEmail({ subject: 'New backup codes were generated', notice: 'New backup codes were generated; the old ones no longer work.', appUrl: `${appUrl}/` });
    expect(rendered.html).toContain(`<a href="${appUrl}/account/security"`);
    expect(rendered.html).toContain('If this was not you');
  });
});

describe('plain text as Routes HTML', () => {
  it('keeps the text part exactly and sets paragraphs, line breaks and links', () => {
    const text = 'First line\nsecond line.\n\nSee https://app.dmarcharbor.example/alerts. Thanks & bye.';
    const rendered = plainTextEmail({ subject: '[DMARC Harbor] Something happened', text, kind: 'Alerts' });

    expect(rendered.text).toBe(text);
    expect(rendered.subject).toBe('[DMARC Harbor] Something happened');
    // The tag is dropped from the heading; the masthead already names the sender.
    expect(rendered.html).toContain('>Something happened</h1>');
    expect(rendered.html).toContain('First line<br>second line.</p>');
    expect(rendered.html).toContain(
      'See <a href="https://app.dmarcharbor.example/alerts" style="color:#15171b;text-decoration:underline;word-break:break-all;">https://app.dmarcharbor.example/alerts</a>. Thanks &amp; bye.',
    );
  });

  it('sets column-aligned lines in mono, one column per run of spaces', () => {
    const text = [
      'Top sources:',
      '  40.107.22.53  0 failed DMARC / 8210 total  (low risk)',
      '  203.0.113.24  64 failed DMARC / 64 total  (high risk)',
      '  ...and 3 more',
    ].join('\n');
    const rendered = plainTextEmail({ subject: 'Summary', text });

    expect(rendered.text).toBe(text);
    expect(rendered.html).toContain(">40.107.22.53</td>");
    expect(rendered.html).toContain('>64 failed DMARC / 64 total</td>');
    expect(rendered.html).toContain('colspan="3"');
    expect(rendered.html).toMatch(/font-family:'Atkinson Hyperlegible Mono'[^"]*">\(high risk\)<\/td>/);
    // The heading line of the table stays in the body face.
    expect(rendered.html).toContain('>Top sources:</p>');
  });

  it('leaves a sentence with a double space in the body face', () => {
    const rendered = plainTextEmail({ subject: 'Note', text: 'One sentence.  Another one.' });
    expect(rendered.html).not.toContain('<td valign="top" style="padding:5px');
    expect(rendered.html).toContain('One sentence.  Another one.</p>');
  });

  it('escapes everything it is given', () => {
    const rendered = plainTextEmail({
      subject: '<b>Subject</b>',
      text: '<script>alert(1)</script>\n\n  a<b>  c"d\n  e  f',
      brand: { workspaceName: 'Wistholm <IT>' },
      whiteLabel: true,
      action: { label: 'Go "now"', url: 'https://x.example/"onmouseover="alert(1)' },
    });
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).not.toContain('<b>');
    expect(rendered.html).toContain('&lt;script&gt;');
    expect(rendered.html).toContain('Wistholm &lt;IT&gt;');
    expect(rendered.html).not.toContain('"onmouseover="');
    expect(rendered.html).toContain('Go &quot;now&quot;');
  });

  it('shows the contact line once, linked, when the text ends with it', () => {
    const rendered = digest(true);
    expect(rendered.text.endsWith('Questions? Contact Wistholm IT at help@wistholm.example.')).toBe(true);
    expect(rendered.html.split('Questions? Contact').length - 1).toBe(1);
    expect(rendered.html).toContain('<a href="mailto:help@wistholm.example"');
    expect(rendered.html).not.toContain('DMARC Harbor');
    expect(digest(false).html).toContain('>DMARC Harbor</span>');
  });

  it('renders text-only transport mail through the same layout', () => {
    enqueueEmail.mockClear();
    queueAuthEmail({ to: 'it@pellowyn.example', subject: 'A notice', text: 'Line one.\n\nLine two.', kind: 'Account security' });
    const queued = enqueueEmail.mock.calls[0]![0] as { html: string; text: string };
    expect(queued.text).toBe('Line one.\n\nLine two.');
    expect(queued.html).toContain(fontStack);
    expect(queued.html).toContain('>Line two.</p>');
    // The old body was nested paragraphs in a generic sans-serif.
    expect(queued.html).not.toContain('font-family:sans-serif');
    expect(queued.html).not.toMatch(/<p[^>]*><p/);
  });

  it('passes a template\'s own HTML through untouched', () => {
    enqueueEmail.mockClear();
    const rendered = passwordResetEmail({ url: 'https://api.dmarcharbor.example/r' });
    queueAuthEmail({ to: 'it@pellowyn.example', ...rendered });
    expect(enqueueEmail.mock.calls[0]![0]).toMatchObject({ kind: 'auth', html: rendered.html, text: rendered.text, subject: rendered.subject });
  });
});

describe('alert wording', () => {
  beforeEach(() => enqueueEmail.mockClear());

  it('is the text alert.service.ts always sent', () => {
    expect(alertEmailBody(alertRule)).toBe(
      [
        'Workspace: Wistholm IT',
        'Domain: pellowyn-dental.example',
        'Alert: Failure rate (FAILURE_RATE)',
        '12% of 4,210 messages failed DMARC.',
        'Threshold: GT 5',
        'Window: 60 minutes',
        'This is the first notification.',
        'Review and acknowledge this alert in DMARC Harbor.',
      ].join('\n'),
    );

    expect(alertEmailBody({ ...alertRule, reminderLevel: 2 })).toContain(
      'Reminder 2 of 3\nNobody has acknowledged this alert yet. If someone is already handling it, acknowledge it to stop further reminders.\n',
    );

    expect(
      alertEmailBody({
        ...alertRule,
        spoofingSources: [
          {
            senderKey: 'k',
            senderDomain: 'mail.lookalike.example',
            serviceName: null,
            totalMessages: 40,
            failedMessages: 40,
            sourceIps: ['203.0.113.7'],
            firstSeenAt: '2026-11-02T08:00:00.000Z',
          },
        ],
      }),
    ).toContain(
      'Window: 60 minutes\nSending sources to check:\n  mail.lookalike.example: 40 of 40 messages failed both SPF and DKIM, from 203.0.113.7, first seen 2026-11-02.\nIf the domain owner confirms this is not their service, move to p=reject to stop it.\nThis is the first notification.',
    );

    expect(escalationSubject({ domain: { name: 'pellowyn-dental.example' }, name: 'Failure rate' }, 3)).toBe(
      '[DMARC Harbor] URGENT unacknowledged: pellowyn-dental.example Failure rate',
    );
  });

  it('pads the rollup into columns, and keeps them in the HTML', () => {
    const body = rollupEmailBody({ organizationName: 'Wistholm IT', outstanding: rollupEvents });
    expect(rollupEmailSubject(2)).toBe('[DMARC Harbor] 2 unacknowledged alerts');
    expect(body).toBe(
      [
        'Workspace: Wistholm IT',
        '2 alerts remain unacknowledged after their reminder sequence finished.',
        `  pellowyn-dental.example${' '.repeat(8)}Failure rate${' '.repeat(17)}12% failed DMARC`,
        `  corriwick-cafe.example${' '.repeat(9)}Report silence${' '.repeat(15)}No reports for 52 hours`,
        'These alerts have already been sent to the people who own each rule.',
        'Review them in DMARC Harbor and acknowledge, adjust, or disable the rule.',
      ].join('\n'),
    );

    const rendered = alertEmail({ subject: rollupEmailSubject(2), body, kind: 'ROLLUP', appUrl: `${appUrl}/` });
    expect(rendered.text).toBe(body);
    expect(rendered.html).toContain('>pellowyn-dental.example</td>');
    expect(rendered.html).toContain('>Report silence</td>');
    expect(rendered.html).toContain(`<a href="${appUrl}/alerts"`);
    expect(rendered.html).toContain('>Review the alerts</a>');
  });
});

describe('digest wording', () => {
  it('is the text report-digest.service.ts always built', () => {
    const lines = digestLines({ ...digestFigures, branded: true });
    expect(lines).toEqual([
      'Domain: pellowyn-dental.example',
      'Client: Pellowyn Dental',
      'Policy: quarantine',
      'Health score: 86',
      '',
      'Messages observed: 11840',
      'Failed DMARC: 96',
      'DMARC pass rate: 99.2%',
      'SPF pass rate: 97.4%',
      'DKIM pass rate: 98.9%',
      'Aggregate reports received: 41',
      'Last report: 2026-12-14T06:02:11.000Z',
      '',
      'Recommendation: stay on p=none',
      'Outstanding:',
      '  - One sender still fails DKIM alignment.',
      '',
      'Top sources:',
      '  40.107.22.53  0 failed DMARC / 8210 total  (low risk)',
      '  203.0.113.24  64 failed DMARC / 64 total  (high risk)',
      '',
      'Forensic failures:',
      '  Reports: 3',
      '  Rejected or quarantined: 3',
      '  Distinct recipients affected: 2',
    ]);

    const noRua = digestLines({ ...digestFigures, tags: readDmarcRecord('v=DMARC1; p=none'), includeForensics: false, branded: false });
    expect(noRua.slice(-2)).toEqual(['', 'Warning: this domain has no rua= address, so reports cannot arrive.']);
  });
});
