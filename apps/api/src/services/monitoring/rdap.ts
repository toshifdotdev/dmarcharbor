import { createGuardedRequester, type GuardedRequester } from '../net/guarded-request.js';

/**
 * Registration expiry over RDAP (RFC 9082 / 9083).
 *
 * RDAP is WHOIS with a JSON answer and a published directory of who to ask:
 * IANA's bootstrap file maps each TLD to its registry's RDAP base URL
 * (RFC 9224). We ask the registry, not a third-party aggregator, so the date
 * is the registry's own and nothing about the domain list leaves for a
 * commercial service.
 *
 * Every request goes through the pinned outbound helper with the strict policy
 * (https, port 443, private answers refused, no redirects). The bootstrap file
 * is public and its URLs are registries', but the helper costs nothing and
 * means no code path here can be talked into a request somewhere internal.
 */

export const rdapBootstrapUrl = 'https://data.iana.org/rdap/dns.json';

/** How long the bootstrap file is trusted before it is read again. */
const bootstrapTtlMs = 24 * 60 * 60 * 1000;
const lookupTimeoutMs = 8_000;

export type RdapStatus = 'ok' | 'no_expiry' | 'unsupported' | 'not_found' | 'error';

export interface RdapResult {
  status: RdapStatus;
  expiresAt: Date | null;
  registrar: string | null;
  /** Readable, for the row's lastError; never a registry's raw body. */
  error: string | null;
}

let requesterOverride: GuardedRequester | null = null;
let bootstrapCache: { fetchedAt: number; services: Map<string, string> } | null = null;

/** Test seam: an in-memory registry instead of the network. */
export function setRdapRequesterForTests(requester: GuardedRequester | null): void {
  requesterOverride = requester;
  bootstrapCache = null;
}

const defaultRequester = createGuardedRequester();

function requester(): GuardedRequester {
  return requesterOverride ?? defaultRequester;
}

/**
 * The bootstrap file, as TLD to base URL.
 *
 * `services` is a list of `[[tlds...], [urls...]]`. An https URL is preferred,
 * and it is the only kind the strict policy will call anyway.
 */
export function parseBootstrap(json: unknown): Map<string, string> {
  const services = new Map<string, string>();
  const list = (json as { services?: unknown } | null)?.services;
  if (!Array.isArray(list)) return services;

  for (const entry of list) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [tlds, urls] = entry as [unknown, unknown];
    if (!Array.isArray(tlds) || !Array.isArray(urls)) continue;
    const base = urls.find((url): url is string => typeof url === 'string' && url.startsWith('https://'));
    if (!base) continue;
    for (const tld of tlds) {
      if (typeof tld === 'string' && tld.trim()) {
        services.set(tld.trim().toLowerCase(), base.endsWith('/') ? base : `${base}/`);
      }
    }
  }
  return services;
}

async function bootstrap(now: number): Promise<Map<string, string> | null> {
  if (bootstrapCache && now - bootstrapCache.fetchedAt < bootstrapTtlMs) {
    return bootstrapCache.services;
  }

  const response = await requester()({
    url: rdapBootstrapUrl,
    method: 'GET',
    headers: { accept: 'application/json' },
    timeoutMs: lookupTimeoutMs,
  });
  if (response.status !== 'ok' || response.statusCode !== 200) {
    // A stale copy beats no copy: the directory changes a few times a year.
    return bootstrapCache?.services ?? null;
  }

  try {
    const services = parseBootstrap(JSON.parse(response.body.toString('utf8')));
    if (services.size === 0) return bootstrapCache?.services ?? null;
    bootstrapCache = { fetchedAt: now, services };
    return services;
  } catch {
    return bootstrapCache?.services ?? null;
  }
}

interface RdapEntity {
  roles?: unknown;
  vcardArray?: unknown;
  publicIds?: unknown;
}

/** The registrar's display name, from the entity whose roles include "registrar". */
function registrarName(entities: unknown): string | null {
  if (!Array.isArray(entities)) return null;
  for (const entity of entities as RdapEntity[]) {
    if (!Array.isArray(entity?.roles) || !entity.roles.includes('registrar')) continue;
    const vcard = Array.isArray(entity.vcardArray) ? entity.vcardArray[1] : null;
    if (Array.isArray(vcard)) {
      for (const property of vcard) {
        if (Array.isArray(property) && property[0] === 'fn' && typeof property[3] === 'string' && property[3].trim()) {
          return property[3].trim().slice(0, 200);
        }
      }
    }
  }
  return null;
}

/** Reads a registry's domain answer. Exported for the unit tests. */
export function parseRdapDomain(json: unknown): Pick<RdapResult, 'expiresAt' | 'registrar'> {
  const body = (json ?? {}) as { events?: unknown; entities?: unknown };
  let expiresAt: Date | null = null;
  if (Array.isArray(body.events)) {
    for (const event of body.events as Array<{ eventAction?: unknown; eventDate?: unknown }>) {
      if (event?.eventAction === 'expiration' && typeof event.eventDate === 'string') {
        const parsed = new Date(event.eventDate);
        if (!Number.isNaN(parsed.getTime())) {
          expiresAt = parsed;
          break;
        }
      }
    }
  }
  return { expiresAt, registrar: registrarName(body.entities) };
}

/**
 * Looks one registrable domain up.
 *
 * Never throws. Each outcome is a status the page can say in words: the
 * registry gave a date, gave no date (several ccTLDs never publish one), has
 * no RDAP service, does not know the name, or could not be asked just now.
 */
export async function lookupRegistration(name: string, now: Date = new Date()): Promise<RdapResult> {
  const domain = name.trim().toLowerCase().replace(/\.+$/, '');
  const tld = domain.split('.').pop() ?? '';
  const empty = { expiresAt: null, registrar: null };

  let services: Map<string, string> | null;
  try {
    services = await bootstrap(now.getTime());
  } catch {
    services = null;
  }
  if (!services) {
    return { status: 'error', ...empty, error: 'The IANA RDAP directory could not be read just now.' };
  }

  const base = services.get(tld);
  if (!base) {
    return {
      status: 'unsupported',
      ...empty,
      error: `The .${tld} registry does not publish registration data over RDAP.`,
    };
  }

  const response = await requester()({
    url: `${base}domain/${encodeURIComponent(domain)}`,
    method: 'GET',
    headers: { accept: 'application/rdap+json, application/json' },
    timeoutMs: lookupTimeoutMs,
  });

  if (response.status !== 'ok') {
    return { status: 'error', ...empty, error: `The .${tld} registry could not be reached: ${response.detail}` };
  }
  if (response.statusCode === 404) {
    return { status: 'not_found', ...empty, error: `The .${tld} registry has no record of ${domain}.` };
  }
  if (response.statusCode === 429) {
    return { status: 'error', ...empty, error: `The .${tld} registry is rate limiting lookups. It is tried again tomorrow.` };
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return { status: 'error', ...empty, error: `The .${tld} registry answered ${response.statusCode}.` };
  }

  let parsed: Pick<RdapResult, 'expiresAt' | 'registrar'>;
  try {
    parsed = parseRdapDomain(JSON.parse(response.body.toString('utf8')));
  } catch {
    return { status: 'error', ...empty, error: `The .${tld} registry answered with something that was not JSON.` };
  }

  if (!parsed.expiresAt) {
    return {
      status: 'no_expiry',
      expiresAt: null,
      registrar: parsed.registrar,
      error: null,
    };
  }
  return { status: 'ok', expiresAt: parsed.expiresAt, registrar: parsed.registrar, error: null };
}
