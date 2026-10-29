import { createHash, randomBytes } from 'node:crypto';
import type { ExportFormat, ExportScope, Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma.js';
import { env } from '../../config/env.js';
import { sendExportReadyEmail } from '../../email/mailer.js';
import { dataClasses } from '../inventory/data-classes.js';
import { exportRedactions } from '../inventory/deletion-planner.js';
import { buildInventory, type InventoryScope } from '../inventory/inventory.service.js';

export const exportLinkDays = 7;
export const exportJobRetentionDays = 7;

/**
 * Rows read per table in an export, and rows read per report inside one.
 *
 * Chosen so a full-window export still completes in one request on a modest host
 * while a workspace whose retention window has fallen behind cannot take the
 * process down. `records` and `authResults` exist because a single report can
 * carry thousands of rows: a report whose records exceed the ceiling is itself
 * truncated and said to be, rather than being dropped in full.
 */
const exportTableLimit = 20_000;
const exportRecordLimit = 5_000;

export interface ExportRequest {
  organizationId: string;
  requestedById: string;
  scope: ExportScope;
  targetId?: string;
  format: ExportFormat;
}

function inventoryScopeFor(input: { organizationId: string; scope: ExportScope; targetId?: string }): InventoryScope {
  if (input.scope === 'CLIENT' && input.targetId) {
    return { kind: 'CLIENT', organizationId: input.organizationId, clientId: input.targetId };
  }
  if (input.scope === 'DOMAIN' && input.targetId) {
    return { kind: 'DOMAIN', organizationId: input.organizationId, domainId: input.targetId };
  }
  return { kind: 'ORGANIZATION', organizationId: input.organizationId };
}

async function scopeLabel(input: ExportRequest): Promise<string> {
  if (input.scope === 'CLIENT' && input.targetId) {
    const client = await prisma.client.findFirst({
      where: { id: input.targetId, organizationId: input.organizationId },
      select: { name: true },
    });
    return client ? `client:${client.name}` : 'client';
  }
  if (input.scope === 'DOMAIN' && input.targetId) {
    const domain = await prisma.domain.findFirst({
      where: { id: input.targetId, client: { organizationId: input.organizationId } },
      select: { name: true },
    });
    return domain ? `domain:${domain.name}` : 'domain';
  }
  return 'workspace';
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export async function createExportJob(input: ExportRequest): Promise<{ id: string; token: string; expiresAt: Date }> {
  const { token, hash } = issueToken();
  const expiresAt = new Date(Date.now() + exportLinkDays * 24 * 60 * 60 * 1000);
  const purgeAfter = new Date(Date.now() + exportJobRetentionDays * 24 * 60 * 60 * 1000);

  const scope = inventoryScopeFor(input);
  const inventory = await buildInventory(scope, { retentionDays: 400 });
  const redactions = exportRedactions(inventory);

  const job = await prisma.exportJob.create({
    data: {
      organizationId: input.organizationId,
      requestedById: input.requestedById,
      scope: input.scope,
      targetId: input.targetId ?? null,
      scopeLabel: await scopeLabel(input),
      format: input.format,
      state: 'READY',
      downloadTokenHash: hash,
      downloadExpiresAt: expiresAt,
      redactions: redactions as unknown as Prisma.InputJsonValue,
      purgeAfter,
    },
    select: { id: true },
  });

  // The export exists to satisfy a data access request, so the person who asked
  // for it is told it is ready rather than having to poll for it.
  const organization = await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { name: true } });
  await sendExportReadyEmail({
    organizationId: input.organizationId,
    exportJobId: job.id,
    scopeLabel: organization?.name ?? 'workspace',
    // The API's own download route, reached through the web origin's /api
    // proxy so the signed-in session cookie is first-party.
    downloadUrl: `${env.APP_URL.replace(/\/$/, '')}/api/workspaces/${input.organizationId}/exports/${job.id}/download?token=${encodeURIComponent(token)}`,
    expiresAt,
  });

  return { id: job.id, token, expiresAt };
}

export interface ExportPayload {
  meta: {
    product: string;
    generatedAt: string;
    scope: ExportScope;
    scopeLabel: string;
    format: ExportFormat;
    notice: string;
    /**
     * Tables that held more than one request could carry, present only then.
     *
     * Absent on a complete export on purpose: a customer downloading their data
     * should not have to read past a caveat that does not apply to them.
     */
    limited?: string[];
    limitedNotice?: string;
  };
  classification: { key: string; label: string; personalData: boolean; erasure: string; basis: string }[];
  redactions: { key: string; label: string; count: number; why: string }[];
  data: Record<string, unknown[]>;
}

/**
 * Builds the export from the same scope resolution the erasure planner reads.
 *
 * Credential material is removed here rather than downstream. A session token,
 * a password hash or an OAuth refresh token is not the customer's data to
 * download, it is the mechanism by which the download would be authorised, so
 * it is never serialised at all.
 */
