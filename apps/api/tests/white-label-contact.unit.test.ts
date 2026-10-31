import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { validateSupportEmail, validateSupportUrl } from '../src/services/branding.service.js';
import {
  isOurDomain,
  storedSendingDomainRecords,
  validateSendingAddress,
} from '../src/services/branding/sending-domain.service.js';
import { consoleSendingDomainProvider } from '../src/services/branding/sending-domain-provider.js';
import {
  clientContact,
  contactSentence,
  monthlyReportEmail,
  paymentFailedEmail,
  portalAccessGranted,
} from '../src/email/templates.js';

/**
 * The agency's support contact and its own sending address, checked at the
 * boundary. Both end up in mail headers or in our email provider's account,
 * so what is refused matters as much as what is accepted.
 */

describe('the support email', () => {
  it('accepts one plain address and lowercases only the domain', () => {
    expect(validateSupportEmail('help@wistholm.example')).toEqual({ email: 'help@wistholm.example' });
    expect(validateSupportEmail('  Help.Desk+clients@Wistholm.EXAMPLE ')).toEqual({ email: 'Help.Desk+clients@wistholm.example' });
  });

  it('refuses anything a mail client could read as more than one address, or as a second header', () => {
    const refused = [
      'Wistholm IT <help@wistholm.example>',
      '"help"@wistholm.example',
      'help@wistholm.example, other@wistholm.example',
      'help@wistholm.example;other@wistholm.example',
      'help @wistholm.example',
      'help@wistholm.example\r\nBcc: victim@elsewhere.example',
      'help\n@wistholm.example',
      'help@@wistholm.example',
      'help@wistholm',
      'help',
      '',
      `${'a'.repeat(250)}@wistholm.example`,
    ];

    for (const value of refused) {
      expect(validateSupportEmail(value), value).toEqual({
        error: 'The support email must be one address, for example help@youragency.example.',
      });
    }
  });
});

describe('the support page', () => {
  it('accepts an https address', () => {
    expect(validateSupportUrl('https://wistholm.example/help')).toEqual({ url: 'https://wistholm.example/help' });
    expect(validateSupportUrl(' https://Wistholm.example ')).toEqual({ url: 'https://wistholm.example/' });
  });

  it('refuses anything that is not a full https address', () => {
    expect(validateSupportUrl('http://wistholm.example/help')).toEqual({ error: 'The support page must be a full https address.' });
    expect(validateSupportUrl('wistholm.example/help')).toEqual({ error: 'The support page must be a full https address.' });
    expect(validateSupportUrl('javascript:alert(1)')).toEqual({ error: 'The support page must be a full https address.' });
    expect(validateSupportUrl('mailto:help@wistholm.example')).toEqual({ error: 'The support page must be a full https address.' });
  });

  it('refuses credentials and an address that is too long', () => {
    expect(validateSupportUrl('https://user:secret@wistholm.example/help')).toEqual({
      error: 'The support page must not include a username or password.',
    });
    expect('error' in validateSupportUrl(`https://wistholm.example/${'a'.repeat(500)}`)).toBe(true);
    expect('error' in validateSupportUrl('https://wistholm.example/help\r\nX: y')).toBe(true);
  });
});

