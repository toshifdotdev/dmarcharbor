import { EventEmitter } from 'node:events';
import type { request as httpsRequest } from 'node:https';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import {
  buildTicketTitle,
  newTicketReference,
  psaErrorForStatus,
  referenceMarker,
  retryAfterSeconds,
  titleLimits,
} from '../src/services/psa/provider.js';
import { createHaloPsaClient } from '../src/services/psa/providers/halopsa.js';
import { createConnectWiseClient } from '../src/services/psa/providers/connectwise.js';
import { acceptAutotaskZone, createAutotaskClient } from '../src/services/psa/providers/autotask.js';
import {
  createGuardedRequester,
  setGuardedTransportForTests,
  type GuardedRequestSpec,
  type GuardedResult,
} from '../src/services/net/guarded-request.js';

/**
 * What the adapters send, and what the guard refuses.
 *
 * Every request is captured at the transport seam, so the assertions are on the
 * exact method, path, headers and body each vendor documents. The vendors'
 * field names are unverified against a live instance — that is why they are
 * written down here, in one place, where a later correction is a one-line diff.
 */

const settings = {
  ticketQueueId: '3',
  ticketTypeId: '7',
  openStatusId: '11',
  closedStatusId: '22',
  priorityId: '4',
};

function ok(body: unknown, statusCode = 200): GuardedResult {
  return {
    status: 'ok',
    statusCode,
    headers: {},
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'),
  };
}

let calls: GuardedRequestSpec[] = [];
let responder: (spec: GuardedRequestSpec) => GuardedResult = () => ok({});

beforeEach(() => {
  calls = [];
  responder = () => ok({});
  setGuardedTransportForTests(async (spec) => {
    calls.push(spec);
    return responder(spec);
  });
});

afterEach(() => {
  setGuardedTransportForTests(null);
  env.PSA_CONNECTWISE_CLIENT_ID = undefined;
});

