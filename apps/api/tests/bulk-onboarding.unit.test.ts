import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The client and domain imports, judged without a database.
 *
 * Two defects lived here. A domain import that named a client outside the
 * workspace threw a plan error, so the API answered 402 "upgrade" for a
 * mistyped id. And a client import that named a domain another workspace
 * monitors reached `client.create`, hit the global unique constraint on
 * `Domain.name`, and rolled back the whole transaction: a 500, and nothing in
 * the import created.
 *
 * The transaction is replaced with a small fake that answers the reads the
 * service makes and records what it creates, so these cases assert what the
 * service decides to write. The integration suite asserts the same against
 * Postgres.
 */
const state = vi.hoisted(() => ({
  /** Names this workspace already holds. */
  ownNames: [] as string[],
  /** Names some other workspace holds. */
  elsewhereNames: [] as string[],
  /** What `client.findFirst` answers for the domain import. */
  clientLookup: null as { id: string } | null,
  created: [] as { name: string; slug: string; domains: string[] }[],
}));

const fakeTx = vi.hoisted(() => () => ({
  client: {
    findMany: async () => [] as { slug: string }[],
    create: async ({ data }: { data: { name: string; slug: string; domains: { create: { name: string }[] } } }) => {
      const names = data.domains.create.map((domain) => domain.name);
      // The constraint the real table enforces. Reaching it is the defect.
      const clash = names.find((name) => state.elsewhereNames.includes(name) || state.ownNames.includes(name));
      if (clash || new Set(names).size !== names.length) {
        throw Object.assign(new Error('Unique constraint failed on the fields: (`name`)'), { code: 'P2002' });
      }
      state.created.push({ name: data.name, slug: data.slug, domains: names });
      const id = `cl_${state.created.length}`;
      return {
        id,
        name: data.name,
        slug: data.slug,
        domains: names.map((name, position) => ({ id: `${id}_dom_${position}`, name, verificationToken: `token-${name}` })),
      };
    },
  },
  domain: {
    findMany: async ({ where }: { where: { name?: { in: string[] }; client?: unknown; createdAt?: unknown } }) => {
      // The lookup for claims another workspace never verified (domain-claims.ts).
      // The names held elsewhere here are live claims, so none is released.
      if (where.createdAt) {
        return [];
      }
      if (where.name) {
        const wanted = where.name.in;
        return [
          ...state.ownNames.filter((name) => wanted.includes(name)).map((name) => ({ name, clientId: 'cl_own' })),
          ...state.elsewhereNames.filter((name) => wanted.includes(name)).map((name) => ({ name, clientId: 'cl_theirs' })),
        ];
      }
      return state.ownNames.map((name) => ({ name }));
    },
    deleteMany: async () => ({ count: 0 }),
  },
  auditLog: {
    createMany: async () => ({ count: 0 }),
  },
}));

vi.mock('../src/database/prisma.js', () => ({
  prisma: { client: { findFirst: vi.fn(async () => state.clientLookup) } },
}));

vi.mock('../src/services/audit.service.js', () => ({ recordAuditEvent: vi.fn(async () => undefined) }));

vi.mock('../src/services/entitlements/entitlement.service.js', () => {
  class EntitlementError extends Error {
    readonly status = 402;
    constructor(
      readonly code: string,
      message: string,
      readonly details: Record<string, unknown>,
    ) {
      super(message);
    }
  }

  return {
    EntitlementError,
    resolveEntitlements: vi.fn(async () => ({ plan: 'HARBOR', label: 'Harbor', maxActiveDomains: 80 })),
    quotaUsage: vi.fn(async (_organizationId: string, quota: string) =>
      quota === 'client' ? { used: 0, limit: 20 } : { used: 0, limit: 80 },
    ),
    // A plan-blocked row's reason ends with the way past the limit.
    quotaUpgradeSentence: vi.fn((_plan: string, quota: string) =>
      quota === 'client' ? 'Upgrade to Admiralty for 75 clients, or remove one.' : 'Upgrade to Admiralty for 300 active domains, or remove one.',
    ),
    withWorkspaceLock: vi.fn(async (_organizationId: string, work: (tx: unknown) => Promise<unknown>) => work(fakeTx())),
  };
});

const {
  ClientNotInWorkspaceError,
  bulkImportClients,
  bulkImportDomains,
  domainHeldElsewhereReason,
} = await import('../src/services/bulk-onboarding.service.js');
const { EntitlementError } = await import('../src/services/entitlements/entitlement.service.js');

beforeEach(() => {
  state.ownNames = [];
  state.elsewhereNames = [];
  state.clientLookup = null;
  state.created = [];
});

describe('a domain import for a client outside the workspace', () => {
  it('is a not-found, not a plan refusal', async () => {
    state.clientLookup = null;

    const attempt = bulkImportDomains({
      organizationId: 'org_wistholm',
      clientId: 'cl_from_another_workspace',
      domains: ['pellowyn-smiles.example'],
    });

    await expect(attempt).rejects.toBeInstanceOf(ClientNotInWorkspaceError);
    const error = await attempt.catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(EntitlementError);
    expect(error).toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'That client is not in this workspace.' });
  });
});