describe('the sending address', () => {
  const original = {
    from: env.EMAIL_FROM,
    client: env.CLIENT_EMAIL_FROM_ADDRESS,
    app: env.APP_URL,
    auth: env.BETTER_AUTH_URL,
    cors: env.CORS_ORIGINS,
    aggregate: env.REPORT_AGGREGATE_ADDRESS,
    forensic: env.REPORT_FORENSIC_ADDRESS,
  };

  beforeEach(() => {
    env.EMAIL_FROM = 'DMARC Harbor <alerts@send.harbor.example>';
    env.CLIENT_EMAIL_FROM_ADDRESS = 'reports@mail-relay.example';
    env.APP_URL = 'https://app.harbor.example';
    env.BETTER_AUTH_URL = 'https://api.harbor.example';
    env.CORS_ORIGINS = ['https://app.harbor.example', 'https://console.harbor-web.example'];
    env.REPORT_AGGREGATE_ADDRESS = 'dmarc@reports.harbor.example';
    env.REPORT_FORENSIC_ADDRESS = 'ruf@reports.harbor.example';
  });

  afterEach(() => {
    env.EMAIL_FROM = original.from;
    env.CLIENT_EMAIL_FROM_ADDRESS = original.client;
    env.APP_URL = original.app;
    env.BETTER_AUTH_URL = original.auth;
    env.CORS_ORIGINS = original.cors;
    env.REPORT_AGGREGATE_ADDRESS = original.aggregate;
    env.REPORT_FORENSIC_ADDRESS = original.forensic;
  });

  it('splits one address on the agency domain, lowercased', () => {
    expect(validateSendingAddress('Reports@Mail.Wistholm.EXAMPLE')).toEqual({
      localPart: 'reports',
      domain: 'mail.wistholm.example',
    });
    expect(validateSendingAddress('client.reports+monthly@mail.pellowyn-dental.example')).toEqual({
      localPart: 'client.reports+monthly',
      domain: 'mail.pellowyn-dental.example',
    });
  });

  it('refuses a local part that starts or ends badly, or uses other characters', () => {
    for (const value of ['.reports@mail.wistholm.example', 'reports-@mail.wistholm.example', 'rep orts@mail.wistholm.example', 'r"@mail.wistholm.example']) {
      expect('error' in validateSendingAddress(value), value).toBe(true);
    }
  });

  it('refuses anything that is not one address on a plain hostname', () => {
    const refused = [
      'Wistholm IT <reports@mail.wistholm.example>',
      'reports@mail.wistholm.example, other@mail.wistholm.example',
      'reports@mail.wistholm.example\r\nBcc: victim@elsewhere.example',
      'reports@localhost',
      'reports@*.wistholm.example',
      'reports@mail_wistholm.example',
      'reports@-mail.wistholm.example',
      `reports@${'a'.repeat(64)}.example`,
      'reports',
      '',
    ];
    for (const value of refused) {
      expect('error' in validateSendingAddress(value), value).toBe(true);
    }
  });

  it('refuses every domain we send from or serve, and anything beneath one', () => {
    const ours = "That domain is ours, so it cannot be an agency's sending domain.";
    const refused = [
      'reports@send.harbor.example', // EMAIL_FROM
      'reports@deeper.send.harbor.example',
      'reports@mail-relay.example', // CLIENT_EMAIL_FROM_ADDRESS
      'reports@x.mail-relay.example',
      'reports@app.harbor.example', // APP_URL
      'reports@api.harbor.example', // BETTER_AUTH_URL
      'reports@mail.api.harbor.example',
      'reports@console.harbor-web.example', // a CORS origin
      'reports@reports.harbor.example', // a report mailbox
      // A parent of ours is refused too: no agency owns the zone ours live in.
      'reports@harbor.example',
    ];
    for (const value of refused) {
      expect(validateSendingAddress(value), value).toEqual({ error: ours });
    }

    expect(isOurDomain('mail.wistholm.example')).toBe(false);
    // A look-alike that merely ends in the same letters is not ours.
    expect('error' in validateSendingAddress('reports@notharbor.example')).toBe(false);
    expect('error' in validateSendingAddress('reports@mail-relay.example.wistholm.example')).toBe(false);
  });
});

describe('stored sending domain records', () => {
  it('reads back only well formed records', () => {
    expect(storedSendingDomainRecords(null)).toEqual([]);
    expect(storedSendingDomainRecords({ not: 'a list' })).toEqual([]);
    expect(
      storedSendingDomainRecords([
        { record: 'DKIM', type: 'TXT', name: 'resend._domainkey.mail.wistholm.example', value: 'p=abc', status: 'pending' },
        { record: 'SPF', type: 'MX', name: 'send.mail.wistholm.example', value: 'feedback.example', priority: 10, status: 'pending' },
        { record: 'SPF', type: 'TXT' },
        'nonsense',
      ]),
    ).toEqual([
      { record: 'DKIM', type: 'TXT', name: 'resend._domainkey.mail.wistholm.example', value: 'p=abc', priority: null, status: 'pending' },
      { record: 'SPF', type: 'MX', name: 'send.mail.wistholm.example', value: 'feedback.example', priority: 10, status: 'pending' },
    ]);
  });
});

describe('the console sending domain provider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns placeholder DKIM and SPF records for the domain, and never claims it verified', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const provider = consoleSendingDomainProvider();

    const created = await provider.create('mail.wistholm.example');

    expect(created.status).toBe('not_started');
    expect(created.records).toEqual([
      {
        record: 'DKIM',
        type: 'TXT',
        name: 'resend._domainkey.mail.wistholm.example',
        value: expect.stringContaining('PLACEHOLDER'),
        priority: null,
        status: 'not_started',
      },
      {
        record: 'SPF',
        type: 'MX',
        name: 'send.mail.wistholm.example',
        value: 'feedback-smtp.us-east-1.amazonses.com',
        priority: 10,
        status: 'not_started',
      },
      {
        record: 'SPF',
        type: 'TXT',
        name: 'send.mail.wistholm.example',
        value: 'v=spf1 include:amazonses.com ~all',
        priority: null,
        status: 'not_started',
      },
    ]);

    await provider.verify(created.id);
    const checked = await provider.get(created.id);
    expect(checked.status).toBe('pending');
    expect(checked.records.every((record) => record.status === 'pending')).toBe(true);

    await provider.verify(created.id);
    expect((await provider.get(created.id)).status).toBe('pending');

    // Removing is quiet, and an id from before a restart still resolves to its domain.
    await provider.remove(created.id);
    expect((await consoleSendingDomainProvider().get(created.id)).records[0]?.name).toBe('resend._domainkey.mail.wistholm.example');
    await expect(provider.get('someone-elses-id')).rejects.toThrow('Domain not found.');
  });
});