describe('HaloPSA requests', () => {
  const credentials = {
    resourceServer: 'https://acme.halopsa.com',
    clientId: 'halo-client',
    clientSecret: 'halo-secret',
    authServer: 'https://acme.halopsa.com/auth',
  };

  it('exchanges client credentials for a token, form-encoded', async () => {
    responder = (spec) =>
      spec.url.endsWith('/token') ? ok({ access_token: 'tok-1', expires_in: 3600 }) : ok([]);

    const client = createHaloPsaClient({ credentials, baseUrl: 'https://acme.halopsa.com', settings });
    await client.test();

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://acme.halopsa.com/auth/token');
    expect(calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0]!.body).toContain('grant_type=client_credentials');
    expect(calls[0]!.body).toContain('client_id=halo-client');
    expect(calls[0]!.body).toContain('scope=all');

    expect(calls[1]!.url).toBe('https://acme.halopsa.com/api/Client?count=1');
    expect(calls[1]!.headers.authorization).toBe('Bearer tok-1');
  });

  it('sends a ticket as a one-element array with the documented fields', async () => {
    responder = (spec) => {
      if (spec.url.endsWith('/token')) return ok({ access_token: 'tok-1', expires_in: 3600 });
      return ok([{ id: 4321 }]);
    };

    const client = createHaloPsaClient({ credentials, baseUrl: 'https://acme.halopsa.com', settings });
    const created = await client.createTicket({
      companyId: '9',
      title: 'DMARC Harbor: example.com: failures [DH-abcdefgh]',
      body: 'details',
      reference: 'abcdefgh',
      settings,
    });

    const post = calls.find((spec) => spec.url.endsWith('/api/Tickets'))!;
    const body = JSON.parse(post.body!) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      summary: 'DMARC Harbor: example.com: failures [DH-abcdefgh]',
      details: 'details',
      client_id: 9,
      tickettype_id: 7,
      status_id: 11,
      team_id: 3,
      priority_id: 4,
    });
    expect(created).toEqual({ id: '4321', url: 'https://acme.halopsa.com/tickets?id=4321' });
  });

  it('adds an internal note through /api/Actions', async () => {
    responder = (spec) =>
      spec.url.endsWith('/token') ? ok({ access_token: 'tok-1', expires_in: 3600 }) : ok({});

    const client = createHaloPsaClient({ credentials, baseUrl: 'https://acme.halopsa.com', settings });
    await client.addNote('4321', 'Acknowledged in DMARC Harbor by Sam.');

    const action = calls.find((spec) => spec.url.endsWith('/api/Actions'))!;
    const body = JSON.parse(action.body!) as Array<Record<string, unknown>>;
    expect(body[0]).toMatchObject({
      ticket_id: 4321,
      note: 'Acknowledged in DMARC Harbor by Sam.',
      outcome: 'Note',
      hiddenfromuser: true,
    });
  });

  it('finds an existing ticket by its marker, never by a bare id', async () => {
    responder = (spec) => {
      if (spec.url.endsWith('/token')) return ok({ access_token: 'tok-1', expires_in: 3600 });
      return ok([{ id: 4321, summary: 'DMARC Harbor: example.com: x [DH-abcdefgh]' }]);
    };

    const client = createHaloPsaClient({ credentials, baseUrl: 'https://acme.halopsa.com', settings });
    const found = await client.findTicketByReference('9', 'abcdefgh');

    const search = calls.find((spec) => spec.url.includes('/api/Tickets?client_id='))!;
    expect(search.url).toContain('client_id=9');
    expect(search.url).toContain(encodeURIComponent('[DH-abcdefgh]'));
    expect(found?.id).toBe('4321');
  });

  it('closes by posting the id and the closed status', async () => {
    responder = (spec) =>
      spec.url.endsWith('/token') ? ok({ access_token: 'tok-1', expires_in: 3600 }) : ok([{ id: 4321 }]);

    const client = createHaloPsaClient({ credentials, baseUrl: 'https://acme.halopsa.com', settings });
    await client.closeTicket('4321', '22');

    const close = calls.filter((spec) => spec.url.endsWith('/api/Tickets')).at(-1)!;
    expect(JSON.parse(close.body!)).toEqual([{ id: 4321, status_id: 22 }]);
  });
});

describe('HaloPSA list answers and the token cache', () => {
  const base = { resourceServer: 'https://wrap.halopsa.com', clientId: 'wrap-client' };

  it('reads clients and tickets when Halo wraps the list in an object', async () => {
    responder = (spec) => {
      if (spec.url.endsWith('/token')) return ok({ access_token: 'tok-w', expires_in: 3600 });
      if (spec.url.includes('/api/Client')) return ok({ record_count: 1, clients: [{ id: 5, name: 'Acme Ltd' }] });
      return ok({ record_count: 1, tickets: [{ id: 77, summary: 'x [DH-abcdefgh]' }] });
    };
    const client = createHaloPsaClient({
      credentials: { ...base, clientSecret: 'wrap-secret' },
      baseUrl: base.resourceServer,
      settings,
    });
    expect(await client.searchCompanies('acme')).toEqual([{ id: '5', name: 'Acme Ltd' }]);
    expect((await client.findTicketByReference('5', 'abcdefgh'))?.id).toBe('77');
  });

  it('asks for a new token when the secret differs, even for the same client id', async () => {
    responder = (spec) =>
      spec.url.endsWith('/token') ? ok({ access_token: 'tok-c', expires_in: 3600 }) : ok([]);
    await createHaloPsaClient({
      credentials: { ...base, clientSecret: 'first-secret' },
      baseUrl: base.resourceServer,
      settings,
    }).test();
    calls = [];
    await createHaloPsaClient({
      credentials: { ...base, clientSecret: 'other-secret' },
      baseUrl: base.resourceServer,
      settings,
    }).test();
    expect(calls[0]!.url).toContain('/token');
    expect(calls[0]!.body).toContain('client_secret=other-secret');
  });
});

