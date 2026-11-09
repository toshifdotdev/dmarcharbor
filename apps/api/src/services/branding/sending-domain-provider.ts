import { Resend } from 'resend';
import { env } from '../../config/env.js';
import { PROVIDER_TIMEOUT_MS, withGenericTimeout } from '../../billing/provider-timeout.js';
import { organizationalDomain } from '../alignment.service.js';

/**
 * Where an agency's own sending domain is registered with the email provider.
 *
 * An Admiralty agency can send its client mail from its own domain, for
 * example `reports@mail.wistholm.example`. The provider only accepts mail from
 * a domain it has been told about and whose DKIM and SPF records it has seen,
 * so the domain is added to our provider account, the agency publishes the
 * records the provider returns, and the provider is asked to check them.
 *
 * This file is the seam. The service never talks to the SDK directly, so the
 * integration suite swaps in a fake with `setSendingDomainProviderForTests` and
 * development gets a console provider that never touches the network.
 */

/**
 * One DNS record the agency publishes. Stored on the organization and returned
 * to the agency's settings page as it is, so the shape is part of the contract.
 */
export interface SendingDomainRecord {
  /** What the record is for: `SPF` or `DKIM`. */
  record: string;
  /** `TXT`, `MX` or `CNAME`. */
  type: string;
  /** The full host name to publish it at. */
  name: string;
  value: string;
  /** For an MX record; null otherwise. */
  priority: number | null;
  /** The provider's view of this one record, for example `pending` or `verified`. */
  status: string;
}

export interface ProviderDomain {
  id: string;
  /** The provider's overall status, for example `not_started`, `pending` or `verified`. */
  status: string;
  records: SendingDomainRecord[];
}

