import { organizationalDomain } from '../alignment.service.js';

/**
 * The Cloudflare API, reduced to the six operations this feature needs.
 *
 * The base URL is a constant. Nothing the caller supplies can change the host,
 * the path prefix or the redirect behaviour, so a stolen session cannot use
 * this client as a general-purpose request forwarder.
 */

const CLOUDFLARE_BASE = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 10_000;

export type DnsAutomationErrorCode =
  | 'TOKEN_INVALID'
  | 'MISSING_PERMISSION'
  | 'ZONE_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_ERROR';

export class DnsAutomationError extends Error {
  readonly status: number;
  readonly code: DnsAutomationErrorCode;

  constructor(message: string, code: DnsAutomationErrorCode, status = 502) {
    super(message);
    this.name = 'DnsAutomationError';
    this.code = code;
    this.status = status;
  }
}

export interface CloudflareTxtRecord {
  id: string;
  name: string;
  content: string;
  ttl: number;
  comment: string | null;
}

export interface CloudflareZone {
  id: string;
  name: string;
  accountName: string | null;
}

/**
 * A Cloudflare for SaaS custom hostname.
 *
 * `status` is the hostname's own state and `sslStatus` the certificate's; a
 * hostname is only ready when both are `active`, which is why both are stored
 * separately rather than collapsed into one boolean.
 */
export interface CloudflareCustomHostname {
  id: string;
  hostname: string;
  status: string | null;
  sslStatus: string | null;
  /** Cloudflare's own words when validation failed, for the operator to read. */
  sslError: string | null;
}

export interface CloudflareClient {
  verifyToken(): Promise<{ status: string }>;
  findZone(domainName: string): Promise<CloudflareZone>;
  listTxtRecords(zoneId: string, name: string): Promise<CloudflareTxtRecord[]>;
  findCname(zoneId: string, name: string): Promise<boolean>;
  createTxtRecord(
    zoneId: string,
    name: string,
    content: string,
    comment?: string,
  ): Promise<CloudflareTxtRecord>;
  listZoneTxtRecords(
    zoneId: string,
    page: number,
  ): Promise<{ records: CloudflareTxtRecord[]; totalPages: number }>;
  updateTxtRecord(
    zoneId: string,
    record: CloudflareTxtRecord,
    content: string,
  ): Promise<CloudflareTxtRecord>;
  deleteTxtRecord(zoneId: string, recordId: string): Promise<void>;
  /** Cloudflare for SaaS. Needs Zone → SSL and Certificates → Edit. */
  createCustomHostname(zoneId: string, hostname: string): Promise<CloudflareCustomHostname>;
  getCustomHostname(zoneId: string, id: string): Promise<CloudflareCustomHostname>;
  deleteCustomHostname(zoneId: string, id: string): Promise<void>;
}

interface CloudflareEnvelope<T> {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
  result_info?: { total_pages?: unknown; page?: unknown };
}

interface RawTxtRecord {
  id?: unknown;
  name?: unknown;
  content?: unknown;
  ttl?: unknown;
  comment?: unknown;
}

interface RawZone {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  account?: { name?: unknown };
}

