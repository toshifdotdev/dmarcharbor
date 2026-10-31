import { createHash, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { recordAuditEvent } from '../audit.service.js';
import { resolveBranding } from '../branding.service.js';
import { resolveEntitlements } from '../entitlements/entitlement.service.js';
import { withPdfSlot } from '../pdf-concurrency.js';
import { collectClientEvidence } from './client-evidence.service.js';
import { renderCompliancePack, type PackFacts } from './pack-pdf.js';
import {
  TrustCenterError,
  connectedServicesStatement,
  dataResidencyRegion,
  noTrackingStatement,
  retentionLines,
  subProcessors,
} from './trust-center.service.js';

/**
 * The signed compliance pack.
 *
 * One document an MSP hands to their client's procurement team, auditor or
 * insurer, covering what that reader asks about: each domain's DMARC, SPF,
 * DKIM, MTA-STS, TLS-RPT and BIMI posture from the newest check, the policy
 * history, monitoring coverage, the senders seen, the open findings and what
 * is being done, how the evidence was gathered, and then what is held, who can
 * read it, how long it is kept, who else touches it, and the client's rights.
 * The facts are gathered here; pack-pdf.ts sets them.
 *
 * The integrity model is deliberately modest and deliberately honest. The PDF is
 * not stored. Its SHA-256 is, and that hash is published on the client's Trust
 * Center, so anybody holding a copy can prove it has not been altered since it
 * was issued. What that does not prove is that we are trustworthy or that the
 * contents are true, and the document says so on its own face rather than
 * implying a guarantee it cannot deliver.
 *
 * Determinism is a requirement, not a nicety. pdfkit stamps a creation date of
 * its own, which would make every regeneration a different document with a
 * different hash, and the agency could never show that nothing had changed. The
 * date is therefore pinned to the as of timestamp the document already states,
 * so identical inputs produce identical bytes.
 */


/**
 * Builds the reference a reader quotes.
 *
 * Human-readable on purpose. This value appears in a document a customer hands
 * to their compliance team, and they have to be able to read it back over a phone
 * when asking us for the published digest. A cuid fails that: 25 characters of
 * noise that also disclose that the value is a database row and roughly when it
 * was created.
 *
 * Client slug and issue date so a reference sorts into a filing, plus a random
 * suffix for uniqueness within the same day.
 *
 * The suffix was six hex characters, which is 24 bits. That value is the only
 * secret part: the date is printed in the document, the slug is the client's name,
 * and `GET /api/capabilities` hands an anonymous caller a reference in this exact
 * format to show the marketing page. So the search space an attacker faces is the
 * 16.7 million values of that suffix for a given client and day, against a public
 * endpoint that answers 200 or 404. Hours of work on one machine, and what it
 * yields is a searchable index of which named client of which agency received a
 * signed compliance artefact, on what date.
 *
 * Twenty-four hex characters is 96 bits. Long enough that enumeration stops being
 * a plan, and hex rather than base64 keeps the character set to `[0-9A-Z]`, so the
 * reference still reads cleanly over the phone and existing references, which are
 * six characters, keep verifying: the lookup is by exact string and was never
 * format constrained.
 */
export function compliancePackReference(clientName: string, asOf: Date): string {
  const slug = clientName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .toUpperCase();

  const date = asOf.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = randomBytes(12).toString('hex').toUpperCase();

  return `DMARC-${date}-${slug || 'CLIENT'}-${suffix}`;
}

/**
 * A filename safe to put in a Content-Disposition header.
 *
 * The reference is already alphanumeric plus hyphens, so this is a guard rather
 * than a transform: it exists so a future change to the reference format cannot
 * put a quote, a newline or a path separator into a response header.
 */
export function compliancePackFilename(reference: string, asOf: Date): string {
  const safe = reference.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  return `dmarc-compliance-${safe}-${asOf.toISOString().slice(0, 10)}.pdf`;
}

/**
 * The template version a pack is issued under.
 *
 * 2.0 is the evidence pack: a cover, contents, running heads, and the posture,
 * history, coverage, sender and findings sections. Packs issued as 1.0 keep
 * verifying, because the verifier reads the version stored with each pack,
 * not this constant.
 */
export const documentVersion = '2.0';

export class CompliancePackError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'COMPLIANCE_PACK_ERROR', status = 400) {
    super(message);
    this.name = 'CompliancePackError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Why the hash is not printed in the document.
 *
 * A file cannot contain its own digest. Printing the SHA-256 inside the PDF
 * changes the bytes, which changes the digest, which changes what would have to
 * be printed. Any scheme that appears to solve this is either circular or is
 * really a signature over the content with the signature block excluded.
 *
 * So the document carries a reference the reader can quote, and the digest is
 * published separately, on the public verifier and on the client's Trust
 * Center. Verification is then: hash the downloaded file, compare it with the
 * published value. That is a real check, and it cannot be faked by editing the
 * file, because editing it changes the digest.
 */

/**
 * Gathers everything the document asserts.
 *
 * Scoped to one client throughout. An agency holds many clients, and a document
 * that names another customer's data would be handed to a procurement team and
 * kept on file, which is worse than anything this feature could ever be worth.
 *
 * The retention lines are the windows the running service applies, not the
 * plan's published figure. There are several and they differ by two orders of
 * magnitude; collapsing them into the plan's single `dataRetentionDays` is how
 * a document ends up saying the most sensitive data is held for 1095 days when
 * named recipients are held for 7.
 */
async function collectFacts(clientId: string, asOf: Date, reference: string): Promise<PackFacts> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      organizationId: true,
      trustSlug: true,
      organization: { select: { name: true } },
    },
  });

  if (!client) {
    throw new CompliancePackError('That client does not exist.', 'CLIENT_NOT_FOUND', 404);
  }

  const entitlements = await resolveEntitlements(client.organizationId);
  const namedRecipients = Boolean(entitlements.features['reports.forensicNamed']);

  const [contacts, erasures, branding, evidence] = await Promise.all([
    prisma.clientPortalAccess.count({ where: { clientId: client.id, revokedAt: null } }),
    prisma.erasureRequest.findMany({
      where: {
        organizationId: client.organizationId,
        state: 'COMPLETED',
        OR: [{ scope: 'ORGANIZATION' }, { scope: 'CLIENT', targetId: client.id }],
      },
      select: { id: true, scope: true, completedAt: true, certificate: true },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      take: 25,
    }),
    resolveBranding(client.organizationId),
    collectClientEvidence({ clientId: client.id, organizationId: client.organizationId, asOf, domainLimit: 500 }),
  ]);

  // The verifier the document points at: the agency's own verified domain when
  // it is white-labelled, as the monthly report does, and ours otherwise.
  const verifyBase =
    branding.branded && branding.customDomain ? `https://${branding.customDomain}` : env.APP_URL.replace(/\/$/, '');

  return {
    client: { name: client.name },
    publisher: { workspaceName: client.organization.name, branded: branding.branded, verifyBase },
    asOf,
    reference,
    documentVersion,
    portalContacts: contacts,
    dataHeld: [
      { category: 'DMARC aggregate reports', description: 'Volume, authentication results and sending source counts per period.', personal: false },
      { category: 'Domain and DNS records', description: 'Domain names, DMARC policy, and the ownership record proving control.', personal: false },
      { category: 'DNS checks', description: 'DMARC, SPF, DKIM, MX, MTA-STS, TLS-RPT and BIMI results captured at each check, and the changes between checks.', personal: false },
      { category: 'TLS reports', description: 'Counts of successful and failed TLS sessions reported by receiving mail servers.', personal: false },
      { category: 'Forensic reports', description: 'Per message source detail including sending IP addresses.', personal: false },
      { category: 'Named recipients', description: 'Individual recipients, collected only on plans that include it.', personal: namedRecipients },
      { category: 'Account and billing records', description: 'Workspace members, portal grants and payment history.', personal: true },
    ],
    retention: retentionLines(),
    subProcessors,
    connectedServices: connectedServicesStatement,
    noTracking: noTrackingStatement,
    residency: {
      region: dataResidencyRegion(process.env),
      hosting: 'A managed PostgreSQL database for records; object storage for workspace logos only',
    },
    erasures: erasures.map((request) => ({
      scope: request.scope === 'ORGANIZATION' ? 'Whole workspace' : 'Single client',
      completedAt: request.completedAt?.toISOString() ?? '',
      records: countDeleted(request.certificate),
    })),
    rights: {
      export: 'A machine readable export of everything held can be requested at any time and is available on every plan, including the free one.',
      erasure: 'Deletion can be requested for this client, the whole workspace, or a single domain. A certificate recording what was removed is retained.',
    },
    lawEnforcement:
      'A valid legal process is the only circumstance in which data for this client is disclosed outside the provider who manages it. Any such request is recorded in the audit trail.',
    evidence,
    monitor: { scheduled: env.DNS_MONITOR_ENABLED, intervalMinutes: env.DNS_MONITOR_INTERVAL_MINUTES },
    trustCenterPublished: client.trustSlug !== null && Boolean(entitlements.features['trust.center']),
  };
}