export interface SendingDomainProvider {
  create(name: string): Promise<ProviderDomain>;
  get(id: string): Promise<ProviderDomain>;
  /** Asks the provider to look at the records now. The answer comes from `get`. */
  verify(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/** The provider refused a call or did not answer. Carries the provider's own words. */
export class SendingDomainProviderError extends Error {
  /** The provider's error name, for example `validation_error`, or null for a timeout. */
  readonly providerName: string | null;

  constructor(message: string, providerName: string | null = null) {
    super(message);
    this.name = 'SendingDomainProviderError';
    this.providerName = providerName;
  }
}

/**
 * Only the records sending needs.
 *
 * Resend also describes a receiving MX and click and open tracking records.
 * Receiving is switched off when the domain is created, and tracking is not
 * used, so those are dropped: asking an agency to publish an MX record that
 * would route its mail to the provider is how a sending setup breaks inbound
 * mail for a whole domain.
 */
const sendingRecordKinds = new Set(['SPF', 'DKIM']);

interface ResendRecord {
  record: string;
  type: string;
  name: string;
  value: string;
  status: string;
  priority?: number;
}

/**
 * The full host name for one of Resend's records.
 *
 * Resend names its records relative to the registered domain, not to the
 * domain added: for `notify.linkshift.in` it answers `resend._domainkey.notify`
 * and `send.notify`. Shown as is, an agency cannot tell which zone the name
 * belongs to, and the contract above promises the full name (session 14; the
 * console provider always returned full names, so tests never saw this).
 */
export function fullRecordName(name: string, domain: string): string {
  const clean = name.trim().toLowerCase().replace(/\.+$/, '');
  const base = organizationalDomain(domain) || domain.toLowerCase();
  if (clean === base || clean.endsWith(`.${base}`)) return clean;
  return clean ? `${clean}.${base}` : base;
}

function toRecords(records: ResendRecord[] | null | undefined, domain: string): SendingDomainRecord[] {
  return (records ?? [])
    .filter((record) => sendingRecordKinds.has(record.record))
    .map((record) => ({
      record: record.record,
      type: record.type,
      name: fullRecordName(record.name, domain),
      value: record.value,
      priority: typeof record.priority === 'number' ? record.priority : null,
      status: record.status,
    }));
}

/**
 * Resend's domain API, with its own key when one is set.
 *
 * RESEND_DOMAINS_API_KEY is a full-access key used for these calls only, so the
 * key every message is sent with can stay sending-only. Without it the sending
 * key is used, and must then have full access.
 */
export function resendSendingDomainProvider(): SendingDomainProvider {
  const client = (): Resend => {
    const key = env.RESEND_DOMAINS_API_KEY ?? env.RESEND_API_KEY;
    if (!key) {
      throw new SendingDomainProviderError('No Resend API key is configured for sending domains.');
    }
    return new Resend(key);
  };

  /**
   * Every call is bounded, as `sendEmail` is: the SDK sets no deadline, and a
   * stalled answer would hold the agency's settings request open for ever.
   */
  async function call<T>(
    label: string,
    operation: (resend: Resend) => Promise<{ data: T | null; error: { message: string; name: string } | null }>,
  ): Promise<T> {
    let result: { data: T | null; error: { message: string; name: string } | null };
    try {
      const resend = client();
      result = await withGenericTimeout(() => operation(resend), PROVIDER_TIMEOUT_MS, 'Resend');
    } catch (error) {
      if (error instanceof SendingDomainProviderError) throw error;
      throw new SendingDomainProviderError(error instanceof Error ? error.message : `Resend ${label} failed.`);
    }
    if (result.error) {
      throw new SendingDomainProviderError(result.error.message, result.error.name);
    }
    if (result.data === null) {
      throw new SendingDomainProviderError(`Resend returned nothing for ${label}.`);
    }
    return result.data;
  }

  return {
    async create(name) {
      const data = await call('domains.create', (resend) =>
        resend.domains.create({ name, capabilities: { sending: 'enabled', receiving: 'disabled' } }),
      );
      return { id: data.id, status: data.status, records: toRecords(data.records as ResendRecord[], data.name ?? name) };
    },
    async get(id) {
      const data = await call('domains.get', (resend) => resend.domains.get(id));
      return { id: data.id, status: data.status, records: toRecords(data.records as ResendRecord[], data.name) };
    },
    async verify(id) {
      await call('domains.verify', (resend) => resend.domains.verify(id));
    },
    async remove(id) {
      await call('domains.remove', (resend) => resend.domains.remove(id));
    },
  };
}

/**
 * Development and tests: deterministic placeholder records, no network.
 *
 * The values are the shape Resend returns, so the settings page can be built
 * and checked against them, and the DKIM value says plainly that it is a
 * placeholder so nobody publishes it. `verify` moves the domain to `pending`
 * and never to `verified`: there is no provider to have seen the records, and
 * claiming otherwise would switch a developer's client mail to an address no
 * provider will send from.
 */
const consoleIdPrefix = 'console-domain-';

export function consoleSendingDomainProvider(): SendingDomainProvider {
  const domains = new Map<string, { name: string; status: string }>();

  const recordsFor = (name: string, status: string): SendingDomainRecord[] => {
    const recordStatus = status === 'pending' ? 'pending' : 'not_started';
    return [
      {
        record: 'DKIM',
        type: 'TXT',
        name: `resend._domainkey.${name}`,
        value: 'p=PLACEHOLDER-DKIM-KEY-FROM-THE-CONSOLE-PROVIDER-DO-NOT-PUBLISH',
        priority: null,
        status: recordStatus,
      },
      {
        record: 'SPF',
        type: 'MX',
        name: `send.${name}`,
        value: 'feedback-smtp.us-east-1.amazonses.com',
        priority: 10,
        status: recordStatus,
      },
      {
        record: 'SPF',
        type: 'TXT',
        name: `send.${name}`,
        value: 'v=spf1 include:amazonses.com ~all',
        priority: null,
        status: recordStatus,
      },
    ];
  };

  // The id carries the name, so a domain added before a development restart
  // can still be checked and removed: the map only remembers the status.
  const known = (id: string) => {
    const found = domains.get(id);
    if (found) {
      return found;
    }
    if (!id.startsWith(consoleIdPrefix) || id.length === consoleIdPrefix.length) {
      throw new SendingDomainProviderError('Domain not found.', 'not_found');
    }
    const restored = { name: id.slice(consoleIdPrefix.length), status: 'not_started' };
    domains.set(id, restored);
    return restored;
  };

  return {
    async create(name) {
      const id = `${consoleIdPrefix}${name}`;
      domains.set(id, { name, status: 'not_started' });
      console.info(`[sending-domain] console provider added ${name}; publish nothing, these records are placeholders.`);
      return { id, status: 'not_started', records: recordsFor(name, 'not_started') };
    },
    async get(id) {
      const found = known(id);
      return { id, status: found.status, records: recordsFor(found.name, found.status) };
    },
    async verify(id) {
      known(id).status = 'pending';
    },
    async remove(id) {
      domains.delete(id);
    },
  };
}

let override: SendingDomainProvider | null = null;
let consoleProvider: SendingDomainProvider | null = null;

/** The provider for this deployment: Resend when email goes through Resend, the console otherwise. */
export function sendingDomainProvider(): SendingDomainProvider {
  if (override) {
    return override;
  }
  if (env.EMAIL_PROVIDER === 'resend') {
    return resendSendingDomainProvider();
  }
  // Kept for the life of the process, so a domain added in development can be
  // checked and removed afterwards.
  consoleProvider ??= consoleSendingDomainProvider();
  return consoleProvider;
}

/** For tests. Pass null to go back to the configured provider. */
export function setSendingDomainProviderForTests(provider: SendingDomainProvider | null): void {
  override = provider;
}
