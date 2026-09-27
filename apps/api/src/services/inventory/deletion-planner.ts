import { dataClassByKey } from './data-classes.js';
import type { Inventory, InventoryScope } from './inventory.service.js';

export interface PlannedAction {
  key: string;
  label: string;
  count: number;
  action: 'delete' | 'anonymize' | 'retain';
  reason: string;
  basis: string;
  containsPersonalData: boolean;
}

export interface ErasureCertificate {
  version: 1;
  scope: InventoryScope;
  generatedAt: string;
  organisation: { plan: string; retentionDays: number };
  personalDataRemoved: { key: string; count: number }[];
  anonymised: { key: string; count: number }[];
  evidenceRetained: { key: string; count: number; reason: string }[];
  totals: { personalDataRecords: number; recordsDeleted: number; recordsAnonymised: number };
  statement: string;
}

/**
 * Turns an inventory into an explicit, reviewable plan. This function performs
 * no database writes on purpose: the customer is entitled to see what will
 * happen before they confirm it, and the plan can be asserted in tests without
 * touching stored data.
 */
export function planErasure(inventory: Inventory): PlannedAction[] {
  return Object.entries(inventory.counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => {
      const definition = dataClassByKey.get(key);
      return {
        key,
        label: definition?.label ?? key,
        count,
        action: definition?.erasure ?? 'delete',
        reason: definition?.retentionReason ?? 'The data is the subject of the request.',
        basis: definition?.retentionBasis ?? '',
        containsPersonalData: definition?.containsPersonalData ?? false,
      };
    })
    .sort((left, right) => {
      if (left.action !== right.action) {
        return left.action === 'delete' ? -1 : left.action === 'anonymize' ? 1 : 0;
      }
      return right.count - left.count;
    });
}

export function summarisePlan(actions: PlannedAction[]): {
  personalDataRecords: number;
  recordsDeleted: number;
  recordsAnonymised: number;
  evidenceRetained: number;
} {
  return {
    personalDataRecords: actions.filter((entry) => entry.containsPersonalData).reduce((total, entry) => total + entry.count, 0),
    recordsDeleted: actions.filter((entry) => entry.action === 'delete').reduce((total, entry) => total + entry.count, 0),
    recordsAnonymised: actions.filter((entry) => entry.action === 'anonymize').reduce((total, entry) => total + entry.count, 0),
    evidenceRetained: actions.filter((entry) => entry.action === 'retain').reduce((total, entry) => total + entry.count, 0),
  };
}

/**
 * The certificate is the answer to a real paradox. If an erasure deletes the
 * audit trail, there is no proof the erasure happened, and no way to satisfy
 * the accountability the same request relies on. So the certificate is written
 * before deletion, contains no personal data, and survives it.
 */
export function buildErasureCertificate(
  inventory: Inventory,
  actions: PlannedAction[],
  organisation: { plan: string; retentionDays: number },
): ErasureCertificate {
  const totals = summarisePlan(actions);

  return {
    version: 1,
    scope: inventory.scope,
    generatedAt: inventory.generatedAt,
    organisation,
    personalDataRemoved: actions
      .filter((entry) => entry.containsPersonalData && entry.action === 'delete')
      .map((entry) => ({ key: entry.key, count: entry.count })),
    anonymised: actions
      .filter((entry) => entry.action === 'anonymize')
      .map((entry) => ({ key: entry.key, count: entry.count })),
    evidenceRetained: actions
      .filter((entry) => entry.action !== 'delete')
      .map((entry) => ({ key: entry.key, count: entry.count, reason: entry.reason })),
    totals: {
      personalDataRecords: totals.personalDataRecords,
      recordsDeleted: totals.recordsDeleted,
      recordsAnonymised: totals.recordsAnonymised,
    },
    statement:
      'Personal data held for this scope was deleted, and identifying fields on retained security records were cleared. ' +
      'Non personal DMARC authentication evidence was retained because it contains no recipient data. ' +
      'This certificate contains no personal data and is the record that the request was carried out.',
  };
}

export interface RedactionNotice {
  key: string;
  label: string;
  count: number;
  why: string;
}

/**
 * Personal data that is deliberately left out of an export, with the reason
 * stated, so the export cannot be mistaken for a complete copy of stored bytes.
 */
export function exportRedactions(inventory: Inventory): RedactionNotice[] {
  return Object.entries(inventory.counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ key, count, definition: dataClassByKey.get(key) }))
    .filter(
      (entry): entry is { key: string; count: number; definition: NonNullable<ReturnType<typeof dataClassByKey.get>> } =>
        entry.definition !== undefined,
    )
    .filter((entry) => entry.definition.erasure === 'anonymize')
    .map((entry) => ({
      key: entry.key,
      label: entry.definition.label,
      count: entry.count,
      why:
        'Held as a security record, so it is reported by count but the identifying fields are not included in the export.',
    }));
}
