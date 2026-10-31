import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { recordAuditEvent } from '../audit.service.js';
import { resolveBranding } from '../branding.service.js';
import { resolveEntitlements } from '../entitlements/entitlement.service.js';
import { erasureGraceDays } from '../erasure/erasure.service.js';
import { forensicPiiRetentionDays, forensicRetentionDays, reportRetentionDays } from '../privacy.service.js';
import { collectClientEvidence, type ClientEvidence } from './client-evidence.service.js';

/**
 * The client facing Trust Center.
 *
 * An enterprise auditor asks their MSP where their DMARC data is held and who
 * can read it. The honest answer today is a PDF attachment or a support ticket.
 * This is a public page at a stable, unguessable address, so the link can be
 * forwarded to somebody who has never heard of us and will not create an
 * account.
 *
 * The whole feature rests on one property: this function may only ever read
 * rows belonging to a single client. Every query below is anchored on the
 * client resolved from the slug, never on the workspace, because an agency
 * holds many clients and a mistake here publishes one customer's data on another
 * customer's page. The isolation suite proves it, and the leak test in the Trust
 * Center suite proves it again from the public side.
 *
 * The slug is random rather than a path segment like the client name, because
 * an enumerable Trust Center would disclose which clients an agency serves.
 */

export class TrustCenterError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'TRUST_CENTER_ERROR', status = 400) {
    super(message);
    this.name = 'TrustCenterError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Sub processors this product actually sends data to.
 *
 * Held as data rather than left in the published document, so the page cannot
 * quietly drift from the document an agency's clients were sent. A Trust Center
 * that names a different set of processors than the signed document is worse
 * than no Trust Center at all.
 */
export interface SubProcessor {
  name: string;
  purpose: string;
  data: string;
  /** As the sub-processor list states it. "Not confirmed yet" is an open decision, said as one. */
  region: string;
}

/**
 * The list in docs/SUB-PROCESSORS.md, row for row and in its order.
 *
 * That document is the one an agency's clients are given under the DPA, so
 * this list follows it rather than the other way round. It disagreed before:
 * it named Amazon Web Services as the host of the database and everything
 * held, where the document names it for logo storage only, and it had no
 * regions. Where the document still says TBD, this says "Not confirmed yet":
 * a region that has not been decided is not one to print.
 */
export const subProcessors: SubProcessor[] = [
  {
    name: 'Resend',
    purpose: 'Transactional and alert email',
    data: 'Email addresses and names of the people notified, and the notification content. Alert content may include domain names, sender sources and counts.',
    region: 'Not confirmed yet',
  },
  {
    // Reports pass through its email routing on the way in, and the records an
    // agency delegates (hosted DMARC, SPF, BIMI, MTA-STS) are served from a zone
    // it hosts.
    name: 'Cloudflare',
    purpose:
      'Email routing and the report ingress Worker; the DNS zone that serves delegated records (hosted DMARC, SPF and BIMI); hosted MTA-STS policy files',
    data: 'Raw DMARC report messages in transit only, which the Worker forwards and does not store. Public DNS values and policy files.',
    region: 'Global edge',
  },
  {
    name: 'Amazon Web Services',
    purpose: 'Object storage for workspace logos (S3)',
    data: 'The logo files a workspace uploads',
    region: 'Not confirmed yet',
  },
  {
    name: 'Managed PostgreSQL provider',
    purpose: 'Primary database',
    data: 'All stored data',
    region: 'Not confirmed yet',
  },
  {
    // Named because report collection depends on it, as the document does.
    name: 'Migadu',
    purpose: 'Hosted mailbox that receives aggregate and forensic reports',
    data: 'Inbound report messages, which may contain recipient email addresses',
    region: 'Not confirmed yet',
  },
  {
    name: 'Razorpay',
    purpose: 'Subscription billing in Indian rupees, as payment gateway',
    data: 'Company name, billing contact email, plan and amount. Not DMARC data.',
    region: 'India',
  },
  {
    name: 'Paddle',
    purpose: 'Subscription billing in US dollars, as merchant of record',
    data: 'Company name, billing contact email, plan and amount. Not DMARC data.',
    region: "Provider's region",
  },
  {
    name: 'Google and Microsoft',
    purpose: 'Optional federated sign-in',
    data: 'Name, email address and provider identifier, only where social sign-in is used',
    region: "Provider's region",
  },
];

/** From the same document: what an agency connects is under its own agreements. */
export const connectedServicesStatement =
  'Services the managing agency chooses to connect (chat for alerts, ticketing, webhooks, its own DNS account, its own report mailbox, its own identity provider) are not sub-processors. They run under its own agreement with each provider and receive only what it configures.';

/** Provable in the code: the web app loads no analytics, advertising or replay script. */
export const noTrackingStatement =
  'No third-party analytics, advertising or session-replay service is used, and workspace activity is not profiled for marketing.';

/**
 * The region the deployment's data actually sits in.
 *
 * Read from configuration rather than hardcoded, because a Trust Center that
 * names the wrong jurisdiction is a compliance statement that is wrong rather
 * than one that is missing. Unset, it says so in words a client can read: the
 * old fallback pointed at an internal launch checklist from a public page.
 */
export function dataResidencyRegion(env: { DATA_RESIDENCY_REGION?: string }): string {
  return env.DATA_RESIDENCY_REGION?.trim() || 'Not confirmed yet';
}

/**
 * Retention as the code enforces it, line by line, for both documents.
 *
 * Each line names a window a sweep applies, or says plainly that none is.
 */
export function retentionLines(): { label: string; value: string }[] {
  return [
    { label: 'DMARC aggregate reports', value: `${reportRetentionDays()} days from receipt, then deleted automatically` },
    { label: 'TLS reports', value: `${reportRetentionDays()} days from receipt, then deleted automatically` },
    { label: 'Forensic reports', value: `${forensicRetentionDays()} days from receipt, then deleted automatically` },
    { label: 'Named recipients in forensic data', value: `${forensicPiiRetentionDays()} days, the shortest window, for the most sensitive data` },
    {
      label: 'DNS check history',
      value:
        'The 30 most recent scheduled checks of each domain. Checks a person ran, and checks that recorded a change, are kept with the domain.',
    },
    { label: 'Audit trail', value: 'Kept until a deletion request removes it. No automatic expiry is scheduled.' },
    { label: 'Deletion window', value: `${erasureGraceDays} days between a deletion request and it running` },
  ];
}

/**
 * What this deployment actually does, which is not the plan's published figure.
 *
 * These were `planCatalog[plan].dataRetentionDays` and `auditRetentionDays`. The
 * comment above this function claimed the figure was "quoted from the plan
 * actually in force, not from marketing copy", which is true of where it came
 * from and false of what it described. `dataRetentionDays` governs one thing only,
 * and that is whether a dormant domain still counts toward the active domain
 * quota; it is not a deletion window. `auditRetentionDays` is read by no code in
 * the repository, because nothing deletes an audit log.
 *
 * What is enforced: aggregate reports expire at `retentionExpiresAt`, stamped from
 * `REPORT_RETENTION_DAYS`; forensic reports from `FORENSIC_RETENTION_DAYS`; and
 * named recipients on the shorter PII window. Those are the numbers a customer can
 * hold us to.
 *
 * The shape is unchanged on purpose. `apps/web` renders `retention.data`,
 * `.audit` and `.deletionWindow` directly, and a compliance document's field
 * names are not the place to break a consumer.
 *
 * There is deliberately no plan parameter. Retention stopped being a per-plan
 * figure when it stopped being fictional, and leaving an unused argument behind
 * would invite the next person to wire it back to `planCatalog`.
 */
function retentionFor(): { data: string; audit: string } {
  return {
    data: `Aggregate reports ${reportRetentionDays()} days, forensic reports ${forensicRetentionDays()} days`,
    audit: 'Kept until a deletion request removes it',
  };
}

export interface TrustCenterPayload {
  generatedAt: string;
  client: { name: string; domains: string[] };
  /**
   * Who publishes the page. The name always; the logo and colours only when the
   * workspace is white-labelled, the same rule the client portal and the
   * prospect report follow.
   */
  provider: {
    workspaceName: string;
    branded: boolean;
    logoUrl: string | null;
    primaryColor: string | null;
    accentColor: string | null;
  };
  statement: {
    isolation: string;
    coveredByTests: string;
    lawEnforcementRequests: string;
  };
  dataHeld: { category: string; description: string; containsPersonalData: boolean }[];
  access: { role: string; canRead: string }[];
  retention: { data: string; audit: string; deletionWindow: string };
  /** Every window the code enforces, one line each. `retention` keeps its shape for older readers. */
  retentionDetail: { label: string; value: string }[];
  residency: { region: string; hosting: string };
  subProcessors: SubProcessor[];
  connectedServices: string;
  noTracking: string;
  rights: { export: string; erasure: string };
  erasures: { scope: string; completedAt: string; recordCount: number }[];
  /** Posture, policy history, monitoring coverage, senders and open findings, as of `generatedAt`. */
  evidence: ClientEvidence;
  /** The scheduled DNS monitor as this deployment runs it. */
  monitoring: { scheduled: boolean; intervalMinutes: number };
  /** The packs issued for this client, newest first, so a holder can check a copy here too. */
  evidencePacks: {
    reference: string;
    sha256: string;
    issuedAt: string;
    dataAsOf: string;
    superseded: boolean;
    documentVersion: string;
    pageCount: number;
  }[];
  /** No contact address is held for a client page, and none is invented. */
  contact: { name: string; detail: string };
}

/**
 * Creates the public slug if the client does not have one.
 *
 * Idempotent, because calling it twice must not invalidate a link that has
 * already been shared with an auditor.
 */
export async function ensureTrustSlug(clientId: string, actorUserId?: string | null): Promise<string> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, trustSlug: true },
  });

  if (!client) {
    throw new TrustCenterError('That client does not exist.', 'CLIENT_NOT_FOUND', 404);
  }

  if (client.trustSlug) {
    return client.trustSlug;
  }

  const slug = randomBytes(24).toString('base64url');

  try {
    await prisma.client.update({ where: { id: clientId }, data: { trustSlug: slug } });
  } catch (error) {
    // A collision on 192 bits of entropy is not something to expect, but a
    // retry is cheaper than a failure the agency cannot act on.
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002') {
      return ensureTrustSlug(clientId, actorUserId);
    }
    throw error;
  }

  await recordAuditEvent({
    organizationId: (await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { organizationId: true } })).organizationId,
    actorUserId: actorUserId ?? undefined,
    action: 'TRUST_CENTER_CREATED',
    targetType: 'client',
    targetId: clientId,
    detail: { slug },
  });

  return slug;
}

