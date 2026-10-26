import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { request as httpsRequest } from 'node:https';
import { describe, expect, it, vi } from 'vitest';
import { createHttpsGetter } from '../src/scanner/https-get.js';

interface FakeResponseOptions {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Buffer[];
}

function fakeResponse(options: FakeResponseOptions = {}): PassThrough {
  const response = new PassThrough() as PassThrough & {
    statusCode?: number;
    headers: Record<string, string>;
  };
  response.statusCode = options.status ?? 200;
  response.headers = options.headers ?? {};
  process.nextTick(() => {
    for (const chunk of options.chunks ?? []) {
      response.write(chunk);
    }
    response.end();
  });
  return response;
}

interface FakeRequestControl {
  request: typeof httpsRequest;
  calls: Array<{ options: Record<string, unknown>; response?: PassThrough; error?: NodeJS.ErrnoException }>;
  timeouts: Array<() => void>;
  destroy: ReturnType<typeof vi.fn>;
}

function fakeRequest(mode: 'response' | 'error' | 'timeout' | 'none', options: FakeResponseOptions & { error?: NodeJS.ErrnoException } = {}): FakeRequestControl {
  const control: FakeRequestControl = {
    calls: [],
    timeouts: [],
    destroy: vi.fn(),
    request: ((requestOptions: Record<string, unknown>, callback: (response: PassThrough) => void) => {
      const emitter = new EventEmitter() as EventEmitter & {
        setTimeout: (ms: number, handler: () => void) => void;
        end: () => void;
        destroy: () => void;
      };
      const call: FakeRequestControl['calls'][number] = { options: requestOptions };
      control.calls.push(call);
      emitter.setTimeout = (_ms, handler) => {
        control.timeouts.push(handler);
        return emitter;
      };
      emitter.destroy = () => {
        (control.destroy as unknown as () => void)();
      };
      emitter.end = () => {
        if (mode === 'response') {
          const response = fakeResponse(options);
          call.response = response;
          callback(response);
        } else if (mode === 'error') {
          call.error = options.error ?? Object.assign(new Error('network failed'), { code: 'ECONNREFUSED' });
          emitter.emit('error', call.error);
        }
      };
      return emitter;
    }) as unknown as typeof httpsRequest,
  };
  return control;
}

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