export async function buildExportPayload(input: {
  organizationId: string;
  scope: ExportScope;
  targetId?: string;
  format: ExportFormat;
  scopeLabel: string;
}): Promise<ExportPayload> {
  const scope = inventoryScopeFor(input);
  const org = input.organizationId;
  const domainFilter: Prisma.DomainWhereInput =
    input.scope === 'DOMAIN' && input.targetId
      ? { id: input.targetId, client: { organizationId: org } }
      : input.scope === 'CLIENT' && input.targetId
        ? { clientId: input.targetId, client: { organizationId: org } }
        : { client: { organizationId: org } };

  /**
   * Every table here is read in a window rather than in full.
   *
   * All of them were unbounded `findMany`, and the result is materialised and
   * then serialised into a single response: a workspace holding hundreds of
   * thousands of report records built an object measured in hundreds of megabytes
   * inside the request, which is one export away from the process running out of
   * memory and taking every tenant with it.
   *
   * Bounded rather than moved to a worker because an export is a statutory
   * download: the customer asked for their data and it has to arrive. A
   * truncated export that says it was truncated is a real answer, while an out of
   * memory is not, so `limited` below records which tables hit their ceiling and
   * the record carries the date the export stops at.
   *
   * The audit log is held to a larger window because it is the evidence chain
   * rather than bulk data, and rounding it down would quietly lose the record a
   * dispute turns on.
   */
  const monthlyReportWhere: Prisma.CompliancePackWhereInput =
    input.scope === 'DOMAIN'
      ? { id: '__none__' }
      : {
          organizationId: org,
          scope: 'MONTHLY_REPORT',
          ...(input.scope === 'CLIENT' && input.targetId ? { clientId: input.targetId } : {}),
        };

  const [organization, clients, domains, users, members, sessions, reports, forensics, alertRules, alertEvents, shares, digests, monthlyReports, senderReviews, subdomainDismissals, dnsConnections, dnsPublications, hostedDmarcRecords, hostedSpfRecords, hostedBimiRecords, hostedMtaStsRecords, psaConnection, psaMappings, psaTicketLinks, psaJobs, tlsReports, prospectReports, domainRegistrations, policyProposals, auditLog] =
    await Promise.all([
      prisma.organization.findUnique({
        where: { id: org },
        select: { id: true, name: true, slug: true, plan: true, createdAt: true },
      }),
      prisma.client.findMany({
        where: input.scope === 'CLIENT' && input.targetId ? { id: input.targetId, organizationId: org } : { organizationId: org },
        select: { id: true, name: true, slug: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.domain.findMany({
        where: domainFilter,
        select: {
          id: true,
          clientId: true,
          name: true,
          status: true,
          verifiedAt: true,
          dmarcPolicy: true,
          dmarcRecord: true,
          collectForensicReports: true,
          retainForensicPii: true,
          score: true,
          createdAt: true,
          lastScanAt: true,
        },
        orderBy: { name: 'asc' },
        take: exportTableLimit,
      }),
      prisma.user.findMany({
        where: { members: { some: { organizationId: org } } },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          emailVerified: true,
          createdAt: true,
          accounts: { select: { providerId: true, accountId: true, createdAt: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: exportTableLimit,
      }),
      prisma.member.findMany({
        where: { organizationId: org },
        select: { id: true, userId: true, role: true, createdAt: true },
        take: exportTableLimit,
      }),
      prisma.session.findMany({
        where: { user: { members: { some: { organizationId: org } } } },
        select: {
          id: true,
          userId: true,
          createdAt: true,
          expiresAt: true,
          ipAddress: true,
          userAgent: true,
        },
        take: exportTableLimit,
      }),
      prisma.dmarcReport.findMany({
        where: { domain: domainFilter },
        select: {
          id: true,
          domainId: true,
          reportType: true,
          reportId: true,
          reportingOrganization: true,
          reportingEmail: true,
          policyDomain: true,
          policyP: true,
          policySp: true,
          policyAdkim: true,
          policyAspf: true,
          policyFraction: true,
          dateRangeBegin: true,
          dateRangeEnd: true,
          receivedAt: true,
          recordCount: true,
          records: {
            take: exportRecordLimit,
            select: {
              id: true,
              sourceIp: true,
              messageCount: true,
              disposition: true,
              dkimResult: true,
              spfResult: true,
              headerFrom: true,
              envelopeFrom: true,
              senderDomain: true,
              senderKey: true,
              policyReason: true,
              authResults: {
                take: exportRecordLimit,
                select: { id: true, type: true, domain: true, selector: true, scope: true, result: true },
              },
            },
          },
        },
        orderBy: { receivedAt: 'asc' },
        take: exportTableLimit,
      }),
      prisma.dmarcForensicReport.findMany({
        where: { domain: domainFilter },
        select: {
          id: true,
          domainId: true,
          feedbackType: true,
          reportedDomain: true,
          sourceIp: true,
          sourcePort: true,
          disposition: true,
          deliveryAction: true,
          deliveryStatus: true,
          dkimResult: true,
          spfResult: true,
          reportingMta: true,
          userAgent: true,
          originalMessageDate: true,
          arrivedAt: true,
          receivedAt: true,
          retentionExpiresAt: true,
          redactionVersion: true,
          recipientPseudonyms: true,
          recipientAddresses: true,
          subjectLine: true,
          envelopeFrom: true,
          envelopeFromPseudonym: true,
          messageIdPseudonym: true,
          subjectPseudonym: true,
        },
        orderBy: { receivedAt: 'asc' },
        take: exportTableLimit,
      }),
      prisma.alertRule.findMany({
        where: input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : { organizationId: org },
        select: {
          id: true,
          domainId: true,
          name: true,
          metric: true,
          operator: true,
          threshold: true,
          windowMinutes: true,
          cooldownMinutes: true,
          enabled: true,
          createdAt: true,
          recipients: { select: { userId: true } },
        },
        take: exportTableLimit,
      }),
      prisma.alertEvent.findMany({
        where: input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : { organizationId: org },
        select: {
          id: true,
          ruleId: true,
          domainId: true,
          metric: true,
          observedValue: true,
          threshold: true,
          summary: true,
          triggeredAt: true,
          acknowledgedAt: true,
          resolvedAt: true,
          staleAt: true,
        },
        take: exportTableLimit,
      }),
      prisma.reportShare.findMany({
        where: input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : { organizationId: org },
        select: { id: true, domainId: true, clientId: true, expiresAt: true, revokedAt: true, createdAt: true },
        take: exportTableLimit,
      }),
      prisma.reportDigest.findMany({
        where: input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : { organizationId: org },
        select: {
          id: true,
          domainId: true,
          frequency: true,
          recipientEmails: true,
          lastSentAt: true,
          createdAt: true,
        },
        take: exportTableLimit,
      }),
      prisma.compliancePack.findMany({
        where: monthlyReportWhere,
        select: {
          id: true,
          reference: true,
          periodStart: true,
          pdfHash: true,
          createdAt: true,
          supersededAt: true,
        },
        orderBy: { createdAt: 'asc' },
        take: exportTableLimit,
      }),
      prisma.senderReview.findMany({
        where: {
          organizationId: org,
          ...(input.scope === 'CLIENT' && input.targetId
            ? { domain: { clientId: input.targetId } }
            : {}),
          ...(input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : {}),
        },
        select: {
          senderKey: true,
          status: true,
          note: true,
          reviewedAt: true,
          domain: { select: { name: true } },
          ownerUser: { select: { email: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: exportTableLimit,
      }),
      prisma.subdomainDismissal.findMany({
        where: {
          organizationId: org,
          ...(input.scope === 'CLIENT' && input.targetId
            ? { domain: { clientId: input.targetId } }
            : {}),
          ...(input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : {}),
        },
        select: {
          name: true,
          createdAt: true,
          domain: { select: { name: true } },
          dismissedBy: { select: { email: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: exportTableLimit,
      }),
      prisma.dnsProviderConnection.findMany({
        where: { organizationId: org },
        select: {
          id: true,
          provider: true,
          label: true,
          tokenHint: true,
          accountName: true,
          lastVerifiedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
        take: exportTableLimit,
      }),
      prisma.dnsPublication.findMany({
        where: {
          organizationId: org,
          ...(input.scope === 'CLIENT' && input.targetId
            ? { domain: { clientId: input.targetId } }
            : {}),
          ...(input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : {}),
        },
        select: {
          provider: true,
          zoneId: true,
          recordName: true,
          kind: true,
          previousValue: true,
          newValue: true,
          publishedAt: true,
          restoredAt: true,
          domain: { select: { name: true } },
          publishedBy: { select: { email: true } },
        },
        orderBy: { publishedAt: 'asc' },
        take: exportTableLimit,
      }),
      prisma.hostedDmarcRecord.findMany({
        where: {
          organizationId: org,
          ...(input.scope === 'CLIENT' && input.targetId
            ? { domain: { clientId: input.targetId } }
            : {}),
          ...(input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : {}),
        },
        select: {
          id: true,
          token: true,
          value: true,
          version: true,
          status: true,
          providerRecordId: true,
          delegated: true,
          delegationCheckedAt: true,
          activatedAt: true,
          releaseRequestedAt: true,
          releasedAt: true,
          lastSyncedAt: true,
          lastSyncError: true,
          createdAt: true,
          updatedAt: true,
          domain: { select: { name: true } },
          changes: {
            select: {
              id: true,
              previousValue: true,
              newValue: true,
              reason: true,
              readinessOverride: true,
              actorUserId: true,
              createdAt: true,
              restoredAt: true,
            },
            orderBy: { createdAt: 'asc' },
            take: exportTableLimit,
          },
        },
        orderBy: { createdAt: 'asc' },
        take: exportTableLimit,
      }),
      prisma.hostedSpfRecord.findMany({
        where: {
          organizationId: org,
          ...(input.scope === 'CLIENT' && input.targetId
            ? { domain: { clientId: input.targetId } }
            : {}),
          ...(input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : {}),
        },
        select: {
          id: true,
          token: true,
          status: true,
          version: true,
          sources: true,
          allQualifier: true,
          sourceState: true,
          parts: true,
          lookupCount: true,
          lastFlattenedAt: true,
          lastFlattenError: true,
          capacityBlocked: true,
          delegated: true,
          delegationCheckedAt: true,
          activatedAt: true,
          releaseRequestedAt: true,
          releasedAt: true,
          createdAt: true,
          updatedAt: true,
          domain: { select: { name: true } },
          changes: {
            select: {
              id: true,
              reason: true,
              previousSources: true,
              newSources: true,
              previousParts: true,
              newParts: true,
              actorUserId: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'asc' },
            take: exportTableLimit,
          },
        },
        orderBy: { createdAt: 'asc' },
        take: exportTableLimit,
      }),
      /**
       * The rows, not the bytes.
       *
       * A logo and a certificate are the customer's assets, but an export is a
       * JSON document about what the service holds; embedding a 32KB SVG per
       * domain would bloat it and, worse, put file contents in a payload that
       * gets emailed and cached. The SHA-256 is the identity of the asset and
       * the URLs are reproducible from the token, so the hash is what travels.
       */
      prisma.hostedBimiRecord.findMany({
        where: {
          organizationId: org,
          ...(input.scope === 'CLIENT' && input.targetId
            ? { domain: { clientId: input.targetId } }
            : {}),
          ...(input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : {}),
        },
        select: {
          id: true,
          token: true,
          status: true,
          previousValue: true,
          delegated: true,
          delegationCheckedAt: true,
          activatedAt: true,
          releaseRequestedAt: true,
          releasedAt: true,
          lastSyncedAt: true,
          lastSyncError: true,
          certificateExpiresAt: true,
          certificateIssuer: true,
          certificateSubject: true,
          createdAt: true,
          updatedAt: true,
          domain: { select: { name: true } },
          assets: {
            select: { kind: true, sha256: true, contentType: true, createdAt: true, retiredAt: true },
            orderBy: { createdAt: 'asc' },
            take: exportTableLimit,
          },
          changes: {
            select: {
              id: true,
              reason: true,
              previousLogoSha: true,
              newLogoSha: true,
              previousCertSha: true,
              newCertSha: true,
              actorUserId: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'asc' },
            take: exportTableLimit,
          },
        },
        orderBy: { createdAt: 'asc' },
        take: exportTableLimit,
      }),
      prisma.hostedMtaStsRecord.findMany({
        where: {
          organizationId: org,
          ...(input.scope === 'CLIENT' && input.targetId
            ? { domain: { clientId: input.targetId } }
            : {}),
          ...(input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : {}),
        },
        select: {
          id: true,
          token: true,
          status: true,
          mode: true,
          mx: true,
          maxAge: true,
          policyId: true,
          version: true,
          customHostnameId: true,
          hostnameStatus: true,
          sslStatus: true,
          sslError: true,
          delegated: true,
          mtaCnameState: true,
          txtCnameState: true,
          delegationCheckedAt: true,
          lastSyncedAt: true,
          lastSyncError: true,
          uncoveredMx: true,
          uncoveredCheckedAt: true,
          enforcedAt: true,
          releaseRequestedAt: true,
          releaseServeUntil: true,
          releasedAt: true,
          previousTxt: true,
          previousPolicy: true,
          createdAt: true,
          updatedAt: true,
          domain: { select: { name: true } },
          changes: {
            select: {
              id: true,
              reason: true,
              previousMode: true,
              newMode: true,
              previousMx: true,
              newMx: true,
              previousMaxAge: true,
              newMaxAge: true,
              previousPolicyId: true,
              newPolicyId: true,
              readinessOverride: true,
              actorUserId: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'asc' },
            take: exportTableLimit,
          },
        },
        orderBy: { createdAt: 'asc' },
        take: exportTableLimit,
      }),
      /**
       * The PSA connection, without the credentials.
       *
       * `credentialHint` is what the UI shows and is safe; the encrypted blob is
       * not exported, because an export is emailed, downloaded and kept, and a
       * ciphertext with a known key is a credential.
       */
      prisma.psaConnection.findUnique({
        where: { organizationId: org },
        select: {
          id: true,
          provider: true,
          status: true,
          pausedReason: true,
          credentialHint: true,
          baseUrl: true,
          ticketQueueId: true,
          ticketTypeId: true,
          openStatusId: true,
          closedStatusId: true,
          priorityId: true,
          closeOnResolve: true,
          ticketOnAlert: true,
          ticketOnCriticalDns: true,
          lastSuccessAt: true,
          lastError: true,
          consecutiveFailures: true,
          version: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.psaCompanyMapping.findMany({
        where: {
          organizationId: org,
          ...(input.scope === 'CLIENT' && input.targetId ? { clientId: input.targetId } : {}),
          ...(input.scope === 'DOMAIN' && input.targetId ? { clientId: '__none__' } : {}),
        },
        select: {
          clientId: true,
          externalCompanyId: true,
          externalCompanyName: true,
          createdAt: true,
          updatedAt: true,
          client: { select: { name: true } },
        },
        take: exportTableLimit,
      }),
      prisma.psaTicketLink.findMany({
        where: {
          organizationId: org,
          ...(input.scope === 'CLIENT' && input.targetId
            ? { domain: { clientId: input.targetId } }
            : {}),
          ...(input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : {}),
        },
        select: {
          source: true,
          provider: true,
          reference: true,
          externalTicketId: true,
          externalTicketUrl: true,
          state: true,
          closedAt: true,
          createdAt: true,
          dnsChangeIds: true,
          alertEventId: true,
          domain: { select: { name: true } },
        },
        orderBy: { createdAt: 'asc' },
        take: exportTableLimit,
      }),
      prisma.psaTicketJob.findMany({
        where: {
          organizationId: org,
          createdAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
        },
        select: {
          kind: true,
          status: true,
          skipReason: true,
          attempts: true,
          lastError: true,
          linkReference: true,
          createdAt: true,
          doneAt: true,
        },
        orderBy: { createdAt: 'asc' },
        take: exportTableLimit,
      }),
      prisma.tlsReport.findMany({
        where: { domain: domainFilter },
        select: {
          id: true,
          domainId: true,
          reportId: true,
          organizationName: true,
          contactInfo: true,
          policyDomain: true,
          dateRangeBegin: true,
          dateRangeEnd: true,
          successfulSessions: true,
          failedSessions: true,
          truncated: true,
          receivedAt: true,
          policies: {
            select: {
              id: true,
              policyType: true,
              policyString: true,
              mxHost: true,
              successfulSessions: true,
              failedSessions: true,
              failures: {
                take: exportRecordLimit,
                select: {
                  id: true,
                  resultType: true,
                  sendingMtaIp: true,
                  receivingMxHostname: true,
                  receivingMxHelo: true,
                  receivingIp: true,
                  failedSessions: true,
                  additionalInformation: true,
                  failureReasonCode: true,
                },
              },
            },
          },
        },
        orderBy: { receivedAt: 'asc' },
        take: exportTableLimit,
      }),
      // Workspace-level only: a prospect is by definition not one of the
      // workspace's clients, so a client or domain export has none.
      input.scope === 'ORGANIZATION'
        ? prisma.prospectReport.findMany({
            where: { organizationId: org },
            select: {
              id: true,
              domain: true,
              prospectName: true,
              note: true,
              contactEmail: true,
              score: true,
              scannedAt: true,
              expiresAt: true,
              revokedAt: true,
              viewCount: true,
              lastViewedAt: true,
              createdAt: true,
              createdById: true,
              result: true,
            },
            orderBy: { createdAt: 'asc' },
            take: exportTableLimit,
          })
        : Promise.resolve([]),
      prisma.domainRegistration.findMany({
        where: { domain: domainFilter },
        select: {
          domainId: true,
          registrableDomain: true,
          status: true,
          expiresAt: true,
          registrar: true,
          checkedAt: true,
          lastError: true,
          warnedThreshold: true,
          warnedForExpiry: true,
        },
        orderBy: { domainId: 'asc' },
        take: exportTableLimit,
      }),
      prisma.policyProposal.findMany({
        where: { organizationId: org, domain: domainFilter },
        select: {
          id: true,
          domainId: true,
          createdById: true,
          fromPolicy: true,
          fromTesting: true,
          policy: true,
          testing: true,
          np: true,
          recordValue: true,
          applyVia: true,
          note: true,
          evidence: true,
          blockers: true,
          status: true,
          expiresAt: true,
          decidedAt: true,
          decidedById: true,
          decidedByEmail: true,
          declineReason: true,
          appliedAt: true,
          applyError: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
        take: exportTableLimit,
      }),
      prisma.auditLog.findMany({
        where: input.scope === 'DOMAIN' && input.targetId ? { domainId: input.targetId } : { organizationId: org },
        select: { id: true, action: true, targetType: true, targetId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 20_000,
      }),
    ]);

  const inventory = await buildInventory(scope, { retentionDays: 400 });

  /**
   * A truncated export says so, in the payload itself.
   *
   * Silently handing back part of somebody's data while they believe they asked
   * for all of it is worse than handing back less: a customer who needs their
   * records cannot tell from a short file whether the records are missing or
   * simply never existed. So each table that hit its ceiling is named here rather
   * than left for the customer to infer from the row count.
   */
  const limited: string[] = (
    [
      ['reports', reports],
      ['forensicReports', forensics],
      ['tlsReports', tlsReports],
      ['alertEvents', alertEvents],
      ['auditLog', auditLog],
      ['sessions', sessions],
      ['reportDigests', digests],
      ['reportShares', shares],
      ['alertRules', alertRules],
      ['domains', domains],
      ['clients', clients],
      ['members', members],
      ['users', users],
    ] as [string, unknown[]][]
  )
    .filter(([, rows]) => rows.length >= exportTableLimit)
    .map(([label]) => label);

  const meta: ExportPayload['meta'] = {
    product: 'DMARC Harbor',
    generatedAt: new Date().toISOString(),
    scope: input.scope,
    scopeLabel: input.scopeLabel,
    format: input.format,
    notice:
      'This export contains the data held for this scope. Passwords, session tokens and OAuth tokens are never included, ' +
      'because they are credentials rather than data. Neither are the Slack and Microsoft Teams webhook addresses: each one ' +
      'is the ability to post into that channel, so it is a credential in the same sense. ' +
      'Security records are included by action and time, with identifying fields withheld.',
  };

  if (limited.length > 0) {
    meta.limited = limited;
    meta.limitedNotice = `These tables hold more rows than one request can carry: ${limited.join(', ')}. Ask support for the remainder, or request a narrower scope such as a single client or domain.`;
  }

  return {
    meta,
    classification: dataClasses.map((entry) => ({
      key: entry.key,
      label: entry.label,
      personalData: entry.containsPersonalData,
      erasure: entry.erasure,
      basis: entry.retentionBasis ?? '',
    })),
    redactions: exportRedactions(inventory),
    data: {
      organization: organization ? [organization] : [],
      clients,
      domains,
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
        linkedAccounts: user.accounts,
      })),
      members,
      sessions: sessions.map((session) => ({
        id: session.id,
        userId: session.userId,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
      })),
      reports,
      forensicReports: forensics,
      alertRules,
      alertEvents,
      reportShares: shares,
      reportDigests: digests,
      monthlyReports: monthlyReports.map((row) => ({
        id: row.id,
        reference: row.reference,
        period: row.periodStart ? row.periodStart.toISOString().slice(0, 7) : null,
        sha256: row.pdfHash,
        issuedAt: row.createdAt,
        superseded: row.supersededAt !== null,
      })),
      senderReviews: senderReviews.map((row) => ({
        domainName: row.domain.name,
        senderKey: row.senderKey,
        status: row.status ?? 'UNREVIEWED',
        note: row.note,
        ownerEmail: row.ownerUser?.email ?? null,
        reviewedAt: row.reviewedAt,
      })),
      subdomainDismissals: subdomainDismissals.map((row) => ({
        domainName: row.domain.name,
        subdomain: row.name,
        dismissedByEmail: row.dismissedBy?.email ?? null,
        dismissedAt: row.createdAt,
      })),
      dnsConnections: dnsConnections.map((row) => ({
        id: row.id,
        provider: row.provider,
        label: row.label,
        tokenHint: row.tokenHint,
        accountName: row.accountName,
        lastVerifiedAt: row.lastVerifiedAt,
        createdAt: row.createdAt,
      })),
      dnsPublications: dnsPublications.map((row) => ({
        domainName: row.domain.name,
        provider: row.provider,
        zoneId: row.zoneId,
        recordName: row.recordName,
        kind: row.kind,
        previousValue: row.previousValue,
        newValue: row.newValue,
        publishedAt: row.publishedAt,
        restoredAt: row.restoredAt,
        publishedByEmail: row.publishedBy?.email ?? null,
      })),
      hostedDmarcRecords: hostedDmarcRecords.map((row) => ({
        domainName: row.domain.name,
        token: row.token,
        value: row.value,
        version: row.version,
        status: row.status,
        providerRecordId: row.providerRecordId,
        delegated: row.delegated,
        delegationCheckedAt: row.delegationCheckedAt,
        activatedAt: row.activatedAt,
        releaseRequestedAt: row.releaseRequestedAt,
        releasedAt: row.releasedAt,
        lastSyncedAt: row.lastSyncedAt,
        lastSyncError: row.lastSyncError,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        changes: row.changes,
      })),
      hostedSpfRecords: hostedSpfRecords.map((row) => ({
        domainName: row.domain.name,
        token: row.token,
        status: row.status,
        version: row.version,
        sources: row.sources,
        allQualifier: row.allQualifier,
        sourceState: row.sourceState,
        parts: row.parts,
        lookupCount: row.lookupCount,
        lastFlattenedAt: row.lastFlattenedAt,
        lastFlattenError: row.lastFlattenError,
        capacityBlocked: row.capacityBlocked,
        delegated: row.delegated,
        delegationCheckedAt: row.delegationCheckedAt,
        activatedAt: row.activatedAt,
        releaseRequestedAt: row.releaseRequestedAt,
        releasedAt: row.releasedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        changes: row.changes,
      })),
      hostedBimiRecords: hostedBimiRecords.map((row) => ({
        domainName: row.domain.name,
        token: row.token,
        status: row.status,
        previousValue: row.previousValue,
        delegated: row.delegated,
        delegationCheckedAt: row.delegationCheckedAt,
        activatedAt: row.activatedAt,
        releaseRequestedAt: row.releaseRequestedAt,
        releasedAt: row.releasedAt,
        lastSyncedAt: row.lastSyncedAt,
        lastSyncError: row.lastSyncError,
        certificateExpiresAt: row.certificateExpiresAt,
        certificateIssuer: row.certificateIssuer,
        certificateSubject: row.certificateSubject,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        // SHA-256 and content type only: the bytes are never exported.
        assets: row.assets,
        changes: row.changes,
      })),
      hostedMtaStsRecords: hostedMtaStsRecords.map((row) => ({
        domainName: row.domain.name,
        token: row.token,
        status: row.status,
        mode: row.mode,
        mx: row.mx,
        maxAge: row.maxAge,
        policyId: row.policyId,
        version: row.version,
        customHostnameId: row.customHostnameId,
        hostnameStatus: row.hostnameStatus,
        sslStatus: row.sslStatus,
        sslError: row.sslError,
        delegated: row.delegated,
        mtaCnameState: row.mtaCnameState,
        txtCnameState: row.txtCnameState,
        delegationCheckedAt: row.delegationCheckedAt,
        lastSyncedAt: row.lastSyncedAt,
        lastSyncError: row.lastSyncError,
        uncoveredMx: row.uncoveredMx,
        uncoveredCheckedAt: row.uncoveredCheckedAt,
        enforcedAt: row.enforcedAt,
        releaseRequestedAt: row.releaseRequestedAt,
        releaseServeUntil: row.releaseServeUntil,
        releasedAt: row.releasedAt,
        previousTxt: row.previousTxt,
        previousPolicy: row.previousPolicy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        changes: row.changes,
      })),
      // Every section is a list in this format, so a single connection is a
      // one-element list rather than a shape of its own.
      psaConnection: psaConnection
        ? [
            {
              provider: psaConnection.provider,
              status: psaConnection.status,
              pausedReason: psaConnection.pausedReason,
              credentialHint: psaConnection.credentialHint,
              baseUrl: psaConnection.baseUrl,
              settings: {
                ticketQueueId: psaConnection.ticketQueueId,
                ticketTypeId: psaConnection.ticketTypeId,
                openStatusId: psaConnection.openStatusId,
                closedStatusId: psaConnection.closedStatusId,
                priorityId: psaConnection.priorityId,
                closeOnResolve: psaConnection.closeOnResolve,
                ticketOnAlert: psaConnection.ticketOnAlert,
                ticketOnCriticalDns: psaConnection.ticketOnCriticalDns,
              },
              health: {
                lastSuccessAt: psaConnection.lastSuccessAt,
                lastError: psaConnection.lastError,
                consecutiveFailures: psaConnection.consecutiveFailures,
              },
              version: psaConnection.version,
              createdAt: psaConnection.createdAt,
              updatedAt: psaConnection.updatedAt,
            },
          ]
        : [],
      psaMappings: psaMappings.map((row) => ({
        clientName: row.client.name,
        externalCompanyId: row.externalCompanyId,
        externalCompanyName: row.externalCompanyName,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      psaTicketLinks: psaTicketLinks.map((row) => ({
        domainName: row.domain?.name ?? null,
        provider: row.provider,
        source: row.source,
        reference: row.reference,
        externalTicketId: row.externalTicketId,
        externalTicketUrl: row.externalTicketUrl,
        state: row.state,
        closedAt: row.closedAt,
        dnsChangeIds: row.dnsChangeIds,
        createdAt: row.createdAt,
      })),
      psaJobs: psaJobs.map((row) => ({
        kind: row.kind,
        status: row.status,
        skipReason: row.skipReason,
        attempts: row.attempts,
        lastError: row.lastError,
        reference: row.linkReference,
        createdAt: row.createdAt,
        doneAt: row.doneAt,
      })),
      tlsReports: tlsReports.map((row) => ({
        domainId: row.domainId,
        reportId: row.reportId,
        organizationName: row.organizationName,
        contactInfo: row.contactInfo,
        policyDomain: row.policyDomain,
        dateRangeBegin: row.dateRangeBegin,
        dateRangeEnd: row.dateRangeEnd,
        successfulSessions: Number(row.successfulSessions),
        failedSessions: Number(row.failedSessions),
        truncated: row.truncated,
        receivedAt: row.receivedAt,
        policies: row.policies.map((policy) => ({
          id: policy.id,
          policyType: policy.policyType,
          policyString: policy.policyString,
          mxHost: policy.mxHost,
          successfulSessions: Number(policy.successfulSessions),
          failedSessions: Number(policy.failedSessions),
          failures: policy.failures.map((failure) => ({
            ...failure,
            failedSessions: Number(failure.failedSessions),
          })),
        })),
      })),
      // The share token is a credential (it opens the public page) and is not
      // exported; everything the page showed is in `result`.
      prospectReports,
      domainRegistrations,
      policyProposals,
      auditLog,
    },
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const reportRecordColumns = [
  'report_id',
  'received_at',
  'policy_domain',
  'policy_p',
  'policy_pct',
  'source_ip',
  'sender_domain',
  'message_count',
  'disposition',
  'dkim_result',
  'spf_result',
  'header_from',
  'policy_reason',
] as const;

export function toReportRecordsCsv(payload: ExportPayload): string {
  const rows: string[] = [reportRecordColumns.join(',')];

  for (const report of payload.data.reports as { id: string; receivedAt: Date; policyDomain: string | null; policyP: string | null; policyFraction: number | null; records: Record<string, unknown>[] }[]) {
    for (const record of report.records) {
      rows.push(
        [
          csvCell(report.id),
          csvCell(report.receivedAt),
          csvCell(report.policyDomain),
          csvCell(report.policyP),
          csvCell(report.policyFraction),
          csvCell(record.sourceIp),
          csvCell(record.senderDomain),
          csvCell(record.messageCount),
          csvCell(record.disposition),
          csvCell(record.dkimResult),
          csvCell(record.spfResult),
          csvCell(record.headerFrom),
          csvCell(record.policyReason),
        ].join(','),
      );
    }
  }

  return rows.join('\n');
}

const forensicColumns = [
  'forensic_id',
  'received_at',
  'reported_domain',
  'source_ip',
  'disposition',
  'dkim_result',
  'spf_result',
  'named_recipient_data_stored',
] as const;

export function toForensicCsv(payload: ExportPayload): string {
  const rows: string[] = [forensicColumns.join(',')];

  for (const item of payload.data.forensicReports as Record<string, unknown>[]) {
    rows.push(
      [
        csvCell(item.id),
        csvCell(item.receivedAt),
        csvCell(item.reportedDomain),
        csvCell(item.sourceIp),
        csvCell(item.disposition),
        csvCell(item.dkimResult),
        csvCell(item.spfResult),
        item.recipientAddresses ? 'yes' : 'no',
      ].join(','),
    );
  }

  return rows.join('\n');
}

const tlsFailureColumns = [
  'report_id',
  'organization',
  'policy_type',
  'mx_host',
  'result_type',
  'sending_mta_ip',
  'receiving_mx_hostname',
  'receiving_mx_helo',
  'receiving_ip',
  'failed_sessions',
  'additional_information',
  'failure_reason_code',
] as const;

export function toTlsReportFailuresCsv(payload: ExportPayload): string {
  const rows: string[] = [tlsFailureColumns.join(',')];
  const reports = payload.data.tlsReports as Array<{
    reportId: string;
    organizationName: string;
    policies: Array<{
      policyType: string;
      mxHost: string | null;
      failures: Array<Record<string, unknown>>;
    }>;
  }>;
  for (const report of reports) {
    for (const policy of report.policies) {
      for (const failure of policy.failures) {
        rows.push(
          [
            csvCell(report.reportId),
            csvCell(report.organizationName),
            csvCell(policy.policyType),
            csvCell(policy.mxHost),
            csvCell(failure.resultType),
            csvCell(failure.sendingMtaIp),
            csvCell(failure.receivingMxHostname),
            csvCell(failure.receivingMxHelo),
            csvCell(failure.receivingIp),
            csvCell(failure.failedSessions),
            csvCell(failure.additionalInformation),
            csvCell(failure.failureReasonCode),
          ].join(','),
        );
      }
    }
  }
  return rows.join('\n');
}

export function csvSection(title: string, body: string): string {
  return `${title}\n${body}`;
}

export function buildCsvExport(payload: ExportPayload): string {
  return [
    `# DMARC Harbor export, ${payload.meta.scopeLabel}, generated ${payload.meta.generatedAt}`,
    '# Passwords, session tokens and OAuth tokens are never included.',
    '#',
    csvSection('report_records', toReportRecordsCsv(payload)),
    csvSection('forensic_reports', toForensicCsv(payload)),
    csvSection('tls_report_failures', toTlsReportFailuresCsv(payload)),
  ].join('\n\n');
}
