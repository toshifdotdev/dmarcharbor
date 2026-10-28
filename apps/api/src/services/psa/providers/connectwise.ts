import { psaRequest } from '../../net/guarded-request.js';
import { env } from '../../../config/env.js';
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
 * ConnectWise PSA (Manage).
 *
 * An API member authenticates with a public/private key pair, sent as HTTP
 * basic auth in ConnectWise's `<companyId>+<publicKey>:<privateKey>` form, plus
 * a `clientId` header that identifies the integration itself. The clientId is
 * deployment-wide (env PSA_CONNECTWISE_CLIENT_ID) because ConnectWise issues one
 * to the vendor, not to each customer.
 *
 * Paths follow the documented v4_6_release/apis/3.0 surface. Field names are
 * unverified against a live instance.
 */

function escapeCondition(value: string): string {
  return value.replace(/"/g, '\\"');
}

export function createConnectWiseClient(config: PsaClientConfig): PsaProviderClient {
  const clientId = env.PSA_CONNECTWISE_CLIENT_ID ?? '';
  const site = config.baseUrl.replace(/^https:\/\//, '').replace(/\/+$/, '');
  const root = `https://${site}/v4_6_release/apis/3.0`;
  const companyId = config.credentials.companyId ?? '';
  const publicKey = config.credentials.publicKey ?? '';
  const privateKey = config.credentials.privateKey ?? '';
  const authorization = `Basic ${Buffer.from(`${companyId}+${publicKey}:${privateKey}`, 'utf8').toString('base64')}`;

  if (!clientId) {
    throw new PsaError(
      'ConnectWise is not set up on this deployment.',
      'PSA_UNAVAILABLE',
      503,
    );
  }

  async function call<T>(
    path: string,
    init: { method: 'GET' | 'POST' | 'PATCH'; body?: unknown } = { method: 'GET' },
  ): Promise<T> {
    const response = await psaRequest({
      url: `${root}${path}`,
      method: init.method,
      headers: {
        authorization,
        clientid: clientId,
        accept: 'application/json',
      },
      ...(init.body !== undefined ? { body: { kind: 'json' as const, value: init.body } } : {}),
    });

    if (response.status === 'error') {
      throw new PsaError(`ConnectWise could not be reached: ${response.detail}`, 'PSA_UNAVAILABLE', 502);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw psaErrorForStatus({
        provider: 'CONNECTWISE',
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
      throw new PsaError('ConnectWise answered with something that was not JSON.', 'PSA_UNAVAILABLE', 502);
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
      await call<unknown>('/company/companies?pageSize=1');
      return { ok: true as const, detail: `Connected to ConnectWise at ${site}.` };
    },

    async options() {
      const boardId = config.settings.ticketQueueId;
      const [boards, priorities] = await Promise.all([
        call<Array<{ id?: unknown; name?: unknown }>>('/service/boards?pageSize=100'),
        call<Array<{ id?: unknown; name?: unknown }>>('/service/priorities?pageSize=100'),
      ]);
      // Statuses and types belong to a board. Without one chosen yet there is
      // nothing to ask for, and an empty list is honest.
      const [statuses, types] = boardId
        ? await Promise.all([
            call<Array<{ id?: unknown; name?: unknown }>>(
              `/service/boards/${encodeURIComponent(boardId)}/statuses?pageSize=100`,
            ),
            call<Array<{ id?: unknown; name?: unknown }>>(
              `/service/boards/${encodeURIComponent(boardId)}/types?pageSize=100`,
            ),
          ])
        : [[], []];

      return {
        queues: optionsFor(boards),
        ticketTypes: optionsFor(types as Array<{ id?: unknown; name?: unknown }>),
        openStatuses: optionsFor(statuses as Array<{ id?: unknown; name?: unknown }>),
        closedStatuses: optionsFor(statuses as Array<{ id?: unknown; name?: unknown }>),
        priorities: optionsFor(priorities),
      } satisfies PsaOptions;
    },

    async searchCompanies(query: string) {
      const conditions = encodeURIComponent(`name like "%${escapeCondition(query)}%" and deletedFlag=false`);
      const items = await call<Array<{ id?: unknown; name?: unknown }>>(
        `/company/companies?conditions=${conditions}&pageSize=25`,
      );
      return optionsFor(items).slice(0, 25) as PsaCompany[];
    },

    async createTicket(input: CreateTicketInput): Promise<PsaTicketRef> {
      const created = await call<{ id?: unknown }>('/service/tickets', {
        method: 'POST',
        body: {
          summary: input.title,
          initialDescription: input.body,
          company: { id: Number(input.companyId) },
          ...(input.settings.ticketQueueId ? { board: { id: Number(input.settings.ticketQueueId) } } : {}),
          ...(input.settings.ticketTypeId ? { type: { id: Number(input.settings.ticketTypeId) } } : {}),
          ...(input.settings.openStatusId ? { status: { id: Number(input.settings.openStatusId) } } : {}),
          ...(input.settings.priorityId ? { priority: { id: Number(input.settings.priorityId) } } : {}),
        },
      });
      const id = created?.id === undefined || created?.id === null ? '' : String(created.id);
      if (!id) {
        throw new PsaError(
          'ConnectWise accepted the ticket but did not return its id.',
          'PSA_REJECTED',
          502,
        );
      }
      return { id, url: `https://${site}/v4_6_release/services/system_io/Service/fv_sr100_request.rails?service_recid=${encodeURIComponent(id)}` };
    },

    async findTicketByReference(companyIdValue: string, reference: string) {
      // `[` and `]` are a character class inside a SQL Server LIKE, which is
      // what ConnectWise conditions compile to, so `like "%[DH-ab12]%"` would
      // match one character from a set and miss the real ticket. The search
      // uses `DH-<ref>` (no wildcards: the ref is a-z and 2-7) and the exact
      // bracketed marker is checked below. The company id is numeric-only for
      // the same reason it is interpolated: it must not carry a condition.
      if (!/^\d+$/.test(companyIdValue)) {
        throw new PsaError('The mapped ConnectWise company id is not a number.', 'PSA_REJECTED', 400);
      }
      const conditions = encodeURIComponent(
        `company/id=${companyIdValue} and summary like "%DH-${reference}%" and closedFlag=false`,
      );
      const items = await call<Array<{ id?: unknown; summary?: unknown }>>(
        `/service/tickets?conditions=${conditions}&pageSize=10`,
      );
      const match = (Array.isArray(items) ? items : []).find((item) =>
        typeof item?.summary === 'string' ? item.summary.includes(`[DH-${reference}]`) : false,
      );
      if (!match || match.id === undefined || match.id === null) return null;
      const id = String(match.id);
      return {
        id,
        url: `https://${site}/v4_6_release/services/system_io/Service/fv_sr100_request.rails?service_recid=${encodeURIComponent(id)}`,
      };
    },

    async addNote(ticketId: string, text: string) {
      await call<unknown>(`/service/tickets/${encodeURIComponent(ticketId)}/notes`, {
        method: 'POST',
        body: { text, internalAnalysisFlag: true },
      });
    },

    async closeTicket(ticketId: string, closedStatusId: string) {
      await call<unknown>(`/service/tickets/${encodeURIComponent(ticketId)}`, {
        method: 'PATCH',
        body: [{ op: 'replace', path: 'status', value: { id: Number(closedStatusId) } }],
      });
    },
  };
}