describe('the contact line on client mail', () => {
  it('says whichever of the address and page the agency published', () => {
    expect(contactSentence({ agencyName: 'Wistholm IT', email: 'help@wistholm.example', url: 'https://wistholm.example/help' })).toBe(
      'Questions? Contact Wistholm IT at help@wistholm.example or https://wistholm.example/help.',
    );
    expect(contactSentence({ agencyName: 'Wistholm IT', email: 'help@wistholm.example' })).toBe(
      'Questions? Contact Wistholm IT at help@wistholm.example.',
    );
    expect(contactSentence({ agencyName: 'Wistholm IT', url: 'https://wistholm.example/help' })).toBe(
      'Questions? Contact Wistholm IT at https://wistholm.example/help.',
    );
    expect(contactSentence({ agencyName: 'Wistholm IT' })).toBeNull();
    expect(contactSentence(null)).toBeNull();
    // Nothing that is not a usable address or an https page is printed.
    expect(contactSentence({ agencyName: 'Wistholm IT', email: 'not an address', url: 'javascript:alert(1)' })).toBeNull();
  });

  it('comes from the branding only under white label', () => {
    const branding = { workspaceName: 'Wistholm IT', supportEmail: 'help@wistholm.example', supportUrl: null };
    expect(clientContact({ ...branding, branded: true })).toEqual({
      agencyName: 'Wistholm IT',
      email: 'help@wistholm.example',
      url: null,
    });
    expect(clientContact({ ...branding, branded: false })).toBeNull();
    expect(clientContact({ ...branding, branded: true, supportEmail: null })).toBeNull();
    expect(clientContact(null)).toBeNull();
  });

  it('is rendered above the footer of a client message, escaped and linked', () => {
    const rendered = portalAccessGranted({
      brand: { workspaceName: 'Wistholm <IT>' },
      clientName: 'Pellowyn Dental',
      agencyName: 'Wistholm <IT>',
      signInUrl: 'https://reports.wistholm.example/portal',
      contact: { agencyName: 'Wistholm <IT>', email: 'help@wistholm.example', url: 'https://wistholm.example/help' },
    });

    expect(rendered.html).toContain('<a href="mailto:help@wistholm.example"');
    expect(rendered.html).toContain('<a href="https://wistholm.example/help"');
    expect(rendered.html).toContain('Questions? Contact Wistholm &lt;IT&gt; at');
    expect(rendered.html).not.toContain('Contact Wistholm <IT>');
    expect(rendered.text).toContain('Questions? Contact Wistholm <IT> at help@wistholm.example or https://wistholm.example/help.');
    // Above the footer in both parts.
    expect(rendered.text.indexOf('Questions?')).toBeLessThan(rendered.text.indexOf('This message was sent because'));
    expect(rendered.html.indexOf('Questions?')).toBeLessThan(rendered.html.indexOf('This message was sent because'));
  });

  it('is left off a monthly report that is not white labelled, and off staff mail', () => {
    const contact = { agencyName: 'Wistholm IT', email: 'help@wistholm.example' };
    const unbranded = monthlyReportEmail({
      brand: { workspaceName: 'Wistholm IT' },
      branded: false,
      agencyName: 'Wistholm IT',
      clientName: 'Pellowyn Dental',
      periodLabel: 'November 2026',
      messages: 10,
      passRate: '90%',
      domainsAtReject: 1,
      downloadUrl: 'https://app.harbor.example/reports/download?token=t',
      reference: 'MR-1',
      verifyUrl: 'https://app.harbor.example/verify?reference=MR-1',
      contact,
    });
    expect(unbranded.text).not.toContain('Questions?');

    const branded = monthlyReportEmail({
      brand: { workspaceName: 'Wistholm IT' },
      branded: true,
      agencyName: 'Wistholm IT',
      clientName: 'Pellowyn Dental',
      periodLabel: 'November 2026',
      messages: 10,
      passRate: '90%',
      domainsAtReject: 1,
      downloadUrl: 'https://reports.wistholm.example/reports/download?token=t',
      reference: 'MR-1',
      verifyUrl: 'https://reports.wistholm.example/verify?reference=MR-1',
      contact,
    });
    expect(branded.text).toContain('Questions? Contact Wistholm IT at help@wistholm.example.');

    const staff = paymentFailedEmail({
      workspaceName: 'Wistholm IT',
      planLabel: 'Harbor',
      graceEndsAt: '2026-12-01T00:00:00.000Z',
      billingUrl: 'https://app.harbor.example/billing',
    });
    expect(staff.text).not.toContain('Questions?');
  });
});
