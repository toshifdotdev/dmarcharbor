import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import {
  acceptableOrigin,
  candidateOrigins,
  lookupAgencyHost,
  resetAgencyHostCache,
  trustedOriginsFor,
} from '../src/auth/agency-origin.js';
import { agencyAuthLink } from '../src/auth/agency-auth-link.js';
import { agencyFromHeader } from '../src/email/sender.js';

/**
 * When Better Auth may trust an agency's own domain, and what an emailed
 * reset or verification link looks like when a client started there.
 *
 * The database is replaced by two small fakes: which hostnames are claimed and
 * verified, and what branding would present for each workspace.
 */
const world = vi.hoisted(() => ({
  /** hostname -> claim */
  hosts: new Map<string, { organizationId: string; verified: boolean }>(),
  /** organizationId -> what resolveBranding presents */
  branding: new Map<string, { workspaceName: string; customDomain: string | null; branded: boolean }>(),
  /** Set to make the host lookup fail, as a database outage would. */
  failLookup: false,
  hostLookups: 0,
  /** Emails of active portal contacts per workspace, and member user ids. */
  contacts: new Map<string, string[]>(),
  members: new Map<string, string[]>(),
}));

vi.mock('../src/services/branding.service.js', () => ({
  findOrganizationByHost: async (host: string) => {
    world.hostLookups += 1;
    if (world.failLookup) throw new Error('connection refused');
    return world.hosts.get(host) ?? null;
  },
  resolveBranding: async (organizationId: string) => {
    const found = world.branding.get(organizationId);
    if (!found) throw new Error('No Organization found');
    return found;
  },
}));

vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    clientPortalAccess: {
      // `organizationId` is either one workspace or `{ not: id }`, every other one.
      findFirst: async ({
        where,
      }: {
        where: { organizationId: string | { not: string }; OR: [{ email: string }, { userId: string }] };
      }) => {
        const email = where.OR[0].email;
        const matches = [...world.contacts.entries()].some(([organizationId, emails]) =>
          (typeof where.organizationId === 'string'
            ? organizationId === where.organizationId
            : organizationId !== where.organizationId.not) && emails.includes(email),
        );
        return matches ? { id: 'grant' } : null;
      },
    },
    member: {
      // A seat in any workspace.
      findFirst: async ({ where }: { where: { userId: string } }) =>
        [...world.members.values()].some((ids) => ids.includes(where.userId)) ? { id: 'member' } : null,
    },
  },
}));

const agencyHost = 'reports.wistholm.example';
const agencyOrigin = `https://${agencyHost}`;

function headers(values: Record<string, string>): Request {
  return { headers: new Headers(values) } as unknown as Request;
}

function claim(host: string, input: { verified?: boolean; licensed?: boolean; organizationId?: string; name?: string } = {}) {
  const organizationId = input.organizationId ?? `org_${host}`;
  world.hosts.set(host, { organizationId, verified: input.verified ?? true });
  world.branding.set(organizationId, {
    workspaceName: input.name ?? 'Wistholm IT',
    // resolveBranding only presents the domain when licensed and verified.
    customDomain: (input.licensed ?? true) && (input.verified ?? true) ? host : null,
    branded: true,
  });
  return organizationId;
}

const originalNodeEnv = env.NODE_ENV;

beforeEach(() => {
  resetAgencyHostCache();
  world.hosts.clear();
  world.branding.clear();
  world.contacts.clear();
  world.members.clear();
  world.failLookup = false;
  world.hostLookups = 0;
});

afterEach(() => {
  env.NODE_ENV = originalNodeEnv;
});

describe('which origin a request offers', () => {
  it('offers the Origin when the proxy header names the same host', () => {
    expect(candidateOrigins(new Headers({ origin: agencyOrigin, 'x-forwarded-host': agencyHost }))).toEqual([agencyOrigin]);
    // The proxy passes the Host header through, port and all.
    expect(
      candidateOrigins(new Headers({ origin: 'http://brand-test.example:3200', 'x-forwarded-host': 'brand-test.example:3200' })),
    ).toEqual(['http://brand-test.example:3200']);
  });

  it('offers nothing when the proxy header is missing or names another host', () => {
    expect(candidateOrigins(new Headers({ origin: agencyOrigin }))).toEqual([]);
    expect(candidateOrigins(new Headers({ origin: agencyOrigin, 'x-forwarded-host': 'elsewhere.example' }))).toEqual([]);
    // An opaque origin is still an Origin header, and it names no host.
    expect(candidateOrigins(new Headers({ origin: 'null', 'x-forwarded-host': agencyHost }))).toEqual([]);
  });

  it('builds one from the proxy header for a navigation with no Origin', () => {
    env.NODE_ENV = 'production';
    expect(candidateOrigins(new Headers({ 'x-forwarded-host': agencyHost }))).toEqual([agencyOrigin]);
    // Outside production the scheme is unknown, so the http form is offered too.
    env.NODE_ENV = 'test';
    expect(candidateOrigins(new Headers({ 'x-forwarded-host': agencyHost }))).toEqual([agencyOrigin, `http://${agencyHost}`]);
  });

  it('refuses http in production, and anything that would read as a wildcard', () => {
    env.NODE_ENV = 'production';
    expect(acceptableOrigin('http://brand-test.example:3200')).toBeNull();
    expect(acceptableOrigin(agencyOrigin)).toEqual({ origin: agencyOrigin, hostname: agencyHost });

    env.NODE_ENV = 'test';
    expect(acceptableOrigin('http://brand-test.example:3200')).toEqual({
      origin: 'http://brand-test.example:3200',
      hostname: 'brand-test.example',
    });
    // Better Auth treats * and ? in a trusted origin as patterns.
    expect(acceptableOrigin('https://*.wistholm.example')).toBeNull();
    expect(acceptableOrigin('ftp://reports.wistholm.example')).toBeNull();
    expect(acceptableOrigin('not a url')).toBeNull();
  });
});

