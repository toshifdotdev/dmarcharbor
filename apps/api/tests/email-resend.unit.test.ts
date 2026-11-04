import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { isUnverifiedSenderDomain, sendEmail } from '../src/email/email.service.js';
import { UndeliverableRecipientError } from '../src/email/reserved-recipient.js';
import { SendingDomainProviderError, resendSendingDomainProvider } from '../src/services/branding/sending-domain-provider.js';

/**
 * What reaches Resend, with the SDK replaced: the Reply-To on client mail, the
 * fallback to the shared address when an agency's own domain is refused, and
 * the domain API the sending-domain feature uses.
 */
const resend = vi.hoisted(() => ({
  keys: [] as string[],
  sends: [] as Array<{ payload: Record<string, unknown>; options: unknown }>,
  sendAnswers: [] as Array<{ data: unknown; error: unknown }>,
  domainCalls: [] as Array<{ method: string; argument: unknown }>,
  domainAnswer: null as null | ((method: string, argument: unknown) => { data: unknown; error: unknown }),
}));

vi.mock('resend', () => ({
  Resend: class {
    emails: { send: (payload: Record<string, unknown>, options?: unknown) => Promise<{ data: unknown; error: unknown }> };
    domains: Record<string, (argument: unknown) => Promise<{ data: unknown; error: unknown }>>;

    constructor(key: string) {
      resend.keys.push(key);
      this.emails = {
        send: async (payload, options) => {
          resend.sends.push({ payload, options });
          return resend.sendAnswers.shift() ?? { data: { id: 'email_1' }, error: null };
        },
      };
      const domain = (method: string) => async (argument: unknown) => {
        resend.domainCalls.push({ method, argument });
        return resend.domainAnswer ? resend.domainAnswer(method, argument) : { data: { id: 'domain_1' }, error: null };
      };
      this.domains = { create: domain('create'), get: domain('get'), verify: domain('verify'), remove: domain('remove') };
    }
  },
}));

const original = {
  provider: env.EMAIL_PROVIDER,
  key: env.RESEND_API_KEY,
  domainsKey: env.RESEND_DOMAINS_API_KEY,
  client: env.CLIENT_EMAIL_FROM_ADDRESS,
  from: env.EMAIL_FROM,
};

beforeEach(() => {
  env.EMAIL_PROVIDER = 'resend';
  env.RESEND_API_KEY = 're_sending_only';
  env.RESEND_DOMAINS_API_KEY = undefined;
  env.CLIENT_EMAIL_FROM_ADDRESS = 'reports@mail-relay.example';
  env.EMAIL_FROM = 'DMARC Harbor <alerts@harbor.example>';
  resend.keys.length = 0;
  resend.sends.length = 0;
  resend.sendAnswers.length = 0;
  resend.domainCalls.length = 0;
  resend.domainAnswer = null;
});

afterEach(() => {
  env.EMAIL_PROVIDER = original.provider;
  env.RESEND_API_KEY = original.key;
  env.RESEND_DOMAINS_API_KEY = original.domainsKey;
  env.CLIENT_EMAIL_FROM_ADDRESS = original.client;
  env.EMAIL_FROM = original.from;
  vi.restoreAllMocks();
});

// A real domain on purpose: mail to a reserved one never reaches the provider
// (the last test in the first block). The SDK is mocked, so nothing is sent.
const message = {
  to: 'dmarcharbor+pellowyn@gmail.com',
  subject: 'Pellowyn Dental email authentication report, November 2026',
  html: '<p>Report</p>',
  text: 'Report',
};

const unverified = {
  data: null,
  error: {
    name: 'validation_error',
    statusCode: 403,
    message: 'The mail.wistholm.example domain is not verified. Please, add and verify your domain on https://resend.com/domains',
  },
};