function countDeleted(certificate: unknown): number {
  if (typeof certificate !== 'object' || certificate === null || !('deleted' in certificate)) {
    return 0;
  }
  const deleted = (certificate as { deleted?: Record<string, number> }).deleted;
  if (typeof deleted !== 'object' || deleted === null) {
    return 0;
  }
  return Object.values(deleted).reduce((total, value) => (typeof value === 'number' ? total + value : total), 0);
}

/**
 * Renders the document and returns the exact bytes.
 *
 * The digest is taken over this buffer, and these same bytes are what the
 * caller streams to the client. Hashing anything else would fingerprint a
 * document nobody ever received.
 *
 * Rendering is deterministic for a given set of facts, so regenerating a pack
 * for the same as of date produces the same digest. The PDF creation date is
 * pinned to that as of timestamp rather than taken from the clock, because
 * pdfkit would otherwise stamp a fresh date on every run and make every
 * regeneration a different document.
 */
export async function buildCompliancePackPdf(input: {
  clientId: string;
  asOf?: Date;
  reference: string;
}): Promise<{ buffer: Buffer; hash: string; pageCount: number; asOf: Date; documentVersion: string }> {
  const asOf = input.asOf ?? new Date();
  const facts = await collectFacts(input.clientId, asOf, input.reference);

  /**
   * Under the concurrency ceiling.
   *
   * Only the render is capped, not the fact gathering: a build that is waiting for a
   * slot holds no buffer, and the queries are the cheap part. Wrapping the render is
   * where the memory actually is.
   */
  const rendered = await withPdfSlot(() => renderCompliancePack(facts));
  const hash = createHash('sha256').update(rendered.buffer).digest('hex');

  return { buffer: rendered.buffer, hash, pageCount: rendered.pageCount, asOf, documentVersion };
}

