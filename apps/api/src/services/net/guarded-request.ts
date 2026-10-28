import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { assertPublicHost, isPrivateOrReservedHost } from '../net-guard.js';
/**
 * The only way this service talks to a customer's PSA.
 *
 * A PSA endpoint is a hostname the customer typed (Halo's servers, an
 * on-premises ConnectWise site) or one discovered from a vendor API (the
 * Autotask zone). Both are server-side request forgery by construction: the
 * whole point is that we connect somewhere they chose. So every call goes
 * through the same three steps the scanner's HTTPS fetcher uses:
 *
 *   1. refuse anything that is not https on port 443 with no credentials in the
 *      URL,
 *   2. resolve the name, refuse if any answer is private or reserved, and
 *   3. pin the socket to the address that passed, so the name is never resolved
 *      a second time between the check and the connection.
 *
 * Redirects are never followed. A 3xx from a PSA is either a misconfigured base
 * URL or an attempt to move the request somewhere the check never saw, and both
 * should be reported rather than obeyed.
 *
 * `createGuardedRequester` exists so the refusals can be tested without a
 * network, and `setGuardedRequestForTests` so the integration suite can run the
 * adapters against in-memory PSAs. Nothing else may substitute for this module:
 * global fetch here would be unpinned and unguarded.
 */

export type GuardedFailure =
  | 'invalid_url'
  | 'refused_address'
  | 'dns'
  | 'tls'
  | 'timeout'
  | 'redirect'
  | 'too_large'
  | 'network';

export interface GuardedResponse {
  status: 'ok';
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface GuardedFailureResult {
  status: 'error';
  failure: GuardedFailure;
  statusCode?: number;
  detail: string;
}

export type GuardedResult = GuardedResponse | GuardedFailureResult;

export interface GuardedRequestInput {
  url: string;
  method: 'GET' | 'POST' | 'PATCH';
  headers?: Record<string, string>;
  /** A JSON value, or already-encoded form fields. */
  body?: { kind: 'json'; value: unknown } | { kind: 'form'; value: Record<string, string> };
  /** Defaults to 1 MB. */
  maxBytes?: number;
  /** Defaults to 15 seconds. */
  timeoutMs?: number;
}

/** The request as it would leave, so a fake can assert on it exactly. */
export interface GuardedRequestSpec {
  url: string;
  method: 'GET' | 'POST' | 'PATCH';
  headers: Record<string, string>;
  body: string | null;
}

export type GuardedRequester = (input: GuardedRequestInput) => Promise<GuardedResult>;
export type GuardedTransport = (spec: GuardedRequestSpec) => Promise<GuardedResult>;

const defaultMaxBytes = 1_048_576;
const defaultTimeoutMs = 15_000;

type LookupAnswer = Array<{ address: string; family: number }>;
type Lookup = (hostname: string) => Promise<LookupAnswer>;

function specFor(input: GuardedRequestInput): GuardedRequestSpec {
  const headers: Record<string, string> = { accept: 'application/json', ...(input.headers ?? {}) };
  let body: string | null = null;
  if (input.body?.kind === 'json') {
    body = JSON.stringify(input.body.value);
    headers['content-type'] = headers['content-type'] ?? 'application/json';
  } else if (input.body?.kind === 'form') {
    body = new URLSearchParams(input.body.value).toString();
    headers['content-type'] = headers['content-type'] ?? 'application/x-www-form-urlencoded';
  }
  if (body !== null) {
    headers['content-length'] = String(Buffer.byteLength(body));
  }
  return { url: input.url, method: input.method, headers, body };
}

/** Everything the URL itself can be refused for, before any DNS is asked. */
export function refuseUrl(raw: string): GuardedFailureResult | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { status: 'error', failure: 'invalid_url', detail: 'That address is not a valid URL.' };
  }
  if (url.protocol !== 'https:') {
    return {
      status: 'error',
      failure: 'invalid_url',
      detail: 'PSA calls must use https. A plain http address would send credentials in clear text.',
    };
  }
  if (url.port && url.port !== '443') {
    return {
      status: 'error',
      failure: 'invalid_url',
      detail: 'PSA calls must use port 443, which is the only port https is served on here.',
    };
  }
  if (url.username || url.password) {
    return {
      status: 'error',
      failure: 'invalid_url',
      detail: 'An address must not carry a username or password; the credentials are sent separately.',
    };
  }
  if (url.hash) {
    return { status: 'error', failure: 'invalid_url', detail: 'An address must not carry a fragment.' };
  }
  if (isPrivateOrReservedHost(url.hostname)) {
    return {
      status: 'error',
      failure: 'refused_address',
      detail: 'That host is private or reserved, so it cannot be reached from this service.',
    };
  }
  return null;
}