describe('sending through Resend', () => {
  it('passes the Reply-To when there is one, and none otherwise', async () => {
    await sendEmail({ ...message, from: '"Wistholm IT" <reports@mail-relay.example>', replyTo: 'help@wistholm.example' });
    await sendEmail(message);

    expect(resend.sends[0]?.payload).toMatchObject({
      from: '"Wistholm IT" <reports@mail-relay.example>',
      replyTo: 'help@wistholm.example',
    });
    expect(resend.sends[1]?.payload.from).toBe('DMARC Harbor <alerts@harbor.example>');
    expect(resend.sends[1]?.payload).not.toHaveProperty('replyTo');
  });

  it("sends once more from the shared address when the agency's domain is refused as unverified", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    resend.sendAnswers.push(unverified);

    await sendEmail({
      ...message,
      from: '"Wistholm IT" <reports@mail.wistholm.example>',
      replyTo: 'help@wistholm.example',
      idempotencyKey: 'monthly-report:s1:2026-11:it@pellowyn.example',
    });

    expect(resend.sends).toHaveLength(2);
    expect(resend.sends[0]?.payload.from).toBe('"Wistholm IT" <reports@mail.wistholm.example>');
    expect(resend.sends[0]?.options).toEqual({ idempotencyKey: 'monthly-report:s1:2026-11:it@pellowyn.example' });
    // Same name and Reply-To, shared address, and a key Resend has not seen
    // with a different payload.
    expect(resend.sends[1]?.payload).toMatchObject({
      from: '"Wistholm IT" <reports@mail-relay.example>',
      replyTo: 'help@wistholm.example',
      to: message.to,
    });
    expect(resend.sends[1]?.options).toEqual({ idempotencyKey: 'monthly-report:s1:2026-11:it@pellowyn.example:shared-from' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mail.wistholm.example'));
  });

  it('retries without a key when the message had none', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    resend.sendAnswers.push(unverified);

    await sendEmail({ ...message, from: '"Wistholm IT" <reports@mail.wistholm.example>' });

    expect(resend.sends).toHaveLength(2);
    expect(resend.sends[1]?.options).toBeUndefined();
  });

  it('throws when the retry fails too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    resend.sendAnswers.push(unverified, {
      data: null,
      error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests.' },
    });

    await expect(sendEmail({ ...message, from: '"Wistholm IT" <reports@mail.wistholm.example>' })).rejects.toThrow(
      'Resend email delivery failed: Too many requests.',
    );
    expect(resend.sends).toHaveLength(2);
  });

  it('does not retry any other refusal', async () => {
    resend.sendAnswers.push({
      data: null,
      error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests.' },
    });

    await expect(sendEmail({ ...message, from: '"Wistholm IT" <reports@mail.wistholm.example>' })).rejects.toThrow(
      'Too many requests.',
    );
    expect(resend.sends).toHaveLength(1);
  });

  it('does not retry when the message was already on the shared address, or had no From of its own', async () => {
    resend.sendAnswers.push(unverified);
    await expect(sendEmail({ ...message, from: '"Wistholm IT" <reports@mail-relay.example>' })).rejects.toThrow('is not verified');
    expect(resend.sends).toHaveLength(1);

    resend.sendAnswers.push(unverified);
    await expect(sendEmail(message)).rejects.toThrow('is not verified');
    expect(resend.sends).toHaveLength(2);
  });

  it('never hands a reserved-domain recipient to Resend', async () => {
    for (const to of ['toshif@dmarcharbor.test', 'it@pellowyn.example', 'x@verify.invalid', 'owner@example.com']) {
      const failure = await sendEmail({ ...message, to }).catch((error: unknown) => error);
      expect(failure, to).toBeInstanceOf(UndeliverableRecipientError);
    }
    expect(resend.sends).toHaveLength(0);
    expect(resend.keys).toHaveLength(0);
  });

  it('recognises the unverified-domain refusal by its words', () => {
    expect(isUnverifiedSenderDomain(unverified.error)).toBe(true);
    expect(isUnverifiedSenderDomain({ name: 'validation_error', message: 'The WISTHOLM.EXAMPLE DOMAIN IS NOT VERIFIED.' })).toBe(true);
    expect(isUnverifiedSenderDomain({ name: 'validation_error', message: 'Domain verification is pending.' })).toBe(true);
    expect(isUnverifiedSenderDomain({ name: 'validation_error', message: 'Invalid `to` field.' })).toBe(false);
    expect(isUnverifiedSenderDomain({ name: 'rate_limit_exceeded', message: 'Too many requests.' })).toBe(false);
  });
});

