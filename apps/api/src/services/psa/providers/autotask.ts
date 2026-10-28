import { psaRequest } from '../../net/guarded-request.js';
import { PsaError, psaErrorForStatus, retryAfterSeconds, type PsaClientConfig, type PsaCompany, type PsaOption, type PsaOptions, type PsaProviderClient, type PsaTicketRef, type CreateTicketInput } from '../provider.js';

/**
 * Autotask.
 *
 * An API-only user authenticates with a username, a secret and the integration
 * code that the vendor generates. The zone is discovered once from Autotask's
 * own directory and stored, because the zone a database lives on can move; a
 * 401 or 404 from a stored zone is treated as "the zone moved" and re-discovered
 * once.
 *
 * Field names follow the documented ATServicesRest surface and are unverified
 * against a live instance.
 */

const zoneDirectory = 'https://webservices.autotask.net/atservicesrest/v1.0/zoneInformation';

/**
 * The zone URL, refused unless it is https and under autotask.net.
 *
 * This value becomes a base URL that carries credentials on every call, so an
 * answer that points anywhere else is exactly the redirect an attacker would
 * want. Checked here rather than trusted.
 */
export function acceptAutotaskZone(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'autotask.net' && !host.endsWith('.autotask.net')) return null;
  if (url.username || url.password) return null;
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return `${url.origin}${path}`;
}

export async function discoverAutotaskZone(username: string): Promise<string> {
  const response = await psaRequest({
    url: `${zoneDirectory}?user=${encodeURIComponent(username)}`,
    method: 'GET',
  });
  if (response.status === 'error') {
    throw new PsaError(
      `Autotask's zone directory could not be reached: ${response.detail}`,
      'PSA_UNAVAILABLE',
      502,
    );
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw psaErrorForStatus({
      provider: 'AUTOTASK',
      statusCode: response.statusCode,
      body: response.body,
    });
  }
  let parsed: { url?: unknown } = {};
  try {
    parsed = JSON.parse(response.body.toString('utf8')) as typeof parsed;
  } catch {
    throw new PsaError('Autotask answered with something that was not JSON.', 'PSA_UNAVAILABLE', 502);
  }
  const zone = acceptAutotaskZone(parsed.url);
  if (!zone) {
    throw new PsaError(
      'Autotask returned a zone address that is not under autotask.net. Nothing was saved.',
      'PSA_REJECTED',
      400,
    );
  }
  return zone;
}