export interface IssuedPack {
  id: string;
  /** The value printed in the document, quoted in the filename and used to verify. */
  reference: string;
  /**
   * Exposed because it is the cheapest available regression signal for the layout.
   *
   * The first issued pack ran to seven pages for the same facts because row heights
   * were estimated from string length, reserving 80 to 95 points for a single line
   * of text. Rows are measured now, and the 2.0 pack (cover, contents and twelve
   * sections) runs to a known number of pages for a one-domain client. A future
   * change that reintroduces the estimate moves this number, so it is asserted
   * rather than eyeballed.
   */
  pageCount: number;
  hash: string;
  byteSize: number;
  asOf: Date;
  documentVersion: string;
  supersededPrevious: boolean;
}

/**
 * Issues a pack and records its fingerprint.
 *
 * The bytes are streamed to the client and deliberately not persisted. What is
 * stored is the hash of exactly those bytes, so a reader can prove the copy
 * they hold is the one that was issued.
 */
export async function issueCompliancePack(input: {
  clientId: string;
  organizationId: string;
  actorUserId?: string | null;
  asOf?: Date;
}): Promise<IssuedPack & { buffer: Buffer }> {
  const asOf = input.asOf ?? new Date();

  // The reference is derived from the client and the date so it is legible, and it
  // is stored rather than minted and discarded. The first implementation printed a
  // UUID that was never persisted while the public lookup resolved on the primary
  // key, so the value the document told a reader to quote could not be quoted.
  const client = await prisma.client.findFirstOrThrow({
    where: { id: input.clientId, organizationId: input.organizationId },
    select: { name: true },
  });
  const reference = compliancePackReference(client.name, asOf);

  const rendered = await buildCompliancePackPdf({
    clientId: input.clientId,
    asOf,
    reference,
  });

  const previous = await prisma.compliancePack.findFirst({
    where: { clientId: input.clientId, scope: 'CLIENT', supersededAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  // An identical document for the same as of date has the same hash, which
  // would collide on the unique index. Reuse it rather than fail.
  //
  // Scoped to the requesting workspace. `pdfHash` is globally unique, so a
  // workspace that happened to produce the same bytes as another tenant's pack
  // got handed that other tenant's row back, reference and all, and never had a
  // row of its own created.
  const existing = await prisma.compliancePack.findFirst({
    where: { pdfHash: rendered.hash, organizationId: input.organizationId, scope: 'CLIENT' },
    select: { id: true, createdAt: true, reference: true },
  });

  if (existing) {
    return {
      id: existing.id,
      reference: existing.reference,
      pageCount: rendered.pageCount,
      hash: rendered.hash,
      byteSize: rendered.buffer.length,
      asOf: rendered.asOf,
      documentVersion: rendered.documentVersion,
      supersededPrevious: false,
      buffer: rendered.buffer,
    };
  }

  const row = await prisma.$transaction(async (tx) => {
    if (previous) {
      // History is kept, because an auditor may already hold the older pack and
      // the answer to "was this one ever issued" has to outlive a regeneration.
      await tx.compliancePack.update({ where: { id: previous.id }, data: { supersededAt: new Date() } });
    }

    return tx.compliancePack.create({
      data: {
        organizationId: input.organizationId,
        clientId: input.clientId,
        scope: 'CLIENT',
        documentVersion: rendered.documentVersion,
        asOf: rendered.asOf,
        pdfHash: rendered.hash,
        reference,
        byteSize: rendered.buffer.length,
        pageCount: rendered.pageCount,
        generatedById: input.actorUserId ?? null,
      },
      select: { id: true, createdAt: true, reference: true },
    });
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'COMPLIANCE_PACK_ISSUED',
    targetType: 'compliance_pack',
    targetId: row.id,
    detail: {
      clientId: input.clientId,
      reference: row.reference,
      hash: rendered.hash,
      byteSize: rendered.buffer.length,
      documentVersion: rendered.documentVersion,
      asOf: rendered.asOf.toISOString(),
    },
  });

  return {
    id: row.id,
    reference: row.reference,
    pageCount: rendered.pageCount,
    hash: rendered.hash,
    byteSize: rendered.buffer.length,
    asOf: rendered.asOf,
    documentVersion: rendered.documentVersion,
    supersededPrevious: Boolean(previous),
    buffer: rendered.buffer,
  };
}

/** What has been issued for a client, newest first. */
export async function listCompliancePacks(clientId: string): Promise<
  {
    id: string;
    /**
     * The human-quotable document reference, e.g. `DMARC-20261004-ACME-8P1709`.
     *
     * Returned here because this list is the only place an operator can get it,
     * and without it there is no way to construct a working link to the public
     * verifier: the frontend was passing the row id, the verifier looks up by
     * reference, and the reference was not in the response. So the verify link on
     * every issued pack 404s and there is no identifier on screen to fix it with.
     */
    reference: string;
    hash: string;
    issuedAt: string;
    asOf: string;
    superseded: boolean;
    documentVersion: string;
  }[]
> {
  const rows = await prisma.compliancePack.findMany({
    where: { clientId, scope: 'CLIENT' },
    select: {
      id: true,
      reference: true,
      pdfHash: true,
      createdAt: true,
      asOf: true,
      supersededAt: true,
      documentVersion: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    hash: row.pdfHash,
    issuedAt: row.createdAt.toISOString(),
    asOf: row.asOf.toISOString(),
    superseded: row.supersededAt !== null,
    documentVersion: row.documentVersion,
  }));
}

export { TrustCenterError };