/**
 * Withdraws the public link.
 *
 * Revocation is the point: an agency that stops working with a client must be
 * able to pull the page, and a page that has been shared cannot be recalled.
 */
export async function revokeTrustSlug(clientId: string, actorUserId?: string | null): Promise<void> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, organizationId: true, trustSlug: true },
  });

  if (!client) {
    throw new TrustCenterError('That client does not exist.', 'CLIENT_NOT_FOUND', 404);
  }

  await prisma.client.update({ where: { id: clientId }, data: { trustSlug: null } });

  await recordAuditEvent({
    organizationId: client.organizationId,
    actorUserId: actorUserId ?? undefined,
    action: 'TRUST_CENTER_REVOKED',
    targetType: 'client',
    targetId: clientId,
    detail: { previousSlug: client.trustSlug },
  });
}

/**
 * Builds the public payload for one client.
 *
 * Every query is anchored on the client resolved from the slug. Nothing here is
 * filtered by the workspace, because a workspace holds many clients and the
 * failure mode is publishing one client's data on another's page.
 */
export async function buildTrustCenter(slug: string): Promise<TrustCenterPayload> {
  const client = await prisma.client.findUnique({
    where: { trustSlug: slug },
    select: {
      id: true,
      name: true,
      organizationId: true,
      organization: { select: { name: true, plan: true } },
    },
  });

  if (!client) {
    // The same response for a missing slug and a withdrawn one, so the endpoint
    // does not confirm that a client ever had a Trust Center.
    throw new TrustCenterError('No Trust Center at this address.', 'TRUST_CENTER_NOT_FOUND', 404);
  }

  const entitlements = await resolveEntitlements(client.organizationId);

  // A public page stops when its feature does. Only publishing was gated, so a
  // workspace that downgraded kept serving every Trust Center it had made. The
  // answer is the same as for a withdrawn link, and the link works again after
  // an upgrade.
  if (!entitlements.features['trust.center']) {
    throw new TrustCenterError('No Trust Center at this address.', 'TRUST_CENTER_NOT_FOUND', 404);
  }

  const generatedAt = new Date();

  // Scoped to the client id, never the workspace.
  const [domains, grants, erasures, branding, evidence, packs] = await Promise.all([
    prisma.domain.findMany({
      where: { clientId: client.id },
      select: { name: true },
      orderBy: { name: 'asc' },
      take: 200,
    }),
    prisma.clientPortalAccess.findMany({
      where: { clientId: client.id, revokedAt: null },
      select: { displayName: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.erasureRequest.findMany({
      where: { organizationId: client.organizationId, state: 'COMPLETED', scope: { in: ['ORGANIZATION', 'CLIENT'] } },
      select: { id: true, scope: true, targetId: true, completedAt: true },
      orderBy: { completedAt: 'desc' },
      take: 20,
    }),
    resolveBranding(client.organizationId),
    collectClientEvidence({
      clientId: client.id,
      organizationId: client.organizationId,
      asOf: generatedAt,
      domainLimit: 200,
    }),
    // Packs for this client only. Their references and digests are already
    // public through the verifier; listing them here is what makes the pack's
    // own instruction, "compare it with the value on the Trust Center", true.
    prisma.compliancePack.findMany({
      where: { clientId: client.id, organizationId: client.organizationId, scope: 'CLIENT' },
      select: {
        reference: true,
        pdfHash: true,
        createdAt: true,
        asOf: true,
        supersededAt: true,
        documentVersion: true,
        pageCount: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 5,
    }),
  ]);

  const retention = retentionFor();

  // Only the erasure requests that actually covered this client. An
  // organization wide deletion covered it too, so both are relevant and
  // anything else is not.
  const relevantErasures = (
    await Promise.all(
      erasures
        .filter((request) => request.scope === 'ORGANIZATION' || request.targetId === client.id)
        .map(async (request) => ({
          scope: request.scope === 'ORGANIZATION' ? 'whole workspace' : 'client',
          completedAt: request.completedAt?.toISOString() ?? '',
          recordCount: await deletedCountFor(request.id),
        })),
    )
  );

  return {
    generatedAt: generatedAt.toISOString(),
    client: { name: client.name, domains: domains.map((domain) => domain.name) },
    provider: {
      workspaceName: client.organization.name,
      branded: branding.branded,
      logoUrl: branding.branded ? branding.logoUrl : null,
      primaryColor: branding.branded ? branding.primaryColor : null,
      accentColor: branding.branded ? branding.accentColor : null,
    },
    statement: {
      isolation:
        'Records for this client are stored under a tenant boundary keyed to this client. No other client of the same provider, and no other provider using this platform, can read them. Access is checked on every request, not only at sign in.',
      coveredByTests:
        'The boundary is covered by an automated suite that attempts to reach this client from a second, unrelated workspace and asserts every attempt is refused.',
      lawEnforcementRequests:
        'A valid legal process is the only circumstance in which data for this client is disclosed outside the provider who manages it. Any such request is recorded in the audit trail.',
    },
    dataHeld: [
      { category: 'DMARC aggregate reports', description: 'Volume, authentication results and sending source counts per reporting period.', containsPersonalData: false },
      { category: 'Domain and DNS records', description: 'Domain names, DMARC policy, and the ownership record used to prove control.', containsPersonalData: false },
      { category: 'DNS checks', description: 'DMARC, SPF, DKIM, MX, MTA-STS, TLS-RPT and BIMI results captured at each check, and the changes between checks.', containsPersonalData: false },
      { category: 'TLS reports', description: 'Counts of successful and failed TLS sessions reported by receiving mail servers.', containsPersonalData: false },
      { category: 'Forensic reports', description: 'Per message source detail including sending IP addresses.', containsPersonalData: Boolean(entitlements.features['reports.forensicNamed']) },
      { category: 'Named recipients', description: 'Individual recipients, collected only on plans that include it. Never shown to portal contacts.', containsPersonalData: Boolean(entitlements.features['reports.forensicNamed']) },
      { category: 'Account and billing records', description: 'Workspace members, portal grants and payment history.', containsPersonalData: true },
    ],
    access: [
      { role: 'Workspace owner and admin', canRead: 'Everything held for this client' },
      { role: 'Workspace member', canRead: 'Everything held for this client' },
      ...grants.map((grant) => ({
        role: grant.displayName ? `Portal contact (${grant.displayName})` : 'Portal contact',
        canRead: 'Report volume, sending sources and spoofing warnings. No forensic data, no named recipients.',
      })),
    ],
    retention: {
      data: retention.data,
      audit: retention.audit,
      deletionWindow: `${erasureGraceDays} days between requesting deletion and it running`,
    },
    retentionDetail: retentionLines(),
    residency: {
      region: dataResidencyRegion(process.env),
      hosting: 'A managed PostgreSQL database for records; object storage for workspace logos only',
    },
    subProcessors,
    connectedServices: connectedServicesStatement,
    noTracking: noTrackingStatement,
    rights: {
      export: 'A machine readable export of everything held can be requested at any time, and is available on every plan including the free one.',
      erasure: 'Deletion can be requested for this client, the workspace, or a single domain. A certificate proving what was removed is retained.',
    },
    erasures: relevantErasures,
    evidence,
    monitoring: { scheduled: env.DNS_MONITOR_ENABLED, intervalMinutes: env.DNS_MONITOR_INTERVAL_MINUTES },
    evidencePacks: packs.map((pack) => ({
      reference: pack.reference,
      sha256: pack.pdfHash,
      issuedAt: pack.createdAt.toISOString(),
      dataAsOf: pack.asOf.toISOString(),
      superseded: pack.supersededAt !== null,
      documentVersion: pack.documentVersion,
      pageCount: pack.pageCount,
    })),
    contact: {
      name: client.organization.name,
      detail: `${client.organization.name} publishes this page and manages these domains for ${client.name}. Send questions to your usual contact there. This page does not carry a contact address.`,
    },
  };
}

/**
 * Reads the record count out of a stored certificate.
 *
 * Counted from the certificate rather than recomputed, because the records it
 * describes no longer exist, which is the entire point of the artifact.
 */
async function deletedCountFor(erasureRequestId: string): Promise<number> {
  const row = await prisma.erasureRequest.findUnique({
    where: { id: erasureRequestId },
    select: { certificate: true },
  });

  const certificate = row?.certificate;
  if (typeof certificate !== 'object' || certificate === null || !('deleted' in certificate)) {
    return 0;
  }

  const deleted = (certificate as { deleted?: Record<string, number> }).deleted;
  if (typeof deleted !== 'object' || deleted === null) {
    return 0;
  }

  return Object.values(deleted).reduce((total, value) => (typeof value === 'number' ? total + value : total), 0);
}

/** Lets the agency see the link for one client, or that there is none. */
export async function trustSlugStatus(clientId: string): Promise<{ url: string | null; slug: string | null }> {
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { trustSlug: true } });
  if (!client) {
    throw new TrustCenterError('That client does not exist.', 'CLIENT_NOT_FOUND', 404);
  }
  return { slug: client.trustSlug, url: client.trustSlug ? `/trust/${client.trustSlug}` : null };
}
