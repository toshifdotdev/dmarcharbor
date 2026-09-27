import { describe, expect, it } from 'vitest';
import { dataClasses, dataClassByKey, personalDataClasses, retainedClasses } from '../src/services/inventory/data-classes.js';
import { buildErasureCertificate, exportRedactions, planErasure, summarisePlan } from '../src/services/inventory/deletion-planner.js';
import type { Inventory } from '../src/services/inventory/inventory.service.js';

function inventory(overrides: Partial<Inventory['counts']> = {}): Inventory {
  return {
    scope: { kind: 'ORGANIZATION', organizationId: 'org-1' },
    generatedAt: '2026-09-27T00:00:00.000Z',
    counts: {
      organization: 1,
      client: 3,
      domain: 12,
      report: 400,
      forensicEvidence: 90,
      forensicPseudonym: 90,
      forensicPersonalData: 40,
      user: 2,
      session: 5,
      auditLog: 250,
      subscription: 1,
      ...overrides,
    },
    personalData: [],
    evidenceRetained: [],
    metered: { activeDomains: 12, countedDomains: 12, retentionDays: 400, graceDays: 14 },
  };
}

describe('data classification', () => {
  it('gives every class a unique key', () => {
    const keys = dataClasses.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every class a label and a description a customer could read', () => {
    for (const entry of dataClasses) {
      expect(entry.label.length, entry.key).toBeGreaterThan(3);
      expect(entry.description.length, entry.key).toBeGreaterThan(10);
    }
  });

  it('justifies every class that is not simply deleted', () => {
    for (const entry of retainedClasses()) {
      expect(entry.retentionReason, `${entry.key} needs a reason`).toBeTruthy();
    }
  });

  it('cites a legal or evidential basis for everything retained', () => {
    for (const entry of retainedClasses()) {
      expect(entry.retentionBasis, `${entry.key} needs a basis`).toBeTruthy();
    }
  });

  it('marks named forensic data as the personal data it is', () => {
    const named = dataClassByKey.get('forensicPersonalData');
    expect(named?.containsPersonalData).toBe(true);
    expect(named?.erasure).toBe('delete');
  });

  it('treats pseudonymous recipients as non personal data', () => {
    const pseudonym = dataClassByKey.get('forensicPseudonym');
    expect(pseudonym?.containsPersonalData).toBe(false);
  });

  it('anonymises rather than deletes the audit trail, so the record survives', () => {
    const audit = dataClassByKey.get('auditLog');
    expect(audit?.erasure).toBe('anonymize');
    expect(audit?.containsPersonalData).toBe(true);
  });

  it('anonymises the subscription so invoice records survive', () => {
    expect(dataClassByKey.get('subscription')?.erasure).toBe('anonymize');
  });

  it('includes the classes an agency would expect to be told about', () => {
    const keys = personalDataClasses().map((entry) => entry.key);
    for (const expected of ['user', 'session', 'member', 'auditLog', 'forensicPersonalData']) {
      expect(keys, expected).toContain(expected);
    }
  });
});

describe('erasure plan', () => {
  it('skips anything with a count of zero', () => {
    const actions = planErasure(inventory({ reportDigest: 0 }));
    expect(actions.some((entry) => entry.key === 'reportDigest')).toBe(false);
  });

  it('covers every class present in the inventory', () => {
    const actions = planErasure(inventory());
    expect(actions.length).toBe(Object.values(inventory().counts).filter((count) => count > 0).length);
  });

  it('orders deletions first so the summary reads naturally', () => {
    const actions = planErasure(inventory());
    const firstNonDelete = actions.findIndex((entry) => entry.action !== 'delete');
    const lastDelete = actions.map((entry) => entry.action).lastIndexOf('delete');

    if (firstNonDelete >= 0) {
      expect(lastDelete).toBeLessThan(firstNonDelete);
    }
  });

  it('sums the personal data it will remove', () => {
    const totals = summarisePlan(planErasure(inventory()));
    expect(totals.personalDataRecords).toBe(40 + 2 + 5 + 250);
  });

  it('counts anonymised records separately from deletions', () => {
    const totals = summarisePlan(planErasure(inventory()));
    expect(totals.recordsAnonymised).toBe(251);
  });

  it('performs no database writes, so a plan can be previewed safely', () => {
    const first = planErasure(inventory());
    const second = planErasure(inventory());
    expect(first).toEqual(second);
  });

  it('gives every action a human reason', () => {
    for (const action of planErasure(inventory())) {
      expect(action.reason.length, action.key).toBeGreaterThan(5);
    }
  });
});

describe('erasure certificate', () => {
  const actions = planErasure(inventory());
  const certificate = buildErasureCertificate(inventory(), actions, { plan: 'HARBOR', retentionDays: 1095 });

  it('carries no personal data, only counts', () => {
    const serialized = JSON.stringify(certificate);
    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('example.com');
  });

  it('names the scope it covers', () => {
    expect(certificate.scope).toEqual({ kind: 'ORGANIZATION', organizationId: 'org-1' });
  });

  it('lists what was removed as personal data', () => {
    expect(certificate.personalDataRemoved).toEqual(
      expect.arrayContaining([{ key: 'forensicPersonalData', count: 40 }, { key: 'user', count: 2 }]),
    );
  });

  it('lists what was anonymised', () => {
    expect(certificate.anonymised).toEqual(
      expect.arrayContaining([{ key: 'auditLog', count: 250 }, { key: 'subscription', count: 1 }]),
    );
  });

  it('states plainly that evidence is kept and why', () => {
    expect(certificate.statement).toContain('no recipient data');
    expect(certificate.statement).toContain('contains no personal data');
  });

  it('records the plan the customer was on at the time', () => {
    expect(certificate.organisation.plan).toBe('HARBOR');
    expect(certificate.organisation.retentionDays).toBe(1095);
  });
});

describe('export redactions', () => {
  it('discloses data held as a security record rather than exporting it silently', () => {
    const notices = exportRedactions(inventory());

    expect(notices.map((entry) => entry.key)).toEqual(expect.arrayContaining(['auditLog', 'subscription']));
    for (const notice of notices) {
      expect(notice.why).toContain('not included');
      expect(notice.count).toBeGreaterThan(0);
    }
  });

  it('does not report deleted classes as redactions', () => {
    const notices = exportRedactions(inventory());
    expect(notices.some((entry) => entry.key === 'forensicPersonalData')).toBe(false);
  });
});
