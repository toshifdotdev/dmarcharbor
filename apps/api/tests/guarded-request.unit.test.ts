import { EventEmitter } from 'node:events';
import type { request as httpsRequest } from 'node:https';
import { afterEach, describe, expect, it } from 'vitest';
import { createGuardedRequester } from '../src/services/net/guarded-request.js';
import { loadMonthlyReportLogo } from '../src/services/reports/monthly-report-logo.js';

/**
 * The pinned outbound request, as webhooks and report logos now use it.
 *
 * The bug this covers: webhook delivery and the report logo checked a name's
 * addresses, then handed the URL to global `fetch`, which resolves the name
 * again at connect time and ignores any `lookup` option. A rebinding name could
 * answer a public address for the check and the metadata service for the
 * connection. These tests resolve once to a public address and a second time
 * to 169.254.169.254, and prove the socket only ever opens to the first.
 */

interface Captured {
  options: Record<string, unknown>;
  connectedTo: string | null;
  body: string;
}

/**
 * A stand-in for node:http(s) `request` that does what the real one does with
 * a `lookup` option: asks it for the address to open the socket to.
 */
function recordingRequest(captured: Captured[], statusCode: number, chunks: string[] = ['ok']) {
  return ((options: Record<string, unknown>, callback: (response: EventEmitter & Record<string, unknown>) => void) => {
    const entry: Captured = { options, connectedTo: null, body: '' };
    captured.push(entry);
    const outgoing = new EventEmitter() as EventEmitter & Record<string, unknown>;
    outgoing.write = (chunk: string) => {
      entry.body += chunk;
      return true;
    };
    outgoing.destroy = () => {};
    outgoing.end = () => {
      const lookup = options.lookup as (host: string, opts: unknown, cb: (...args: unknown[]) => void) => void;
      lookup(String(options.hostname), {}, (_error: unknown, address: unknown) => {
        entry.connectedTo = String(address);
      });
      const response = new EventEmitter() as EventEmitter & Record<string, unknown>;
      response.statusCode = statusCode;
      response.headers = {};
      response.destroy = () => {};
      callback(response);
      setImmediate(() => {
        for (const chunk of chunks) response.emit('data', Buffer.from(chunk, 'utf8'));
        response.emit('end');
      });
    };
    return outgoing;
  }) as unknown as typeof httpsRequest;
}

/** First answer public, every later answer the cloud metadata service. */
function rebindingLookup() {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls === 1
      ? [{ address: '203.0.113.10', family: 4 }]
      : [{ address: '169.254.169.254', family: 4 }];
  };
}

const originalEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = originalEnv;
});

describe('webhook policy', () => {
  it('opens the socket to the address it checked, sending the original name', async () => {
    const captured: Captured[] = [];
    const request = createGuardedRequester({
      lookup: rebindingLookup(),
      request: recordingRequest(captured, 200),
    });

    const result = await request({
      url: 'https://hooks.example.com:8443/dmarc',
      method: 'POST',
      policy: 'webhook',
      body: { kind: 'text', value: '{"id":"evt_1"}', contentType: 'application/json' },
    });

    expect(result).toMatchObject({ status: 'ok', statusCode: 200 });
    expect(captured).toHaveLength(1);
    // The one resolution was checked and pinned; the rebinding answer was never asked for.
    expect(captured[0]!.connectedTo).toBe('203.0.113.10');
    expect(captured[0]!.options.hostname).toBe('hooks.example.com');
    expect(captured[0]!.options.port).toBe(8443);
    expect(captured[0]!.options.agent).toBe(false);
    // Byte for byte: the signature is over exactly this string.
    expect(captured[0]!.body).toBe('{"id":"evt_1"}');
  });

  it('refuses a name whose answer is the metadata service, without connecting', async () => {
    const captured: Captured[] = [];
    const request = createGuardedRequester({
      lookup: async () => [{ address: '169.254.169.254', family: 4 }],
      request: recordingRequest(captured, 200),
    });

    const result = await request({ url: 'https://rebind.example.com/hook', method: 'POST', policy: 'webhook' });
    expect(result).toMatchObject({ status: 'error', failure: 'refused_address' });
    expect(captured).toHaveLength(0);
  });

  it('refuses the metadata address written literally, in every environment', async () => {
    const captured: Captured[] = [];
    const request = createGuardedRequester({ request: recordingRequest(captured, 200) });
    const result = await request({ url: 'https://169.254.169.254/latest/meta-data', method: 'POST', policy: 'webhook' });
    expect(result).toMatchObject({ status: 'error', failure: 'refused_address' });
    expect(captured).toHaveLength(0);
  });

  it('refuses a stored http address in production', async () => {
    process.env.NODE_ENV = 'production';
    const request = createGuardedRequester({ lookup: async () => [{ address: '203.0.113.10', family: 4 }] });
    const result = await request({ url: 'http://hooks.example.com/dmarc', method: 'POST', policy: 'webhook' });
    expect(result).toMatchObject({ status: 'error', failure: 'invalid_url' });
  });

  it('records a redirect as a refusal with its status, and does not follow it', async () => {
    const captured: Captured[] = [];
    const request = createGuardedRequester({
      lookup: async () => [{ address: '203.0.113.10', family: 4 }],
      request: recordingRequest(captured, 302),
    });
    const result = await request({ url: 'https://hooks.example.com/dmarc', method: 'POST', policy: 'webhook' });
    expect(result).toMatchObject({ status: 'error', failure: 'redirect', statusCode: 302 });
    expect(captured).toHaveLength(1);
  });

  it('cuts a large receiver answer short instead of failing the delivery', async () => {
    const captured: Captured[] = [];
    const request = createGuardedRequester({
      lookup: async () => [{ address: '203.0.113.10', family: 4 }],
      request: recordingRequest(captured, 200, ['x'.repeat(40_000), 'y'.repeat(40_000)]),
    });
    const result = await request({
      url: 'https://hooks.example.com/dmarc',
      method: 'POST',
      policy: 'webhook',
      maxBytes: 65_536,
    });
    expect(result).toMatchObject({ status: 'ok', statusCode: 200 });
  });

  it('leaves the strict policy unchanged: port 443 only', async () => {
    const request = createGuardedRequester({ lookup: async () => [{ address: '203.0.113.10', family: 4 }] });
    const result = await request({ url: 'https://psa.example.com:8443/api', method: 'GET' });
    expect(result).toMatchObject({ status: 'error', failure: 'invalid_url' });
  });
});

describe('report logo', () => {
  it('fetches through the pinned requester, so a rebinding host never reaches the metadata service', async () => {
    const captured: Captured[] = [];
    const lookup = rebindingLookup();
    // The logo's own check gets the public answer; the pinned requester
    // resolves again, sees the metadata address, and refuses.
    const result = await loadMonthlyReportLogo('https://cdn.example/logo.png', {
      lookup,
      request: createGuardedRequester({ lookup, request: recordingRequest(captured, 200) }),
    });
    expect(result).toBeNull();
    expect(captured).toHaveLength(0);
  });
});
