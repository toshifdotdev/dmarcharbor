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
/**
 * Data that only goes when the whole workspace is erased.
 *
 * Erasing one client, or one domain, deletes that client's rows and the domains in
 * scope. It leaves the agency's own people, credentials and integrations exactly
 * where they were, which is correct: an agency erasing one client's data must not
 * lose its own staff logins or its webhook configuration for every other client.
 *
 * The planner used to read every counted class straight off its data class, so a
 * CLIENT or DOMAIN request produced a certificate listing the agency's members,
 * sessions and credentials under "personal data removed". They were still there.
 * A certificate that over-claims is worse than no certificate: it is the document a
 * regulator checks, and it would have been disproved by the customer's own login.
 */
const ORGANISATION_ONLY = new Set([
  'organization',
  'member',
  'invitation',
  'session',
  'account',
  'user',
  'notification',
  'notificationPreference',
  'subscription',
  'entitlementOverride',
  'portalAccess',
  'reportInbox',
  'apiKey',
  'webhookEndpoint',
  'ssoConnection',
  'ssoAuthRequest',
  'slackDestination',
  'idempotencyRecord',
  'exportJob',
]);

const NARROW_SCOPE_REASON =
  'Outside the scope of this request. Erasing one client or one domain leaves the agency\'s own people and integrations in place.';

export function planErasure(inventory: Inventory): PlannedAction[] {
  const organisationWide = inventory.scope.kind === 'ORGANIZATION';

  return Object.entries(inventory.counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => {
      const definition = dataClassByKey.get(key);

      if (!organisationWide && ORGANISATION_ONLY.has(key)) {
        return {
          key,
          label: definition?.label ?? key,
          count,
          action: 'retain' as const,
          reason: NARROW_SCOPE_REASON,
          basis: definition?.retentionBasis ?? '',
          containsPersonalData: definition?.containsPersonalData ?? false,
        };
      }

      return {
        key,
        label: definition?.label ?? key,
        count,
        action: definition?.erasure ?? ('delete' as const),
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
      'Anything marked as retained below was outside the scope of this request and has not been altered. ' +
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