describe('trustedOrigins', () => {
  it('is the static list at start-up, when there is no request', async () => {
    expect(await trustedOriginsFor()).toEqual(env.CORS_ORIGINS);
  });

  it('adds a verified, licensed agency domain the request came through', async () => {
    claim(agencyHost);

    const trusted = await trustedOriginsFor(headers({ origin: agencyOrigin, 'x-forwarded-host': agencyHost }));

    expect(trusted).toEqual([...env.CORS_ORIGINS, agencyOrigin]);
  });

  it('adds it for an emailed link opened through the agency domain, with no Origin', async () => {
    claim(agencyHost);

    const trusted = await trustedOriginsFor(headers({ 'x-forwarded-host': agencyHost }));

    expect(trusted).toContain(agencyOrigin);
  });

  it('adds nothing when the Origin and the proxy header disagree', async () => {
    claim(agencyHost);

    expect(await trustedOriginsFor(headers({ origin: agencyOrigin }))).toEqual(env.CORS_ORIGINS);
    expect(await trustedOriginsFor(headers({ origin: agencyOrigin, 'x-forwarded-host': 'app.harbor.example' }))).toEqual(
      env.CORS_ORIGINS,
    );
  });

  it('adds nothing for an unverified or unlicensed domain', async () => {
    claim('unproven.wistholm.example', { verified: false });
    claim('downgraded.wistholm.example', { licensed: false });

    for (const host of ['unproven.wistholm.example', 'downgraded.wistholm.example', 'nobody.example']) {
      expect(await trustedOriginsFor(headers({ origin: `https://${host}`, 'x-forwarded-host': host }))).toEqual(env.CORS_ORIGINS);
    }
  });

  it('refuses an http agency origin in production and accepts it for the local harness', async () => {
    claim('brand-test.example');
    const request = headers({ origin: 'http://brand-test.example:3200', 'x-forwarded-host': 'brand-test.example:3200' });

    env.NODE_ENV = 'production';
    expect(await trustedOriginsFor(request)).toEqual(env.CORS_ORIGINS);

    env.NODE_ENV = 'test';
    expect(await trustedOriginsFor(request)).toContain('http://brand-test.example:3200');
  });

  it('adds nothing and does not throw when the lookup fails', async () => {
    claim(agencyHost);
    world.failLookup = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const request = headers({ origin: agencyOrigin, 'x-forwarded-host': agencyHost });
      expect(await trustedOriginsFor(request)).toEqual(env.CORS_ORIGINS);

      // A failure is not remembered, so the next request tries again.
      world.failLookup = false;
      expect(await trustedOriginsFor(request)).toContain(agencyOrigin);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('the host cache', () => {
  it('answers a repeat within a minute without a lookup, found or not', async () => {
    claim(agencyHost);
    const start = 1_000_000;

    expect(await lookupAgencyHost(agencyHost, start)).toMatchObject({ workspaceName: 'Wistholm IT' });
    expect(await lookupAgencyHost(agencyHost, start + 30_000)).toMatchObject({ workspaceName: 'Wistholm IT' });
    expect(await lookupAgencyHost('nobody.example', start)).toBeNull();
    expect(await lookupAgencyHost('nobody.example', start + 30_000)).toBeNull();
    expect(world.hostLookups).toBe(2);

    // After a minute the answer is read again, so a removed domain stops working.
    world.hosts.delete(agencyHost);
    expect(await lookupAgencyHost(agencyHost, start + 61_000)).toBeNull();
    expect(world.hostLookups).toBe(3);
  });

  it('holds at most 500 hostnames, dropping the oldest first', async () => {
    const now = 2_000_000;
    for (let index = 0; index < 500; index += 1) {
      await lookupAgencyHost(`host-${index}.example`, now);
    }
    expect(world.hostLookups).toBe(500);

    // Still cached.
    await lookupAgencyHost('host-0.example', now);
    expect(world.hostLookups).toBe(500);

    // One more pushes the oldest out.
    await lookupAgencyHost('host-500.example', now);
    await lookupAgencyHost('host-0.example', now);
    expect(world.hostLookups).toBe(502);
  });
});

describe('emailed reset and verification links', () => {
  const contact = { id: 'user_contact', email: 'it@pellowyn.example' };
  const resetUrl = (callback: string) =>
    `https://api.harbor.example/api/auth/reset-password/tok123?callbackURL=${encodeURIComponent(callback)}`;

  it('moves the link to the agency domain for one of its clients, in its name', async () => {
    const organizationId = claim(agencyHost);
    world.contacts.set(organizationId, [contact.email]);

    const link = await agencyAuthLink(resetUrl(`${agencyOrigin}/sign-in`), contact);

    expect(link.url).toBe(
      `${agencyOrigin}/api/auth/reset-password/tok123?callbackURL=${encodeURIComponent(`${agencyOrigin}/sign-in`)}`,
    );
    expect(link.agency).toEqual({ organizationId, workspaceName: 'Wistholm IT' });
    expect(link.from).toBe(agencyFromHeader('Wistholm IT'));
  });

  it('keeps the port and scheme of the local harness', async () => {
    const organizationId = claim('brand-test.example');
    world.contacts.set(organizationId, [contact.email]);
    const callback = 'http://brand-test.example:3200/portal';
    const url = `https://api.harbor.example/api/auth/verify-email?token=jwt.part.sig&callbackURL=${encodeURIComponent(callback)}`;

    const link = await agencyAuthLink(url, contact);

    expect(link.url).toBe(`http://brand-test.example:3200/api/auth/verify-email?token=jwt.part.sig&callbackURL=${encodeURIComponent(callback)}`);
    expect(link.agency?.workspaceName).toBe('Wistholm IT');
  });

  it('keeps the link on our app for the agency team, whose account may hold other seats', async () => {
    const organizationId = claim(agencyHost);
    world.members.set(organizationId, ['user_staff']);

    const link = await agencyAuthLink(resetUrl(`${agencyOrigin}/sign-in`), { id: 'user_staff', email: 'staff@wistholm.example' });
    const parsed = new URL(link.url);

    expect(parsed.origin).toBe('https://api.harbor.example');
    expect(parsed.searchParams.get('callbackURL')).toBe(`${env.APP_URL.replace(/\/+$/, '')}/sign-in`);
    expect(link.agency).toBeNull();
  });

  it('keeps the link on our app for a contact another agency also serves', async () => {
    const organizationId = claim(agencyHost);
    world.contacts.set(organizationId, [contact.email]);
    world.contacts.set('org_other_agency', [contact.email]);

    const link = await agencyAuthLink(resetUrl(`${agencyOrigin}/sign-in`), contact);

    expect(new URL(link.url).origin).toBe('https://api.harbor.example');
    expect(link.agency).toBeNull();
  });

  it('sends anyone outside the agency to our app instead, so the token never goes to its host', async () => {
    claim(agencyHost);
    const stranger = { id: 'user_other', email: 'someone@elsewhere.example' };

    const link = await agencyAuthLink(resetUrl(`${agencyOrigin}/sign-in?next=%2Fportal`), stranger);
    const parsed = new URL(link.url);

    expect(parsed.origin).toBe('https://api.harbor.example');
    expect(parsed.pathname).toBe('/api/auth/reset-password/tok123');
    expect(parsed.searchParams.get('callbackURL')).toBe(`${env.APP_URL.replace(/\/+$/, '')}/sign-in?next=%2Fportal`);
    expect(link.agency).toBeNull();
    expect(link.from).toBeUndefined();
  });

  it('leaves every other link exactly as Better Auth built it', async () => {
    claim(agencyHost);
    world.contacts.set(`org_${agencyHost}`, [contact.email]);

    for (const callback of ['/', `${env.APP_URL}/sign-in`, 'https://nobody.example/sign-in', 'https://unproven.example/x']) {
      const url = resetUrl(callback);
      expect(await agencyAuthLink(url, contact)).toEqual({ url, agency: null });
    }

    const noCallback = 'https://api.harbor.example/api/auth/verify-email?token=abc';
    expect(await agencyAuthLink(noCallback, contact)).toEqual({ url: noCallback, agency: null });
  });

  it('leaves the link alone when the lookup fails', async () => {
    claim(agencyHost);
    world.failLookup = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const url = resetUrl(`${agencyOrigin}/sign-in`);
      expect(await agencyAuthLink(url, contact)).toEqual({ url, agency: null });
    } finally {
      errors.mockRestore();
    }
  });
});