describe('ConnectWise requests', () => {
  const credentials = {
    site: 'api-na.myconnectwise.net',
    companyId: 'acme',
    publicKey: 'test-public-key',
    privateKey: 'test-secret-not-real',
  };

  beforeEach(() => {
    env.PSA_CONNECTWISE_CLIENT_ID = 'deployment-client-id';
  });

  it('authenticates with the member key pair and the clientId header', async () => {
    responder = () => ok([]);
    const client = createConnectWiseClient({ credentials, baseUrl: 'api-na.myconnectwise.net', settings });
    await client.test();

    expect(calls[0]!.url).toBe(
      'https://api-na.myconnectwise.net/v4_6_release/apis/3.0/company/companies?pageSize=1',
    );
    expect(calls[0]!.headers.clientid).toBe('deployment-client-id');
    const expected = `Basic ${Buffer.from('acme+test-public-key:test-secret-not-real').toString('base64')}`;
    expect(calls[0]!.headers.authorization).toBe(expected);
  });

  it('creates a ticket with company, board, type, status and priority objects', async () => {
    responder = () => ok({ id: 55 });
    const client = createConnectWiseClient({ credentials, baseUrl: 'api-na.myconnectwise.net', settings });
    await client.createTicket({
      companyId: '12',
      title: 'title [DH-abcdefgh]',
      body: 'body',
      reference: 'abcdefgh',
      settings,
    });

    const post = calls.find((spec) => spec.method === 'POST')!;
    expect(post.url).toBe('https://api-na.myconnectwise.net/v4_6_release/apis/3.0/service/tickets');
    expect(JSON.parse(post.body!)).toMatchObject({
      summary: 'title [DH-abcdefgh]',
      initialDescription: 'body',
      company: { id: 12 },
      board: { id: 3 },
      type: { id: 7 },
      status: { id: 11 },
      priority: { id: 4 },
    });
  });

  it('closes with a JSON Patch on status', async () => {
    responder = () => ok({});
    const client = createConnectWiseClient({ credentials, baseUrl: 'api-na.myconnectwise.net', settings });
    await client.closeTicket('55', '22');

    const patch = calls.find((spec) => spec.method === 'PATCH')!;
    expect(patch.url).toBe(
      'https://api-na.myconnectwise.net/v4_6_release/apis/3.0/service/tickets/55',
    );
    expect(JSON.parse(patch.body!)).toEqual([{ op: 'replace', path: 'status', value: { id: 22 } }]);
  });

  it('searches for the marker without LIKE brackets, and matches the exact marker', async () => {
    responder = () =>
      ok([
        { id: 1, summary: 'something DH-abcdefghx else' },
        { id: 2, summary: 'DMARC Harbor: example.com: x [DH-abcdefgh]' },
      ]);
    const client = createConnectWiseClient({ credentials, baseUrl: 'api-na.myconnectwise.net', settings });
    const found = await client.findTicketByReference('12', 'abcdefgh');

    const conditions = new URL(calls[0]!.url).searchParams.get('conditions')!;
    expect(conditions).toBe('company/id=12 and summary like "%DH-abcdefgh%" and closedFlag=false');
    expect(conditions).not.toContain('[');
    expect(found?.id).toBe('2');
    await expect(client.findTicketByReference('12 or 1=1', 'abcdefgh')).rejects.toMatchObject({
      code: 'PSA_REJECTED',
    });
  });

  it('refuses to build a client when the deployment has no clientId', () => {
    env.PSA_CONNECTWISE_CLIENT_ID = undefined;
    expect(() =>
      createConnectWiseClient({ credentials, baseUrl: 'api-na.myconnectwise.net', settings }),
    ).toThrowError(expect.objectContaining({ code: 'PSA_UNAVAILABLE' }));
  });
});

