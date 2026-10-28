import { psaRequest } from '../../net/guarded-request.js';
import {
  PsaError,
  psaErrorForStatus,
  retryAfterSeconds,
  type PsaClientConfig,
  type PsaCompany,
  type PsaOption,
  type PsaOptions,
  type PsaProviderClient,
  type PsaTicketRef,
  type CreateTicketInput,
} from '../provider.js';

/**
 * HaloPSA.
 *
 * OAuth 2 client credentials, one token per (auth server, client id) held in
 * memory until a minute before it expires. The token is never stored: a process
 * restart costs one extra token request, and a leaked row costs nothing.
 *
 * Endpoints follow Halo's public API: /api/Client, /api/TicketType, /api/Status,
 * /api/Team, /api/Tickets and /api/Actions. Field names were taken from those
 * docs and are unverified against a live instance.
 */

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

function numberOrString(value: string): string | number {
  const numeric = Number(value);
  return Number.isInteger(numeric) && String(numeric) === value ? numeric : value;
}

export function createHaloPsaClient(config: PsaClientConfig): PsaProviderClient {
  const resourceServer = config.baseUrl.replace(/\/+$/, '');
  const authServer = (config.credentials.authServer?.trim() || `${resourceServer}/auth`).replace(/\/+$/, '');
  const tenant = config.credentials.tenant?.trim() ?? '';
  const clientId = config.credentials.clientId ?? '';
  const clientSecret = config.credentials.clientSecret ?? '';
  const cacheKey = `${authServer}|${clientId}`;

  async function accessToken(): Promise<string> {
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    const url = `${authServer}/token${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`;
    const response = await psaRequest({
      url,
      method: 'POST',
      headers: { accept: 'application/json' },
      body: {
        kind: 'form',
        value: {
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'all',
        },
      },
    });

    if (response.status === 'error') {
      throw new PsaError(
        `Halo's authorisation server could not be reached: ${response.detail}`,
        'PSA_UNAVAILABLE',
        502,
      );
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw psaErrorForStatus({
        provider: 'HALOPSA',
        statusCode: response.statusCode,
        body: response.body,
        retryAfterSeconds: retryAfterSeconds(response.headers['retry-after']),
      });
    }

    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(response.body.toString('utf8')) as typeof parsed;
    } catch {
      throw new PsaError(
        'Halo answered the token request with something that was not JSON.',
        'PSA_UNAVAILABLE',
        502,
      );
    }
    const token = typeof parsed.access_token === 'string' ? parsed.access_token : '';
    if (!token) {
      throw new PsaError('Halo did not return an access token.', 'PSA_AUTH_FAILED', 400);
    }
    const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 300;
    tokenCache.set(cacheKey, {
      token,
      expiresAt: Date.now() + Math.max(30, expiresIn - 60) * 1000,
    });
    return token;
  }

  async function call<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' },
  ): Promise<T> {
    const token = await accessToken();
    const response = await psaRequest({
      url: `${resourceServer}${path}`,
      method: init.method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      ...(init.body !== undefined ? { body: { kind: 'json' as const, value: init.body } } : {}),
    });

    if (response.status === 'error') {
      throw new PsaError(
        `Halo could not be reached: ${response.detail}`,
        'PSA_UNAVAILABLE',
        502,
      );
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      if (response.statusCode === 401) {
        tokenCache.delete(cacheKey);
      }
      throw psaErrorForStatus({
        provider: 'HALOPSA',
        statusCode: response.statusCode,
        body: response.body,
        retryAfterSeconds: retryAfterSeconds(response.headers['retry-after']),
      });
    }

    const text = response.body.toString('utf8');
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PsaError('Halo answered with something that was not JSON.', 'PSA_UNAVAILABLE', 502);
    }
  }

  const optionsFor = (items: Array<{ id?: unknown; name?: unknown }> | undefined): PsaOption[] =>
    (Array.isArray(items) ? items : [])
      .map((item) => ({
        id: item?.id === undefined || item?.id === null ? '' : String(item.id),
        name: typeof item?.name === 'string' ? item.name : '',
      }))
      .filter((item) => item.id && item.name);

  return {
    async test() {
      await call<unknown>('/api/Client?count=1');
      return { ok: true as const, detail: `Connected to Halo at ${new URL(resourceServer).host}.` };
    },

    async options() {
      const [ticketTypes, statuses, teams] = await Promise.all([
        call<Array<{ id?: unknown; name?: unknown }>>('/api/TicketType'),
        call<Array<{ id?: unknown; name?: unknown; closed?: unknown }>>('/api/Status'),
        call<Array<{ id?: unknown; name?: unknown }>>('/api/Team'),
      ]);
      const allStatuses = Array.isArray(statuses) ? statuses : [];
      // Halo marks a status closed with `closed: true`; without that flag a
      // status is offered in both pickers rather than hidden from one.
      const closed = allStatuses.filter((status) => status?.closed === true);
      const open = allStatuses.filter((status) => status?.closed !== true);
      return {
        queues: optionsFor(teams),
        ticketTypes: optionsFor(ticketTypes),
        openStatuses: optionsFor(open.length > 0 ? open : allStatuses),
        closedStatuses: optionsFor(closed.length > 0 ? closed : allStatuses),
        priorities: [],
      } satisfies PsaOptions;
    },

    async searchCompanies(query: string) {
      const items = await call<Array<{ id?: unknown; name?: unknown }>>(
        `/api/Client?search=${encodeURIComponent(query)}&count=25`,
      );
      return optionsFor(items).slice(0, 25) as PsaCompany[];
    },

    async createTicket(input: CreateTicketInput): Promise<PsaTicketRef> {
      const body = [
        {
          summary: input.title,
          details: input.body,
          client_id: numberOrString(input.companyId),
          ...(input.settings.ticketTypeId
            ? { tickettype_id: numberOrString(input.settings.ticketTypeId) }
            : {}),
          ...(input.settings.openStatusId
            ? { status_id: numberOrString(input.settings.openStatusId) }
            : {}),
          ...(input.settings.ticketQueueId
            ? { team_id: numberOrString(input.settings.ticketQueueId) }
            : {}),
          ...(input.settings.priorityId
            ? { priority_id: numberOrString(input.settings.priorityId) }
            : {}),
        },
      ];
      const created = await call<Array<{ id?: unknown }> | { id?: unknown }>('/api/Tickets', {
        method: 'POST',
        body,
      });
      const record = Array.isArray(created) ? created[0] : created;
      const id = record?.id === undefined || record?.id === null ? '' : String(record.id);
      if (!id) {
        throw new PsaError('Halo accepted the ticket but did not return its id.', 'PSA_REJECTED', 502);
      }
      return { id, url: `${resourceServer}/tickets?id=${encodeURIComponent(id)}` };
    },

    async findTicketByReference(companyId: string, reference: string) {
      const marker = encodeURIComponent(`[DH-${reference}]`);
      const items = await call<Array<{ id?: unknown; summary?: unknown }>>(
        `/api/Tickets?client_id=${encodeURIComponent(companyId)}&search=${marker}&open_only=true`,
      );
      const match = (Array.isArray(items) ? items : []).find((item) =>
        typeof item?.summary === 'string' ? item.summary.includes(`[DH-${reference}]`) : false,
      );
      if (!match || match.id === undefined || match.id === null) return null;
      const id = String(match.id);
      return { id, url: `${resourceServer}/tickets?id=${encodeURIComponent(id)}` };
    },

    async addNote(ticketId: string, text: string) {
      await call<unknown>('/api/Actions', {
        method: 'POST',
        body: [
          {
            ticket_id: numberOrString(ticketId),
            note: text,
            outcome: 'Note',
            hiddenfromuser: true,
          },
        ],
      });
    },

    async closeTicket(ticketId: string, closedStatusId: string) {
      await call<unknown>('/api/Tickets', {
        method: 'POST',
        body: [{ id: numberOrString(ticketId), status_id: numberOrString(closedStatusId) }],
      });
    },
  };
}