describe('guarded HTTPS getter URL and address rules', () => {
  it.each([
    'http://example.test/policy',
    'https://user:pass@example.test/policy',
    'https://example.test:8443/policy',
    'not a url',
  ])('refuses %s as invalid_url', async (url) => {
    const control = fakeRequest('none');
    const lookup = vi.fn(publicLookup);
    const getter = createHttpsGetter({ lookup, request: control.request });

    const result = await getter.get(url, { maxBytes: 100, accept: 'text/plain' });

    expect(result).toMatchObject({ status: 'error', failure: 'invalid_url' });
    expect(lookup).not.toHaveBeenCalled();
    expect(control.calls).toHaveLength(0);
  });

  it.each(['10.0.0.1', '127.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1'])(
    'refuses the private answer %s under NODE_ENV=test',
    async (address) => {
      const control = fakeRequest('none');
      const getter = createHttpsGetter({
        lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
        request: control.request,
      });

      const result = await getter.get('https://example.test/policy', { maxBytes: 100, accept: 'text/plain' });
      expect(result).toMatchObject({ status: 'error', failure: 'refused_address' });
      expect(control.calls).toHaveLength(0);
    },
  );

  it('refuses a hostname with one public and one private answer', async () => {
    const control = fakeRequest('none');
    const getter = createHttpsGetter({
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
      request: control.request,
    });

    const result = await getter.get('https://example.test/policy', { maxBytes: 100, accept: 'text/plain' });
    expect(result).toMatchObject({ status: 'error', failure: 'refused_address' });
    expect(control.calls).toHaveLength(0);
  });

  it('pins the request lookup to the checked address', async () => {
    const control = fakeRequest('response', { chunks: [Buffer.from('ok')] });
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    const getter = createHttpsGetter({ lookup, request: control.request });

    const result = await getter.get('https://example.test/policy', { maxBytes: 100, accept: 'text/plain' });
    expect(result.status).toBe('ok');
    expect(lookup).toHaveBeenCalledTimes(1);

    const pinned = control.calls[0]?.options.lookup as (
      host: string,
      options: unknown,
      callback: (error: Error | null, address: string, family: number) => void,
    ) => void;
    const callback = vi.fn();
    pinned('example.test', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);

    // Node asks with all: true when autoSelectFamily is on (its default).
    const allCallback = vi.fn();
    pinned('example.test', { all: true }, allCallback);
    expect(allCallback).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe('guarded HTTPS getter responses', () => {
  it('refuses a redirect and any non-200 status', async () => {
    const redirectControl = fakeRequest('response', { status: 301 });
    const redirect = await createHttpsGetter({ lookup: publicLookup, request: redirectControl.request }).get(
      'https://example.test/policy',
      { maxBytes: 100, accept: 'text/plain' },
    );
    expect(redirect).toMatchObject({ status: 'error', failure: 'redirect', statusCode: 301 });

    const missingControl = fakeRequest('response', { status: 404 });
    const missing = await createHttpsGetter({ lookup: publicLookup, request: missingControl.request }).get(
      'https://example.test/policy',
      { maxBytes: 100, accept: 'text/plain' },
    );
    expect(missing).toMatchObject({ status: 'error', failure: 'http_status', statusCode: 404 });
  });

  it('refuses a declared content length over the cap without reading', async () => {
    const control = fakeRequest('response', { headers: { 'content-length': '101' } });
    const result = await createHttpsGetter({ lookup: publicLookup, request: control.request }).get(
      'https://example.test/policy',
      { maxBytes: 100, accept: 'text/plain' },
    );

    expect(result).toMatchObject({ status: 'error', failure: 'too_large' });
    expect(control.destroy).toHaveBeenCalled();
  });

  it('stops a streamed body that passes the cap and destroys the request', async () => {
    const control = fakeRequest('response', { chunks: [Buffer.alloc(60), Buffer.alloc(60)] });
    const result = await createHttpsGetter({ lookup: publicLookup, request: control.request }).get(
      'https://example.test/policy',
      { maxBytes: 100, accept: 'text/plain' },
    );

    expect(result).toMatchObject({ status: 'error', failure: 'too_large' });
    expect(control.destroy).toHaveBeenCalled();
  });

  it('returns the body and content type on success', async () => {
    const control = fakeRequest('response', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      chunks: [Buffer.from('version: STSv1')],
    });
    const result = await createHttpsGetter({ lookup: publicLookup, request: control.request }).get(
      'https://example.test/.well-known/mta-sts.txt',
      { maxBytes: 100, accept: 'text/plain' },
    );

    expect(result).toMatchObject({ status: 'ok', statusCode: 200, contentType: 'text/plain; charset=utf-8' });
    if (result.status === 'ok') {
      expect(result.body.toString()).toBe('version: STSv1');
    }
  });

  it('maps TLS errors and DNS errors', async () => {
    const tlsControl = fakeRequest('error', {
      error: Object.assign(new Error('certificate mismatch'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
    });
    const tls = await createHttpsGetter({ lookup: publicLookup, request: tlsControl.request }).get(
      'https://example.test/policy',
      { maxBytes: 100, accept: 'text/plain' },
    );
    expect(tls).toMatchObject({ status: 'error', failure: 'tls' });
    if (tls.status === 'error') {
      expect(tls.detail).toContain('certificate');
    }

    const dnsControl = fakeRequest('error', { error: Object.assign(new Error('not found'), { code: 'ENOTFOUND' }) });
    const dns = await createHttpsGetter({ lookup: publicLookup, request: dnsControl.request }).get(
      'https://example.test/policy',
      { maxBytes: 100, accept: 'text/plain' },
    );
    expect(dns).toMatchObject({ status: 'error', failure: 'dns' });

    const sslControl = fakeRequest('error', {
      error: Object.assign(new Error('wrong version number'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }),
    });
    const ssl = await createHttpsGetter({ lookup: publicLookup, request: sslControl.request }).get(
      'https://example.test/policy',
      { maxBytes: 100, accept: 'text/plain' },
    );
    expect(ssl).toMatchObject({ status: 'error', failure: 'tls' });
  });

  it('times out and destroys the request', async () => {
    const control = fakeRequest('timeout');
    const promise = createHttpsGetter({ lookup: publicLookup, request: control.request, timeoutMs: 5 }).get(
      'https://example.test/policy',
      { maxBytes: 100, accept: 'text/plain' },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    control.timeouts[0]!();
    const result = await promise;

    expect(result).toMatchObject({ status: 'error', failure: 'timeout' });
    expect(control.destroy).toHaveBeenCalled();
  });
});