describe('Autotask requests', () => {
  const credentials = { username: 'api-user@example.com', secret: 'test-secret-not-real', integrationCode: 'TESTCODE' };
  const baseUrl = 'https://webservices5.autotask.net/ATServicesRest/';

  it('sends the three credential headers on every call', async () => {
    responder = () => ok({ items: [] });
    const client = createAutotaskClient({ credentials, baseUrl, settings });
    await client.searchCompanies('acme');

    expect(calls[0]!.url).toBe(`${baseUrl}V1.0/Companies/query`);
    expect(calls[0]!.headers.username).toBe('api-user@example.com');
    expect(calls[0]!.headers.secret).toBe('test-secret-not-real');
    expect(calls[0]!.headers.apiintegrationcode).toBe('TESTCODE');
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ MaxRecords: 25 });
  });

  it('creates a ticket with a due date, which the API requires without a category', async () => {
    responder = () => ok({ itemId: 77 });
    const client = createAutotaskClient({ credentials, baseUrl, settings });
    const created = await client.createTicket({
      companyId: '5',
      title: 'title [DH-abcdefgh]',
      body: 'body',
      reference: 'abcdefgh',
      settings,
    });

    const post = calls.find((spec) => spec.method === 'POST')!;
    const body = JSON.parse(post.body!) as Record<string, unknown>;
    expect(body).toMatchObject({ companyID: 5, title: 'title [DH-abcdefgh]', status: 11, queueID: 3 });
    expect(typeof body.dueDateTime).toBe('string');
    expect(created.id).toBe('77');
  });

  it('accepts only an https zone under autotask.net', () => {
    expect(acceptAutotaskZone('https://webservices5.autotask.net/ATServicesRest/')).toBe(
      'https://webservices5.autotask.net/ATServicesRest/',
    );
    expect(acceptAutotaskZone('http://webservices5.autotask.net/ATServicesRest/')).toBeNull();
    expect(acceptAutotaskZone('https://evil.example/ATServicesRest/')).toBeNull();
    expect(acceptAutotaskZone('https://autotask.net.evil.example/')).toBeNull();
    expect(acceptAutotaskZone(undefined)).toBeNull();
  });
});

describe('ticket titles', () => {
  it('keeps the marker inside ConnectWise’s 100-character summary', () => {
    const title = buildTicketTitle({
      domain: 'example.com',
      summary: 'x'.repeat(200),
      reference: 'abcdefgh',
      limit: titleLimits.CONNECTWISE,
    });

    expect(title.length).toBeLessThanOrEqual(100);
    expect(title.endsWith('[DH-abcdefgh]')).toBe(true);
  });

  it('leaves a short title alone', () => {
    const title = buildTicketTitle({
      domain: 'example.com',
      summary: '3 failures',
      reference: 'abcdefgh',
      limit: titleLimits.HALOPSA,
    });

    expect(title).toBe('DMARC Harbor: example.com: 3 failures [DH-abcdefgh]');
  });

  it('generates a reference the marker can carry', () => {
    const reference = newTicketReference();
    expect(reference).toMatch(/^[a-z2-7]{8}$/);
    expect(referenceMarker(reference)).toBe(`[DH-${reference}]`);
  });
});

describe('error mapping', () => {
  const body = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');

  it('names the permission to fix on a 403 and never echoes a credential', () => {
    const error = psaErrorForStatus({
      provider: 'CONNECTWISE',
      statusCode: 403,
      body: body({ message: 'Access denied' }),
    });

    expect(error.code).toBe('PSA_PERMISSION_DENIED');
    expect(error.message).toContain('Service Desk');
    expect(error.message).not.toContain('test-secret-not-real');
  });

  it('maps 401, 404 and 5xx to their own codes', () => {
    expect(psaErrorForStatus({ provider: 'HALOPSA', statusCode: 401, body: body({}) }).code).toBe('PSA_AUTH_FAILED');
    expect(psaErrorForStatus({ provider: 'HALOPSA', statusCode: 404, body: body({}) }).code).toBe('PSA_NOT_FOUND');
    expect(psaErrorForStatus({ provider: 'HALOPSA', statusCode: 503, body: body({}) }).code).toBe('PSA_UNAVAILABLE');
    expect(psaErrorForStatus({ provider: 'HALOPSA', statusCode: 422, body: body({}) }).code).toBe('PSA_REJECTED');
  });

  it('honours Retry-After on a 429, in both header forms', () => {
    const withSeconds = psaErrorForStatus({
      provider: 'AUTOTASK',
      statusCode: 429,
      body: body({}),
      retryAfterSeconds: 90,
    });
    expect(withSeconds.code).toBe('PSA_RATE_LIMITED');
    expect(withSeconds.retryAfterSeconds).toBe(90);

    expect(retryAfterSeconds('120')).toBe(120);
    expect(retryAfterSeconds(String(Math.floor(Date.now() / 1000) + 60))).toBeGreaterThan(50);
    expect(retryAfterSeconds('999999')).toBe(3600);
    expect(retryAfterSeconds(undefined)).toBeUndefined();
  });

  it('survives a body that is not JSON', () => {
    const error = psaErrorForStatus({
      provider: 'HALOPSA',
      statusCode: 400,
      body: Buffer.from('<html>Bad Request</html>', 'utf8'),
    });

    expect(error.code).toBe('PSA_REJECTED');
    expect(error.message).toContain('Bad Request');
  });
});