interface RawCustomHostname {
  id?: unknown;
  hostname?: unknown;
  status?: unknown;
  ssl?: {
    status?: unknown;
    validation_errors?: Array<{ message?: unknown }>;
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toTxtRecord(value: RawTxtRecord): CloudflareTxtRecord | null {
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const content = stringValue(value.content);
  if (!id || !name || content === null) {
    return null;
  }
  return {
    id,
    name,
    content,
    ttl: numberValue(value.ttl) ?? 1,
    comment: stringValue(value.comment),
  };
}

/**
 * A custom hostname, from whichever shape Cloudflare returned.
 *
 * The create response may carry no validation details at all — HTTP validation
 * needs nothing from the customer beyond the CNAME — so both statuses are
 * allowed to be absent and the caller treats "not active" as not ready.
 */
function toCustomHostname(value: RawCustomHostname): CloudflareCustomHostname | null {
  const id = stringValue(value.id);
  const hostname = stringValue(value.hostname);
  if (!id || !hostname) {
    return null;
  }
  const errors = (value.ssl?.validation_errors ?? [])
    .map((error) => stringValue(error.message))
    .filter((message): message is string => Boolean(message));
  return {
    id,
    hostname,
    status: stringValue(value.status),
    sslStatus: stringValue(value.ssl?.status),
    sslError: errors.length > 0 ? errors.join(' ').slice(0, 500) : null,
  };
}

function errorCodes(envelope: CloudflareEnvelope<unknown>): number[] {
  return (envelope.errors ?? [])
    .map((error) => error.code)
    .filter((code): code is number => typeof code === 'number');
}

function classifyFailure(status: number, codes: number[]): DnsAutomationError {
  if (status === 429) {
    return new DnsAutomationError(
      'Cloudflare is rate limiting this request. Wait a minute and try again.',
      'RATE_LIMITED',
      429,
    );
  }
  if (status === 401 || codes.includes(10000)) {
    return new DnsAutomationError(
      'The Cloudflare token is not valid or has expired. Create a new token and connect it again.',
      'TOKEN_INVALID',
      400,
    );
  }
  if (status === 403 || codes.includes(9109)) {
    return new DnsAutomationError(
      'The token does not have the permissions this needs. It must allow Zone → DNS → Edit and Zone → Zone → Read for the zones you want published.',
      'MISSING_PERMISSION',
      403,
    );
  }
  if (status >= 500) {
    return new DnsAutomationError(
      'Cloudflare could not be reached just now. Nothing was changed; try again in a few minutes.',
      'PROVIDER_UNAVAILABLE',
      502,
    );
  }
  return new DnsAutomationError(
    'Cloudflare refused that request. Nothing was changed.',
    'PROVIDER_ERROR',
    502,
  );
}

/**
 * Zone candidates, most specific first, stopping at the registrable domain.
 *
 * A customer commonly hosts `mail.example.com` in the zone `example.com`; a
 * lookup for the full host alone would fail. The stop is the registrable
 * domain, never `com` or `co.uk`, so a token scoped to one zone cannot be used
 * to probe a public suffix.
 */
export function zoneCandidates(domainName: string): string[] {
  const name = domainName.trim().toLowerCase().replace(/\.+$/, '');
  if (!name) {
    return [];
  }

  const registrable = organizationalDomain(name);
  if (!registrable) {
    return [name];
  }

  const candidates: string[] = [];
  let current = name;
  while (true) {
    candidates.push(current);
    if (current === registrable) {
      break;
    }
    const next = current.replace(/^[^.]+\./, '');
    if (next === current || !next.endsWith(registrable)) {
      break;
    }
    current = next;
  }
  return candidates;
}

/**
 * Custom hostnames need a different permission from DNS records, and the
 * generic refusal names only the DNS one. An operator who reads "Zone → DNS →
 * Edit" and already has it has no way to know what is missing, so this path
 * names the permission Cloudflare actually checks.
 */
function customHostnameFailure(error: unknown): never {
  if (error instanceof DnsAutomationError && error.code === 'MISSING_PERMISSION') {
    throw new DnsAutomationError(
      'The Cloudflare token cannot manage custom hostnames. It needs Zone → SSL and Certificates → Edit on the hosted zone, as well as Zone → DNS → Edit.',
      'MISSING_PERMISSION',
      403,
    );
  }
  throw error;
}

let defaultFetch: typeof fetch = fetch;

/**
 * Test seam.
 *
 * The base URL is fixed, so integration tests cannot redirect it at a local
 * stub. They replace the fetch implementation for the process instead. Passing
 * null restores the platform fetch.
 */
export function setCloudflareFetchForTests(impl: typeof fetch | null): void {
  defaultFetch = impl ?? fetch;
}

export function createCloudflareClient(input: {
  token: string;
  fetchImpl?: typeof fetch;
}): CloudflareClient {  const fetchImpl = input.fetchImpl ?? defaultFetch;
  const token = input.token.trim();

  async function requestEnvelope<T>(path: string, init: RequestInit = {}): Promise<CloudflareEnvelope<T>> {
    let response: Response;
    try {
      response = await fetchImpl(`${CLOUDFLARE_BASE}${path}`, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new DnsAutomationError(
        'Cloudflare could not be reached just now. Nothing was changed; try again in a few minutes.',
        'PROVIDER_UNAVAILABLE',
        502,
      );
    }

    const text = await response.text().catch(() => '');
    let envelope: CloudflareEnvelope<T>;
    try {
      envelope = text ? (JSON.parse(text) as CloudflareEnvelope<T>) : {};
    } catch {
      throw new DnsAutomationError(
        'Cloudflare returned a response that could not be read. Nothing was changed.',
        'PROVIDER_UNAVAILABLE',
        502,
      );
    }

    if (!response.ok || envelope.success === false) {
      throw classifyFailure(response.status, errorCodes(envelope));
    }

    return envelope;
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const envelope = await requestEnvelope<T>(path, init);
    return envelope.result as T;
  }

  return {
    async verifyToken() {
      const result = await request<{ status?: unknown }>('/user/tokens/verify', {
        method: 'GET',
      });
      return { status: stringValue(result?.status) ?? 'unknown' };
    },

    async findZone(domainName) {
      for (const candidate of zoneCandidates(domainName)) {
        const result = await request<RawZone[]>(
          `/zones?name=${encodeURIComponent(candidate)}&status=active`,
          { method: 'GET' },
        );
        const zone = Array.isArray(result) ? result[0] : undefined;
        const id = stringValue(zone?.id);
        const name = stringValue(zone?.name);
        if (id && name) {
          return { id, name, accountName: stringValue(zone?.account?.name) };
        }
      }

      throw new DnsAutomationError(
        `No active Cloudflare zone was found for ${domainName} with this token. Check that the domain is on Cloudflare and that the token is limited to its zones.`,
        'ZONE_NOT_FOUND',
        404,
      );
    },

    async listTxtRecords(zoneId, name) {
      const result = await request<RawTxtRecord[]>(
        `/zones/${encodeURIComponent(zoneId)}/dns_records?type=TXT&name=${encodeURIComponent(name)}&per_page=100`,
        { method: 'GET' },
      );
      return (Array.isArray(result) ? result : [])
        .map(toTxtRecord)
        .filter((record): record is CloudflareTxtRecord => record !== null);
    },

    async findCname(zoneId, name) {
      const result = await request<RawTxtRecord[]>(
        `/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(name)}&per_page=1`,
        { method: 'GET' },
      );
      return Array.isArray(result) && result.length > 0;
    },

    async createTxtRecord(zoneId, name, content, comment) {
      const result = await request<RawTxtRecord>(
        `/zones/${encodeURIComponent(zoneId)}/dns_records`,
        {
          method: 'POST',
          body: JSON.stringify({
            type: 'TXT',
            name,
            content,
            ttl: 1,
            ...(comment ? { comment } : {}),
          }),
        },
      );
      const record = result ? toTxtRecord(result) : null;
      if (!record) {
        throw new DnsAutomationError(
          'Cloudflare accepted the record but did not return it. Check the zone before publishing again.',
          'PROVIDER_UNAVAILABLE',
          502,
        );
      }
      return record;
    },

    async listZoneTxtRecords(zoneId, page) {
      const envelope = await requestEnvelope<RawTxtRecord[]>(
        `/zones/${encodeURIComponent(zoneId)}/dns_records?type=TXT&per_page=100&page=${encodeURIComponent(String(page))}`,
        { method: 'GET' },
      );
      const records = (Array.isArray(envelope.result) ? envelope.result : [])
        .map(toTxtRecord)
        .filter((record): record is CloudflareTxtRecord => record !== null);
      const total = numberValue(envelope.result_info?.total_pages);
      return { records, totalPages: total !== null && total > 0 ? total : 1 };
    },

    async updateTxtRecord(zoneId, record, content) {
      const result = await request<RawTxtRecord>(
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(record.id)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            type: 'TXT',
            name: record.name,
            content,
            ttl: record.ttl,
            ...(record.comment ? { comment: record.comment } : {}),
          }),
        },
      );
      const updated = result ? toTxtRecord(result) : null;
      if (!updated) {
        throw new DnsAutomationError(
          'Cloudflare accepted the change but did not return the record. Check the zone before publishing again.',
          'PROVIDER_UNAVAILABLE',
          502,
        );
      }
      return updated;
    },

    async deleteTxtRecord(zoneId, recordId) {
      await request<unknown>(
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
        { method: 'DELETE' },
      );
    },

    async createCustomHostname(zoneId, hostname) {
      try {
        const result = await request<RawCustomHostname>(
          `/zones/${encodeURIComponent(zoneId)}/custom_hostnames`,
          {
            method: 'POST',
            body: JSON.stringify({
              hostname,
              // HTTP validation: Cloudflare serves the challenge token itself
              // once the customer's CNAME resolves here, so the customer never
              // has to publish a second record.
              ssl: { method: 'http', type: 'dv' },
            }),
          },
        );
        const created = result ? toCustomHostname(result) : null;
        if (!created) {
          throw new DnsAutomationError(
            'Cloudflare accepted the custom hostname but did not return it. Check the zone before starting again.',
            'PROVIDER_UNAVAILABLE',
            502,
          );
        }
        return created;
      } catch (error) {
        customHostnameFailure(error);
      }
    },

    async getCustomHostname(zoneId, id) {
      try {
        const result = await request<RawCustomHostname>(
          `/zones/${encodeURIComponent(zoneId)}/custom_hostnames/${encodeURIComponent(id)}`,
          { method: 'GET' },
        );
        const found = result ? toCustomHostname(result) : null;
        if (!found) {
          throw new DnsAutomationError(
            'Cloudflare did not return that custom hostname.',
            'PROVIDER_ERROR',
            502,
          );
        }
        return found;
      } catch (error) {
        customHostnameFailure(error);
      }
    },

    async deleteCustomHostname(zoneId, id) {
      try {
        await request<unknown>(
          `/zones/${encodeURIComponent(zoneId)}/custom_hostnames/${encodeURIComponent(id)}`,
          { method: 'DELETE' },
        );
      } catch (error) {
        customHostnameFailure(error);
      }
    },
  };
}
