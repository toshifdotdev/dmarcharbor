import { randomBytes } from 'node:crypto';
import { createHaloPsaClient } from './providers/halopsa.js';
import { createConnectWiseClient } from './providers/connectwise.js';
import { createAutotaskClient } from './providers/autotask.js';

/**
 * What a PSA has to do for this product, in one interface.
 *
 * The three vendors disagree about almost everything — ids, boards, statuses,
 * how a note is made internal — but the product only needs six operations, and
 * every one of them is expressed here in DMARC Harbor's terms. An adapter that
 * cannot do one of them honestly should fail loudly rather than pretend.
 */

export type PsaProviderName = 'HALOPSA' | 'CONNECTWISE' | 'AUTOTASK';

export type PsaErrorCode =
  | 'PSA_AUTH_FAILED'
  | 'PSA_PERMISSION_DENIED'
  | 'PSA_NOT_FOUND'
  | 'PSA_RATE_LIMITED'
  | 'PSA_UNAVAILABLE'
  | 'PSA_REJECTED';

export class PsaError extends Error {
  constructor(
    message: string,
    readonly code: PsaErrorCode,
    readonly status = 502,
    /** Seconds the PSA asked us to wait, when it said so. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'PsaError';
  }
}

export interface PsaCompany {
  id: string;
  name: string;
}

export interface PsaOption {
  id: string;
  name: string;
}

export interface PsaOptions {
  queues: PsaOption[];
  ticketTypes: PsaOption[];
  openStatuses: PsaOption[];
  closedStatuses: PsaOption[];
  priorities: PsaOption[];
}

export interface PsaTicketSettings {
  ticketQueueId: string | null;
  ticketTypeId: string | null;
  openStatusId: string | null;
  closedStatusId: string | null;
  priorityId: string | null;
}

export interface CreateTicketInput {
  companyId: string;
  title: string;
  body: string;
  reference: string;
  settings: PsaTicketSettings;
}

export interface PsaTicketRef {
  id: string;
  url: string | null;
}

export interface PsaProviderClient {
  /** Authenticate and read one page of companies. */
  test(): Promise<{ ok: true; detail: string }>;
  /** Boards/queues, ticket types, statuses and priorities, for the pickers. */
  options(): Promise<PsaOptions>;
  /** At most 25 matches. */
  searchCompanies(query: string): Promise<PsaCompany[]>;
  createTicket(input: CreateTicketInput): Promise<PsaTicketRef>;
  findTicketByReference(companyId: string, reference: string): Promise<PsaTicketRef | null>;
  /** An internal note, hidden from the end customer. */
  addNote(ticketId: string, text: string): Promise<void>;
  closeTicket(ticketId: string, closedStatusId: string): Promise<void>;
}

export type PsaCredentials = Record<string, string>;

export interface PsaClientConfig {
  credentials: PsaCredentials;
  baseUrl: string;
  settings: PsaTicketSettings;
}

export function createPsaClient(provider: PsaProviderName, config: PsaClientConfig): PsaProviderClient {
  switch (provider) {
    case 'HALOPSA':
      return createHaloPsaClient(config);
    case 'CONNECTWISE':
      return createConnectWiseClient(config);
    case 'AUTOTASK':
      return createAutotaskClient(config);
    default:
      throw new PsaError('That PSA is not supported.', 'PSA_REJECTED', 400);
  }
}

// ─── the marker and the title ───────────────────────────────────────────────

/** 8 lowercase base32 characters: short enough to read, long enough to be unique. */
export function newTicketReference(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = randomBytes(8);
  let value = '';
  for (const byte of bytes) {
    value += alphabet[byte & 0x1f];
  }
  return value;
}

export function referenceMarker(reference: string): string {
  return `[DH-${reference}]`;
}

/**
 * The title, cut to what the provider accepts without losing the marker.
 *
 * ConnectWise caps `summary` at 100 characters. Cutting from the end would
 * remove the marker, which is the only thing that makes a retry idempotent, so
 * the head is cut and the marker is always the last thing in the string.
 */
export function buildTicketTitle(input: {
  domain: string;
  summary: string;
  reference: string;
  limit: number;
}): string {
  const marker = referenceMarker(input.reference);
  const head = `DMARC Harbor: ${input.domain}: ${input.summary}`;
  if (head.length + 1 + marker.length <= input.limit) {
    return `${head} ${marker}`;
  }
  const room = input.limit - marker.length - 1;
  if (room <= 1) {
    return marker.slice(0, input.limit);
  }
  return `${head.slice(0, room - 1).trimEnd()}…${marker}`;
}

export const titleLimits: Record<PsaProviderName, number> = {
  // ConnectWise documents 100 for `summary`; the other two accept far more, and
  // 255 is the practical limit for both.
  CONNECTWISE: 100,
  HALOPSA: 255,
  AUTOTASK: 255,
};

// ─── error mapping ──────────────────────────────────────────────────────────

function permissionHint(provider: PsaProviderName): string {
  switch (provider) {
    case 'CONNECTWISE':
      return 'In ConnectWise, give the API member’s security role Service Desk › Service Tickets › Add, and Edit for notes and status changes.';
    case 'HALOPSA':
      return 'In Halo, give the API application the permissions read:tickets and edit:tickets.';
    case 'AUTOTASK':
      return 'In Autotask, check that the API user’s security level allows adding tickets and notes, and that the integration code matches.';
    default:
      return 'Check the credentials and the permissions they carry.';
  }
}

function providerName(provider: PsaProviderName): string {
  switch (provider) {
    case 'CONNECTWISE':
      return 'ConnectWise PSA';
    case 'HALOPSA':
      return 'HaloPSA';
    case 'AUTOTASK':
      return 'Autotask';
    default:
      return 'The PSA';
  }
}

/** Trims a provider's error body to something safe to show and store. */
function detailFrom(body: Buffer): string {
  const text = body.toString('utf8').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const message =
      (typeof parsed.message === 'string' && parsed.message) ||
      (typeof parsed.error === 'string' && parsed.error) ||
      (typeof parsed.title === 'string' && parsed.title) ||
      '';
    if (message) return message.slice(0, 300);
  } catch {
    // not JSON
  }
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

export function psaErrorForStatus(input: {
  provider: PsaProviderName;
  statusCode: number;
  body: Buffer;
  retryAfterSeconds?: number;
}): PsaError {
  const name = providerName(input.provider);
  const detail = detailFrom(input.body);
  const suffix = detail ? ` ${name} said: ${detail}` : '';

  if (input.statusCode === 401) {
    return new PsaError(
      `${name} rejected the credentials. Check the API user and its key or secret, then replace the credentials.${suffix}`,
      'PSA_AUTH_FAILED',
      400,
    );
  }
  if (input.statusCode === 403) {
    return new PsaError(
      `${name} refused this action: the API member does not have permission. ${permissionHint(input.provider)}${suffix}`,
      'PSA_PERMISSION_DENIED',
      403,
    );
  }
  if (input.statusCode === 404) {
    return new PsaError(
      `${name} could not find that record. Check the base URL and the board or queue.${suffix}`,
      'PSA_NOT_FOUND',
      404,
    );
  }
  if (input.statusCode === 429) {
    const wait = input.retryAfterSeconds ?? 60;
    return new PsaError(
      `${name} is rate limiting this workspace. The next attempt waits ${wait} seconds.${suffix}`,
      'PSA_RATE_LIMITED',
      429,
      wait,
    );
  }
  if (input.statusCode >= 500) {
    return new PsaError(
      `${name} could not be reached just now. Nothing was lost; the job is retried.${suffix}`,
      'PSA_UNAVAILABLE',
      502,
    );
  }
  return new PsaError(
    `${name} rejected that request.${suffix || ' Check the ticket settings.'}`,
    'PSA_REJECTED',
    400,
  );
}

/** Retry-After, in seconds, from either header form. */
export function retryAfterSeconds(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(Math.round(seconds), 3600);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    const delta = Math.round((date - Date.now()) / 1000);
    return delta > 0 ? Math.min(delta, 3600) : undefined;
  }
  return undefined;
}