describe('the outbound guard', () => {
  /** A stand-in for node:https that answers with one canned response. */
  function fakeRequest(statusCode: number, headers: Record<string, string>, chunks: string[]) {
    return ((_options: unknown, callback: (response: EventEmitter & Record<string, unknown>) => void) => {
      const outgoing = new EventEmitter() as EventEmitter & Record<string, unknown>;
      outgoing.write = () => true;
      outgoing.destroy = () => {};
      outgoing.end = () => {
        const response = new EventEmitter() as EventEmitter & Record<string, unknown>;
        response.statusCode = statusCode;
        response.headers = headers;
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

  const publicLookup = async () => [{ address: '203.0.113.10', family: 4 }];

  it('refuses a literal private address before any DNS is asked', async () => {
    let asked = false;
    const request = createGuardedRequester({
      lookup: async () => {
        asked = true;
        return [{ address: '10.0.0.1', family: 4 }];
      },
    });

    const result = await request({ url: 'https://127.0.0.1/token', method: 'GET' });
    expect(result).toMatchObject({ status: 'error', failure: 'refused_address' });
    expect(asked).toBe(false);
  });

  it('refuses a name that resolves to a private address', async () => {
    const request = createGuardedRequester({
      lookup: async () => [{ address: '169.254.169.254', family: 4 }],
    });

    const result = await request({ url: 'https://psa.example.com/api', method: 'GET' });
    expect(result).toMatchObject({ status: 'error', failure: 'refused_address' });
  });

  it('refuses plain http, a port other than 443, and credentials in the URL', async () => {
    const request = createGuardedRequester({ lookup: publicLookup });
    for (const url of ['http://psa.example.com/api', 'https://psa.example.com:8443/api', 'https://user:pass@psa.example.com/api']) {
      const result = await request({ url, method: 'GET' });
      expect(result, url).toMatchObject({ status: 'error', failure: 'invalid_url' });
    }
  });

  it('refuses a redirect instead of following it', async () => {
    const request = createGuardedRequester({
      lookup: publicLookup,
      request: fakeRequest(302, { location: 'https://elsewhere.example/' }, []),
    });

    const result = await request({ url: 'https://psa.example.com/api', method: 'GET' });
    expect(result).toMatchObject({ status: 'error', failure: 'redirect', statusCode: 302 });
  });

  it('refuses a body larger than the cap', async () => {
    const request = createGuardedRequester({
      lookup: publicLookup,
      request: fakeRequest(200, { 'content-length': '2000000' }, []),
    });

    const result = await request({ url: 'https://psa.example.com/api', method: 'GET' });
    expect(result).toMatchObject({ status: 'error', failure: 'too_large' });
  });

  it('returns the body of a normal answer', async () => {
    const request = createGuardedRequester({
      lookup: publicLookup,
      request: fakeRequest(200, {}, ['{"ok":true}']),
    });

    const result = await request({ url: 'https://psa.example.com/api', method: 'GET' });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.body.toString('utf8')).toBe('{"ok":true}');
    }
  });
});