describe('a client import naming a domain another workspace monitors', () => {
  it('creates the client with its free domains and reports the taken one for that domain only', async () => {
    state.elsewhereNames = ['brisenhay-trading.example'];

    const result = await bulkImportClients({
      organizationId: 'org_wistholm',
      clients: [
        { name: 'Haskerley Law', domains: ['haskerley-law.example', 'brisenhay-trading.example'] },
        { name: 'Ollerbeck Vets', domains: ['ollerbeck-vets.example'] },
      ],
    });

    expect(result.failed).toEqual([]);
    expect(result.created).toHaveLength(2);

    const [haskerley, ollerbeck] = result.created;
    expect(haskerley!.domains.map((domain) => domain.name)).toEqual(['haskerley-law.example']);
    expect(haskerley!.domainConflicts).toEqual([
      { index: 1, name: 'brisenhay-trading.example', reason: domainHeldElsewhereReason },
    ]);
    // The rest of the import is untouched by one row's conflict.
    expect(ollerbeck!.domains.map((domain) => domain.name)).toEqual(['ollerbeck-vets.example']);
    expect(ollerbeck!.domainConflicts).toEqual([]);

    // Nothing that would hit the unique constraint was ever sent to the table.
    expect(state.created.map((client) => client.domains)).toEqual([['haskerley-law.example'], ['ollerbeck-vets.example']]);
  });

  it('still creates the client when every domain on the row is taken', async () => {
    state.elsewhereNames = ['brisenhay-trading.example'];

    const result = await bulkImportClients({
      organizationId: 'org_wistholm',
      clients: [{ name: 'Thrandle Build', domains: ['brisenhay-trading.example'] }],
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.domains).toEqual([]);
    expect(result.created[0]!.domainConflicts).toHaveLength(1);
  });

  it('never says which workspace holds the domain', async () => {
    state.elsewhereNames = ['brisenhay-trading.example'];

    const result = await bulkImportClients({
      organizationId: 'org_wistholm',
      clients: [{ name: 'Haskerley Law', domains: ['brisenhay-trading.example'] }],
    });

    const text = JSON.stringify(result);
    expect(text).not.toContain('cl_theirs');
    expect(result.created[0]!.domainConflicts[0]!.reason).toBe(domainHeldElsewhereReason);
  });

  it('counts only the domains it adds against the plan', async () => {
    state.elsewhereNames = ['taken-1.example', 'taken-2.example'];
    const { quotaUsage } = await import('../src/services/entitlements/entitlement.service.js');
    // One active domain left on the plan.
    vi.mocked(quotaUsage).mockImplementation(async (_organizationId, quota) =>
      quota === 'client' ? ({ used: 0, limit: 20 } as never) : ({ used: 79, limit: 80 } as never),
    );

    const result = await bulkImportClients({
      organizationId: 'org_wistholm',
      clients: [{ name: 'Corriwick Café', slug: 'corriwick-cafe', domains: ['taken-1.example', 'corriwick-cafe.example', 'taken-2.example'] }],
    });

    // Three names, but only one would be added, and one slot is free.
    expect(result.planBlocked).toEqual([]);
    expect(result.created[0]!.domains.map((domain) => domain.name)).toEqual(['corriwick-cafe.example']);
    expect(result.created[0]!.domainConflicts.map((conflict) => conflict.index)).toEqual([0, 2]);

    vi.mocked(quotaUsage).mockImplementation(async (_organizationId, quota) =>
      quota === 'client' ? ({ used: 0, limit: 20 } as never) : ({ used: 0, limit: 80 } as never),
    );
  });
});

describe('the client import rules that did not change', () => {
  it('still fails a row whose domain is already in this workspace', async () => {
    state.ownNames = ['pellowyn-dental.example'];

    const result = await bulkImportClients({
      organizationId: 'org_wistholm',
      clients: [{ name: 'Pellowyn Dental', domains: ['pellowyn-dental.example'] }],
    });

    expect(result.created).toEqual([]);
    expect(result.failed).toEqual([{ index: 0, name: 'Pellowyn Dental', reason: 'Already monitoring pellowyn-dental.example.' }]);
  });

  it('adds a domain listed twice on one row once, instead of failing the import', async () => {
    const result = await bulkImportClients({
      organizationId: 'org_wistholm',
      clients: [{ name: 'Ollerbeck Vets', domains: ['ollerbeck-vets.example', 'OLLERBECK-VETS.example'] }],
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.domains.map((domain) => domain.name)).toEqual(['ollerbeck-vets.example']);
    expect(result.created[0]!.domainConflicts).toEqual([]);
  });

  it('answers domainConflicts as an empty list when nothing conflicted', async () => {
    const result = await bulkImportClients({
      organizationId: 'org_wistholm',
      clients: [{ name: 'Wistholm Office', domains: [] }],
    });

    expect(result.created[0]!.domainConflicts).toEqual([]);
  });
});
