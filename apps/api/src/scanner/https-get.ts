import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isPrivateOrReservedHost } from '../services/net-guard.js';
import { isNonPublicIp } from '../services/senders/ip-intel.service.js';

/**
 * The one way this scanner fetches a URL found in DNS.
 *
 * A public scan accepts any domain, and that domain's owner chooses what
 * mta-sts.<domain> and the BIMI l= URL resolve to. Without a strict guard this
 * is a request forwarder into the private network: the classic SSRF, aimed at
 * the cloud metadata service or an internal admin port.
 *
 * The connection is pinned to an address that was checked before the request.
 * Resolving once for the check and letting the request resolve again is a
 * time-of-check/time-of-use race: the second answer can be private. The lookup
 * option below only ever returns the address already inspected.
 */

export type HttpsFailure =
  | 'invalid_url'
  | 'refused_address'
  | 'dns'
  | 'tls'
  | 'timeout'
  | 'redirect'
  | 'http_status'
  | 'too_large'
  | 'network';

export type HttpsGetResult =
  | { status: 'ok'; statusCode: 200; contentType: string | null; body: Buffer }
  | { status: 'error'; failure: HttpsFailure; statusCode?: number; detail: string };

export interface HttpsGetter {
  get(url: string, options: { maxBytes: number; accept: string }): Promise<HttpsGetResult>;
}

type LookupAnswer = Array<{ address: string; family: number }>;
type Lookup = (hostname: string) => Promise<LookupAnswer>;

export function createHttpsGetter(deps: {
  lookup?: Lookup;
  request?: typeof httpsRequest;
  timeoutMs?: number;
} = {}): HttpsGetter {
  const lookup = deps.lookup ?? (async (hostname) =>
    dnsLookup(hostname, { all: true, verbatim: true }));
  const request = deps.request ?? httpsRequest;
  const timeoutMs = deps.timeoutMs ?? 5_000;

  return {
    get(url, options) {
      return fetchGuarded(url, options, { lookup, request, timeoutMs });
    },
  };
}

interface GuardedDeps {
  lookup: Lookup;
  request: typeof httpsRequest;
  timeoutMs: number;
}

function plainAddress(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, '');
}

function mappedIpv4(value: string): string | null {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(plainAddress(value));
  return match?.[1] ?? null;
}

function reservedAddress(value: string): boolean {
  const address = plainAddress(value);
  if (isPrivateOrReservedHost(address) || isNonPublicIp(address)) {
    return true;
  }
  const mapped = mappedIpv4(address);
  return mapped ? isPrivateOrReservedHost(mapped) || isNonPublicIp(mapped) : false;
}

function tlsDetail(hostname: string, error: NodeJS.ErrnoException): string {
  if (
    error.code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    error.code === 'CERT_HAS_EXPIRED' ||
    error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    error.code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    error.code === 'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED'
  ) {
    return `The certificate is not valid for ${hostname}.`;
  }
  return `TLS failed while connecting to ${hostname}: ${error.message || 'unknown TLS error'}.`;
}

function failureOf(error: NodeJS.ErrnoException, hostname: string): HttpsGetResult {
  const code = error.code ?? '';
  if (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EAI_FAIL' ||
    code === 'ENODATA' ||
    code === 'ESERVFAIL' ||
    code === 'EREFUSED'
  ) {
    return { status: 'error', failure: 'dns', detail: `${hostname} could not be resolved.` };
  }
  if (
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_') ||
    code.startsWith('CERT_') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'EPROTO'
  ) {
    return { status: 'error', failure: 'tls', detail: tlsDetail(hostname, error) };
  }
  return {
    status: 'error',
    failure: 'network',
    detail: `The request to ${hostname} failed: ${error.message || 'unknown network error'}.`,
  };
}