export function createGuardedRequester(
  deps: { lookup?: Lookup; request?: typeof httpsRequest; transport?: GuardedTransport } = {},
): GuardedRequester {
  const lookup: Lookup =
    deps.lookup ??
    ((hostname: string) =>
      new Promise<LookupAnswer>((resolve, reject) => {
        dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(addresses as LookupAnswer);
        });
      }));
  const request = deps.request ?? httpsRequest;
  const transport = deps.transport;

  return async (input) => {
    const spec = specFor(input);
    const refused = refuseUrl(spec.url);
    if (refused) return refused;

    if (transport) {
      return transport(spec);
    }

    const url = new URL(spec.url);
    const maxBytes = input.maxBytes ?? defaultMaxBytes;
    const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;

    /**
     * `assertPublicHost` does the resolve-and-check, and its answers are the
     * ones pinned below. Resolving again to connect would reopen the window
     * this closes.
     */
    let checked: LookupAnswer;
    try {
      checked = (await assertPublicHost(url.hostname, lookup)) as LookupAnswer;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const refused = /private or reserved/i.test(message);
      return {
        status: 'error',
        failure: refused ? 'refused_address' : 'dns',
        detail: refused
          ? `${url.hostname} resolves to a private or reserved address.`
          : `${url.hostname} could not be resolved.`,
      };
    }
    const pinned = checked[0]!;

    return new Promise<GuardedResult>((resolve) => {
      let settled = false;
      const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
      const finish = (result: GuardedResult): void => {
        if (settled) return;
        settled = true;
        if (deadline.timer) clearTimeout(deadline.timer);
        resolve(result);
      };

      let outgoing: ReturnType<typeof httpsRequest>;
      try {
        outgoing = request(
          {
            method: spec.method,
            hostname: url.hostname,
            port: 443,
            // No pooled socket: a reused connection would skip the pinned
            // lookup below and outlive this request.
            agent: false,
            path: `${url.pathname}${url.search}`,
            headers: spec.headers,
            // Pins the socket to the address that passed the checks above.
            lookup: ((_host: string, lookupOptions: unknown, callback: (...args: unknown[]) => void) => {
              const wantsAll = (lookupOptions as { all?: boolean } | undefined)?.all === true;
              if (wantsAll) {
                callback(null, [{ address: pinned.address, family: pinned.family }]);
                return;
              }
              callback(null, pinned.address, pinned.family);
            }) as never,
          },
          (response) => {
            const statusCode = response.statusCode ?? 0;
            if (statusCode >= 300 && statusCode < 400) {
              response.destroy();
              outgoing?.destroy();
              finish({
                status: 'error',
                failure: 'redirect',
                statusCode,
                detail: 'The server returned a redirect. Redirects are not followed because they can bypass the address check.',
              });
              return;
            }

            const declared = Number(response.headers['content-length'] ?? '');
            if (Number.isFinite(declared) && declared > maxBytes) {
              response.destroy();
              outgoing?.destroy();
              finish({
                status: 'error',
                failure: 'too_large',
                detail: `The response is larger than the ${maxBytes}-byte limit.`,
              });
              return;
            }

            const chunks: Buffer[] = [];
            let total = 0;
            response.on('data', (chunk: Buffer) => {
              if (settled) return;
              total += chunk.length;
              if (total > maxBytes) {
                response.destroy();
                outgoing?.destroy();
                finish({
                  status: 'error',
                  failure: 'too_large',
                  detail: `The response passed the ${maxBytes}-byte limit while being read.`,
                });
                return;
              }
              chunks.push(chunk);
            });
            response.on('end', () => {
              if (settled) return;
              finish({
                status: 'ok',
                statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks),
              });
            });
            response.on('error', (error: NodeJS.ErrnoException) => {
              finish({
                status: 'error',
                failure: error.code === 'ETIMEDOUT' ? 'timeout' : 'network',
                detail: 'The PSA closed the connection before answering.',
              });
            });
          },
        );
      } catch {
        finish({ status: 'error', failure: 'network', detail: 'The request could not be opened.' });
        return;
      }

      deadline.timer = setTimeout(() => {
        outgoing?.destroy();
        finish({
          status: 'error',
          failure: 'timeout',
          detail: `The PSA did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
        });
      }, timeoutMs);
      deadline.timer.unref?.();

      outgoing.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ETIMEDOUT') {
          finish({ status: 'error', failure: 'timeout', detail: 'The PSA did not answer in time.' });
          return;
        }
        if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
          finish({ status: 'error', failure: 'dns', detail: 'The PSA host could not be resolved.' });
          return;
        }
        if (error.code?.startsWith('ERR_TLS') || error.code === 'EPROTO' || error.code === 'CERT_HAS_EXPIRED') {
          finish({
            status: 'error',
            failure: 'tls',
            detail: 'The PSA presented a certificate this service will not accept.',
          });
          return;
        }
        finish({ status: 'error', failure: 'network', detail: 'The connection to the PSA failed.' });
      });

      if (spec.body !== null) {
        outgoing.write(spec.body);
      }
      outgoing.end();
    });
  };
}

export const guardedRequest: GuardedRequester = createGuardedRequester();

let transportOverride: GuardedTransport | null = null;

/**
 * Replaces the network with a fake, for tests only.
 *
 * The URL is still validated by the real code path, so a test cannot
 * accidentally prove that an http address works.
 */
export function setGuardedTransportForTests(transport: GuardedTransport | null): void {
  transportOverride = transport;
}

/** The requester every adapter uses: the real one, or the test transport. */
export function psaRequest(input: GuardedRequestInput): Promise<GuardedResult> {
  return (transportOverride ? createGuardedRequester({ transport: transportOverride }) : guardedRequest)(
    input,
  );
}
