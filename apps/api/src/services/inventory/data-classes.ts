/**
 * The single place that answers "is this personal data, and does it go when
 * the customer asks".
 *
 * Export, erasure and the client portal all have to agree on this. If they
 * each decide separately they will eventually disagree, and a customer who can
 * export something they cannot erase, or the reverse, is a compliance defect
 * rather than a bug. So the classification lives here once and the other phases
 * read it.
 */
export type ErasureAction = 'delete' | 'anonymize' | 'retain';

export interface DataClass {
  key: string;
  label: string;
  description: string;
  containsPersonalData: boolean;
  erasure: ErasureAction;
  /** Why this class survives an erasure request, when it is not simply deleted. */
  retentionReason?: string;
  /** The legal framing a customer or auditor would expect to be quoted. */
  retentionBasis?: string;
}

const evidence = 'Retained as security evidence';
const securityRecord = 'Retained as a security record';

export const dataClasses: DataClass[] = [
  {
    key: 'organization',
    label: 'Workspace',
    description: 'Workspace name, slug and logo.',
    containsPersonalData: false,
    erasure: 'delete',
  },
  {
    key: 'client',
    label: 'Client records',
    description: 'The client companies an agency manages.',
    containsPersonalData: false,
    erasure: 'delete',
  },
  {
    key: 'domain',
    label: 'Monitored domains',
    description: 'Domains, verification state, published DMARC record and forensic settings.',
    containsPersonalData: false,
    erasure: 'delete',
  },
  {
    key: 'scan',
    label: 'DNS scans',
    description: 'Point in time SPF, DKIM and MX results for each domain.',
    containsPersonalData: false,
    erasure: 'delete',
  },
  {
    key: 'report',
    label: 'Aggregate reports',
    description: 'DMARC aggregate reports received from mailbox providers.',
    containsPersonalData: false,
    erasure: 'delete',
    retentionReason: evidence,
    retentionBasis: 'DMARC aggregate reports contain no recipient data. They are the product record.',
  },
  {
    key: 'reportRecord',
    label: 'Per source report rows',
    description: 'One row per sending source inside an aggregate report.',
    containsPersonalData: false,
    erasure: 'delete',
  },
  {
    key: 'authResult',
    label: 'Authentication results',
    description: 'Detailed SPF and DKIM evaluation per source.',
    containsPersonalData: false,
    erasure: 'delete',
  },
  {
    key: 'forensicEvidence',
    label: 'Forensic report evidence',
    description: 'Per message failure detail: source IP, disposition, alignment and arrival time.',
    containsPersonalData: false,
    erasure: 'delete',
    retentionReason: evidence,
    retentionBasis:
      'Per message authentication results are retained as security evidence and contain no recipient data while pseudonyms are in use.',
  },
  {
    key: 'forensicPseudonym',
    label: 'Pseudonymous recipients',
    description: 'Recipient and subject values held as one way HMAC pseudonyms.',
    containsPersonalData: false,
    erasure: 'delete',
    retentionReason: evidence,
    retentionBasis:
      'One way HMAC pseudonyms cannot be reversed to an email address, so they are not personal data. They are retained so failure trends stay comparable over time.',
  },
  {
    key: 'forensicPersonalData',
    label: 'Named recipients',
    description: 'Real recipient email addresses and subject lines, stored only when a domain owner explicitly enables it.',
    containsPersonalData: true,
    erasure: 'delete',
    retentionReason: 'The personal data itself, which is the subject of the request.',
    retentionBasis:
      'Article 17 erasure. Deleted in full, including the encrypted copy, while the surrounding evidence record is kept.',
  },
  {
    key: 'alertRule',
    label: 'Alert rules',
    description: 'Configured thresholds, windows and recipients.',
    containsPersonalData: true,
    erasure: 'delete',
    retentionReason: 'Alert recipients are named people.',
  },
  {
    key: 'alertEvent',
    label: 'Alert history',
    description: 'Triggered alerts and their acknowledgement state.',
    containsPersonalData: false,
    erasure: 'delete',
  },
  {
    key: 'alertDelivery',
    label: 'Alert deliveries',
    description: 'Who an alert was delivered to, and whether it sent.',
    containsPersonalData: true,
    erasure: 'delete',
  },
  {
    key: 'reportShare',
    label: 'Client report links',
    description: 'Shareable links that let a client read a report without an account.',
    containsPersonalData: false,
    erasure: 'delete',
  },
  {
    key: 'reportDigest',
    label: 'Scheduled digests',
    description: 'Recurring client report emails and the addresses they go to.',
    containsPersonalData: true,
    erasure: 'delete',
    retentionReason: 'Digest recipients are named people at the client.',
  },
  {
    key: 'notification',
    label: 'In app notifications',
    description: 'Notification feed for each user.',
    containsPersonalData: false,
    erasure: 'delete',
  },
  {
    key: 'notificationPreference',
    label: 'Notification preferences',
    description: 'Per user email, quiet hours and timezone.',
    containsPersonalData: true,
    erasure: 'delete',
  },
  {
    key: 'member',
    label: 'Workspace membership',
    description: 'Which people have access to this workspace, and in which role.',
    containsPersonalData: true,
    erasure: 'delete',
  },
  {
    key: 'invitation',
    label: 'Pending invitations',
    description: 'Invited email addresses that have not yet accepted.',
    containsPersonalData: true,
    erasure: 'delete',
  },
  {
    key: 'session',
    label: 'Sessions',
    description: 'Active sign ins, including IP address and device.',
    containsPersonalData: true,
    erasure: 'delete',
  },
  {
    key: 'account',
    label: 'Linked accounts',
    description: 'OAuth tokens and password credentials.',
    containsPersonalData: true,
    erasure: 'delete',
  },
  {
    key: 'user',
    label: 'User accounts',
    description: 'Name and email address of every person with access.',
    containsPersonalData: true,
    erasure: 'delete',
  },
  {
    key: 'auditLog',
    label: 'Audit trail',
    description: 'Who did what, with IP address and request id.',
    containsPersonalData: true,
    erasure: 'anonymize',
    retentionReason: securityRecord,
    retentionBasis:
      'The security record is kept because an auditor needs proof that a change was controlled. Identifying fields are cleared so the record proves the action without keeping the person.',
  },
  {
    key: 'subscription',
    label: 'Subscription',
    description: 'Plan and billing period.',
    containsPersonalData: false,
    erasure: 'anonymize',
    retentionReason: 'Statutory accounting record',
    retentionBasis:
      'Tax law requires invoice and payment records to be kept after the relationship ends. The plan and period are kept; the provider customer identifiers are cleared.',
  },
  {
    key: 'entitlementOverride',
    label: 'Entitlement overrides',
    description: 'Internal support notes about granted features.',
    containsPersonalData: true,
    erasure: 'delete',
  },
];

export const dataClassByKey: Map<string, DataClass> = new Map(dataClasses.map((entry) => [entry.key, entry]));

export function personalDataClasses(): DataClass[] {
  return dataClasses.filter((entry) => entry.containsPersonalData);
}

export function retainedClasses(): DataClass[] {
  return dataClasses.filter((entry) => entry.erasure === 'retain' || entry.erasure === 'anonymize');
}