async function fetchGuarded(
  rawUrl: string,
  options: { maxBytes: number; accept: string },
  deps: GuardedDeps,
): Promise<HttpsGetResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { status: 'error', failure: 'invalid_url', detail: 'The URL could not be parsed.' };
  }

  if (parsed.protocol !== 'https:') {
    return { status: 'error', failure: 'invalid_url', detail: 'Only https URLs can be fetched.' };
  }
  if (parsed.username || parsed.password) {
    return { status: 'error', failure: 'invalid_url', detail: 'A URL with a username or password is refused.' };
  }
  if (parsed.port && parsed.port !== '443') {
    return { status: 'error', failure: 'invalid_url', detail: 'Only port 443 is allowed.' };
  }

  const hostname = plainAddress(parsed.hostname);
  if (!hostname || isPrivateOrReservedHost(hostname)) {
    return { status: 'error', failure: 'refused_address', detail: 'That host is private or reserved.' };
  }

  let answers: LookupAnswer;
  try {
    answers = await deps.lookup(hostname);
  } catch {
    return { status: 'error', failure: 'dns', detail: `${hostname} could not be resolved.` };
  }

  if (!Array.isArray(answers) || answers.length === 0) {
    return { status: 'error', failure: 'refused_address', detail: `${hostname} resolved to no addresses.` };
  }

  for (const answer of answers) {
    if (!answer?.address || reservedAddress(answer.address)) {
      return {
        status: 'error',
        failure: 'refused_address',
        detail: `${hostname} resolves to a private or reserved address.`,
      };
    }
  }

  const pinned = answers[0]!;

  return new Promise<HttpsGetResult>((resolve) => {
    let settled = false;
    const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
    const finish = (result: HttpsGetResult): void => {
      if (settled) return;
      settled = true;
      if (deadline.timer) clearTimeout(deadline.timer);
      resolve(result);
    };

    let request: ReturnType<typeof httpsRequest>;
    try {
      request = deps.request(
        {
          method: 'GET',
          hostname,
          port: 443,
          // No shared agent: Node 20+ keeps sockets alive by default, and a
          // pooled socket would skip the pinned lookup below and outlive the
          // scan. One request, one connection.
          agent: false,
          path: `${parsed.pathname}${parsed.search}`,
          headers: {
            accept: options.accept,
            'user-agent': 'DMARC-Harbor-Scanner/1',
          },
          // Pins the socket to the address that passed the checks above. The
          // resolver is not consulted again. Node asks with all: true when
          // autoSelectFamily is on (the default), and then expects an array.
          lookup: ((_host: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) => {
            if (lookupOptions?.all) {
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
            request?.destroy();
            finish({
              status: 'error',
              failure: 'redirect',
              statusCode,
              detail: 'The address returned a redirect. Redirects are not followed because they can bypass the address check.',
            });
            return;
          }
          if (statusCode !== 200) {
            response.destroy();
            request?.destroy();
            finish({
              status: 'error',
              failure: 'http_status',
              statusCode,
              detail: `The server answered HTTP ${statusCode} instead of 200.`,
            });
            return;
          }

          const declared = Number(response.headers['content-length'] ?? '');
          if (Number.isFinite(declared) && declared > options.maxBytes) {
            response.destroy();
            request?.destroy();
            finish({
              status: 'error',
              failure: 'too_large',
              detail: `The response is larger than the ${options.maxBytes}-byte limit.`,
            });
            return;
          }

          const chunks: Buffer[] = [];
          let total = 0;
          response.on('data', (chunk: Buffer) => {
            if (settled) return;
            total += chunk.length;
            if (total > options.maxBytes) {
              response.destroy();
              request?.destroy();
              finish({
                status: 'error',
                failure: 'too_large',
                detail: `The response passed the ${options.maxBytes}-byte limit while being read.`,
              });
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (settled) return;
            const header = response.headers['content-type'];
            finish({
              status: 'ok',
              statusCode: 200,
              contentType: Array.isArray(header) ? (header[0] ?? null) : (header ?? null),
              body: Buffer.concat(chunks),
            });
          });
          response.on('error', (error: NodeJS.ErrnoException) => {
            finish(failureOf(error, hostname));
          });
        },
      );
    } catch (error) {
      finish(failureOf(error as NodeJS.ErrnoException, hostname));
      return;
    }

    request.setTimeout(deps.timeoutMs, () => {
      request.destroy();
      finish({
        status: 'error',
        failure: 'timeout',
        detail: `The request did not finish within ${deps.timeoutMs} ms.`,
      });
    });

    // request.setTimeout is an inactivity timer; this is the absolute deadline
    // covering connect and the whole body.
    deadline.timer = setTimeout(() => {
      request.destroy();
      finish({
        status: 'error',
        failure: 'timeout',
        detail: `The request did not finish within ${deps.timeoutMs} ms.`,
      });
    }, deps.timeoutMs);

    request.on('error', (error: NodeJS.ErrnoException) => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNRESET' && settled) return;
      finish(failureOf(error, hostname));
    });

    request.end();
  });
}

export const systemHttpsGetter: HttpsGetter = createHttpsGetter();