function dueDateTime(now: Date): string {
  const due = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return due.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

interface AutotaskField {
  name?: unknown;
  picklistValues?: Array<{ value?: unknown; label?: unknown; isActive?: unknown }>;
}

function picklist(fields: AutotaskField[], name: string): PsaOption[] {
  const field = fields.find((entry) => typeof entry?.name === 'string' && entry.name === name);
  return (field?.picklistValues ?? [])
    .filter((entry) => entry?.isActive !== false)
    .map((entry) => ({
      id: entry?.value === undefined || entry?.value === null ? '' : String(entry.value),
      name: typeof entry?.label === 'string' ? entry.label : '',
    }))
    .filter((entry) => entry.id && entry.name);
}

export function createAutotaskClient(config: PsaClientConfig): PsaProviderClient {
  const base = config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`;
  const username = config.credentials.username ?? '';
  const secret = config.credentials.secret ?? '';
  const integrationCode = config.credentials.integrationCode ?? '';

  async function call<T>(
    path: string,
    init: { method: 'GET' | 'POST' | 'PATCH'; body?: unknown } = { method: 'GET' },
  ): Promise<T> {
    const response = await psaRequest({
      url: `${base}V1.0/${path}`,
      method: init.method,
      headers: {
        username,
        secret,
        apiintegrationcode: integrationCode,
        accept: 'application/json',
      },
      ...(init.body !== undefined ? { body: { kind: 'json' as const, value: init.body } } : {}),
    });

    if (response.status === 'error') {
      throw new PsaError(`Autotask could not be reached: ${response.detail}`, 'PSA_UNAVAILABLE', 502);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw psaErrorForStatus({
        provider: 'AUTOTASK',
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
      throw new PsaError('Autotask answered with something that was not JSON.', 'PSA_UNAVAILABLE', 502);
    }
  }

  return {
    async test() {
      await call<unknown>('Companies/query', {
        method: 'POST',
        body: { filter: [{ op: 'eq', field: 'isActive', value: true }], MaxRecords: 1 },
      });
      return { ok: true as const, detail: `Connected to Autotask at ${new URL(base).host}.` };
    },

    async options() {
      const fields = await call<{ fields?: AutotaskField[] }>('Tickets/entityInformation/fields');
      const list = Array.isArray(fields?.fields) ? fields.fields : [];
      return {
        queues: picklist(list, 'queueID'),
        ticketTypes: picklist(list, 'ticketType'),
        openStatuses: picklist(list, 'status'),
        closedStatuses: picklist(list, 'status'),
        priorities: picklist(list, 'priority'),
      } satisfies PsaOptions;
    },

    async searchCompanies(query: string) {
      const result = await call<{ items?: Array<{ id?: unknown; companyName?: unknown }> }>(
        'Companies/query',
        {
          method: 'POST',
          body: {
            filter: [
              { op: 'contains', field: 'companyName', value: query },
              { op: 'eq', field: 'isActive', value: true },
            ],
            MaxRecords: 25,
          },
        },
      );
      const items = Array.isArray(result?.items) ? result.items : [];
      return items
        .map((item) => ({
          id: item?.id === undefined || item?.id === null ? '' : String(item.id),
          name: typeof item?.companyName === 'string' ? item.companyName : '',
        }))
        .filter((item) => item.id && item.name)
        .slice(0, 25) as PsaCompany[];
    },

    async createTicket(input: CreateTicketInput): Promise<PsaTicketRef> {
      const created = await call<{ itemId?: unknown; id?: unknown }>('Tickets', {
        method: 'POST',
        body: {
          companyID: Number(input.companyId),
          title: input.title,
          description: input.body,
          ...(input.settings.openStatusId ? { status: Number(input.settings.openStatusId) } : {}),
          ...(input.settings.priorityId ? { priority: Number(input.settings.priorityId) } : {}),
          ...(input.settings.ticketQueueId ? { queueID: Number(input.settings.ticketQueueId) } : {}),
          ...(input.settings.ticketTypeId ? { ticketType: Number(input.settings.ticketTypeId) } : {}),
          // Required unless the ticket category supplies a default, and a
          // category is optional here, so one is always sent.
          dueDateTime: dueDateTime(new Date()),
        },
      });
      const id =
        created?.itemId === undefined || created?.itemId === null
          ? created?.id === undefined || created?.id === null
            ? ''
            : String(created.id)
          : String(created.itemId);
      if (!id) {
        throw new PsaError('Autotask accepted the ticket but did not return its id.', 'PSA_REJECTED', 502);
      }
      return { id, url: null };
    },

    async findTicketByReference(companyId: string, reference: string) {
      const result = await call<{ items?: Array<{ id?: unknown; title?: unknown }> }>('Tickets/query', {
        method: 'POST',
        body: {
          filter: [
            { op: 'eq', field: 'companyID', value: Number(companyId) },
            { op: 'contains', field: 'title', value: `[DH-${reference}]` },
          ],
          MaxRecords: 10,
        },
      });
      const items = Array.isArray(result?.items) ? result.items : [];
      const match = items.find((item) =>
        typeof item?.title === 'string' ? item.title.includes(`[DH-${reference}]`) : false,
      );
      if (!match || match.id === undefined || match.id === null) return null;
      return { id: String(match.id), url: null };
    },

    async addNote(ticketId: string, text: string) {
      await call<unknown>(`Tickets/${encodeURIComponent(ticketId)}/Notes`, {
        method: 'POST',
        body: {
          title: 'DMARC Harbor',
          description: text,
          // Internal: the end customer never sees it.
          noteType: 1,
          publish: 1,
        },
      });
    },

    async closeTicket(ticketId: string, closedStatusId: string) {
      await call<unknown>('Tickets', {
        method: 'PATCH',
        body: { id: Number(ticketId), status: Number(closedStatusId) },
      });
    },
  };
}