describe('sending through the console', () => {
  it('prints the Reply-To with the From', async () => {
    env.EMAIL_PROVIDER = 'console';
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await sendEmail({ ...message, from: '"Wistholm IT" <reports@mail-relay.example>', replyTo: 'help@wistholm.example' });

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('from "Wistholm IT" <reports@mail-relay.example> reply-to help@wistholm.example'),
    );
    expect(resend.sends).toHaveLength(0);
  });
});

describe('the Resend sending domain provider', () => {
  const createdDomain = {
    id: 'd_123',
    name: 'mail.wistholm.example',
    status: 'not_started',
    records: [
      { record: 'SPF', name: 'send.mail.wistholm.example', type: 'MX', ttl: 'Auto', status: 'not_started', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 },
      { record: 'SPF', name: 'send.mail.wistholm.example', type: 'TXT', ttl: 'Auto', status: 'not_started', value: 'v=spf1 include:amazonses.com ~all' },
      { record: 'DKIM', name: 'resend._domainkey.mail.wistholm.example', type: 'TXT', ttl: 'Auto', status: 'not_started', value: 'p=MIGf' },
      { record: 'Receiving', name: 'mail.wistholm.example', type: 'MX', ttl: 'Auto', status: 'not_started', value: 'inbound-smtp.example', priority: 10 },
      { record: 'Tracking', name: 'links.mail.wistholm.example', type: 'CNAME', ttl: 'Auto', status: 'not_started', value: 'track.example' },
    ],
  };

  it('creates the domain for sending only and keeps only the records sending needs', async () => {
    resend.domainAnswer = () => ({ data: createdDomain, error: null });

    const created = await resendSendingDomainProvider().create('mail.wistholm.example');

    expect(resend.domainCalls[0]).toEqual({
      method: 'create',
      argument: { name: 'mail.wistholm.example', capabilities: { sending: 'enabled', receiving: 'disabled' } },
    });
    expect(created.id).toBe('d_123');
    expect(created.status).toBe('not_started');
    expect(created.records.map((record) => `${record.record} ${record.type}`)).toEqual(['SPF MX', 'SPF TXT', 'DKIM TXT']);
    expect(created.records[0]).toEqual({
      record: 'SPF',
      type: 'MX',
      name: 'send.mail.wistholm.example',
      value: 'feedback-smtp.eu-west-1.amazonses.com',
      priority: 10,
      status: 'not_started',
    });
    expect(created.records[2]?.priority).toBeNull();
  });

  it('uses the domains key when one is set, and the sending key otherwise', async () => {
    resend.domainAnswer = () => ({ data: createdDomain, error: null });

    await resendSendingDomainProvider().get('d_123');
    env.RESEND_DOMAINS_API_KEY = 're_full_access';
    await resendSendingDomainProvider().get('d_123');

    expect(resend.keys).toEqual(['re_sending_only', 're_full_access']);
  });

  it("turns Resend's error into one that carries its message and name", async () => {
    resend.domainAnswer = () => ({
      data: null,
      error: { name: 'restricted_api_key', statusCode: 401, message: 'This API key is restricted to only send emails.' },
    });

    const failure = await resendSendingDomainProvider()
      .create('mail.wistholm.example')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SendingDomainProviderError);
    expect((failure as SendingDomainProviderError).message).toBe('This API key is restricted to only send emails.');
    expect((failure as SendingDomainProviderError).providerName).toBe('restricted_api_key');
  });

  it('asks Resend to verify and to remove by id', async () => {
    resend.domainAnswer = (method) => ({ data: { id: 'd_123', object: 'domain', ...(method === 'remove' ? { deleted: true } : {}) }, error: null });

    await resendSendingDomainProvider().verify('d_123');
    await resendSendingDomainProvider().remove('d_123');

    expect(resend.domainCalls).toEqual([
      { method: 'verify', argument: 'd_123' },
      { method: 'remove', argument: 'd_123' },
    ]);
  });
});
