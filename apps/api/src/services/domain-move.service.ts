import { prisma } from '../database/prisma.js';
import { readDmarcRecord } from '../scanner/dmarc-tags.js';
import { recordAuditEvent } from './audit.service.js';
import { domainRef } from './domain-ref.js';
import { classifyReportAddress, clientAggregateAddress } from './report-address.service.js';

/**
 * domain-move.service.ts — moving a domain from one client to another.
 *
 * An MSP files a domain under the wrong client, or a client sells a brand to
 * another client. Before this, the only way to fix either was to delete the
 * domain, which destroys every report, scan and alert it has, and add it again.
 *
 * WHAT MOVES. Everything the domain owns is keyed on the domain, not the client:
 * aggregate and forensic reports, scans, DNS changes, alert rules and events,
 * digests, sender reviews and hosted records. Those move by changing one column.
 * Share links carry both a domain and a client (the public page names the
 * client), so their client is rewritten to the new one in the same transaction.
 *
 * WHAT CHANGES HANDS. Portal contacts see a client's domains, so the previous
 * client's contacts lose sight of this domain and the new client's contacts gain
 * it. A pending approval request was put to the previous client's contacts, and
 * letting the new client's contacts answer it would record a decision from
 * people it was never sent to, so pending requests are withdrawn by the move and
 * each withdrawal is audited. Monthly reports already issued stay with the
 * client they were issued for; the next one for each client is built from the
 * domains it holds then. Open PSA tickets stay in the previous client's PSA
 * company; new ones go to the new client's mapping.
 *
 * WHAT DOES NOT MOVE ON ITS OWN. The DMARC record in the customer's DNS names a
 * report address, and with per-client addresses that address carries the
 * previous client's token. Reports keep arriving, because routing matches the
 * policy domain inside the report, but the record stops proving that this
 * client owns the domain. The preview says so and gives the new address; it is
 * not changed here because it lives in somebody else's DNS.
 *
 * WHAT REFUSES. A provider switch that is under way planned its record around the
 * previous client's address, and moving underneath it would make the next check
 * read the cut-over as missing. The operator finishes or stops the switch first.
 */

export type MoveBlockerCode = 'SWITCH_IN_PROGRESS';

export interface MoveBlocker {
  code: MoveBlockerCode;
  message: string;
}

export interface MoveReportAddress {
  /** The previous client's rua address. */
  previous: string;
  /** The new client's rua address, the one to publish. */
  next: string;
  /** The DMARC record last read from DNS names the previous client's address. */
  recordNamesPrevious: boolean;
  /** The record is served by hosted DMARC rather than the customer's own DNS. */
  hosted: boolean;
}

export interface DomainMovePreview {
  domain: { id: string; name: string; slug: string; status: string };
  from: { id: string; name: string };
  to: { id: string; name: string };
  /** True when the domain is already under the target client: a move changes nothing. */
  alreadyThere: boolean;
  /** What travels with the domain, unchanged. */
  moves: {
    dmarcReports: number;
    forensicReports: number;
    scans: number;
    alertRules: number;
    openAlerts: number;
    reportDigests: number;
    liveShareLinks: number;
  };
  /**
   * Every address a digest for this domain is sent to. Digests keep their
   * recipients, and those people may belong to the previous client.
   */
  digestRecipients: string[];
  /** Approval requests still waiting on the previous client's contacts. Withdrawn by the move. */
  pendingProposals: number;
  portal: { losingContacts: number; gainingContacts: number };
  monthlyReports: { fromScheduled: boolean; toScheduled: boolean };
  psa: { fromCompany: string | null; toCompany: string | null; openTickets: number };
  reportAddress: MoveReportAddress;
  blockers: MoveBlocker[];
}

export interface DomainMoveResult {
  moved: boolean;
  domain: { id: string; name: string; slug: string; clientId: string };
  from: { id: string; name: string };
  to: { id: string; name: string };
  shareLinksMoved: number;
  withdrawnProposals: number;
  reportAddress: MoveReportAddress;
}

export type DomainMoveOutcome =
  | { ok: true; result: DomainMoveResult }
  | { ok: false; reason: 'domain_not_found' | 'client_not_found' | 'changed' }
  | { ok: false; reason: 'blocked'; blockers: MoveBlocker[] };

async function loadMove(organizationId: string, domainRefOrId: string, toClientId: string) {
  const domain = await prisma.domain.findFirst({
    where: { client: { organizationId }, ...domainRef(domainRefOrId) },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      dmarcRecord: true,
      clientId: true,
      client: { select: { id: true, name: true, reportToken: true } },
      switch: { select: { status: true } },
      hostedDmarc: { select: { status: true } },
    },
  });
  if (!domain) {
    return { ok: false as const, reason: 'domain_not_found' as const };
  }

  // The target is looked up inside the same workspace, so a client id from
  // another workspace answers exactly like one that never existed.
  const to = await prisma.client.findFirst({
    where: { id: toClientId, organizationId },
    select: { id: true, name: true, reportToken: true },
  });
  if (!to) {
    return { ok: false as const, reason: 'client_not_found' as const };
  }

  return { ok: true as const, domain, to };
}

type LoadedMove = Extract<Awaited<ReturnType<typeof loadMove>>, { ok: true }>;

function blockersFor(loaded: LoadedMove): MoveBlocker[] {
  const blockers: MoveBlocker[] = [];
  const switchStatus = loaded.domain.switch?.status;
  if (switchStatus === 'PLANNED' || switchStatus === 'DUAL_REPORTING') {
    blockers.push({
      code: 'SWITCH_IN_PROGRESS',
      message: `A provider switch is under way for ${loaded.domain.name}, and its planned record names ${loaded.domain.client.name}'s report address. Finish the switch or stop it on the domain page, then move the domain.`,
    });
  }
  return blockers;
}

function reportAddressFor(loaded: LoadedMove): MoveReportAddress {
  const previousToken = loaded.domain.client.reportToken;
  const recordNamesPrevious = readDmarcRecord(loaded.domain.dmarcRecord).aggregateMailtoTargets.some((target) => {
    const kind = classifyReportAddress(target);
    return kind.kind === 'client' && kind.token === previousToken;
  });
  return {
    previous: clientAggregateAddress(previousToken),
    next: clientAggregateAddress(loaded.to.reportToken),
    recordNamesPrevious,
    hosted: loaded.domain.hostedDmarc !== null && loaded.domain.hostedDmarc.status !== 'RELEASED',
  };
}

export type DomainMovePreviewOutcome =
  | { ok: true; preview: DomainMovePreview }
  | { ok: false; reason: 'domain_not_found' | 'client_not_found' };

/** What a move would do, without doing it. The confirmation is built from this. */
export async function previewDomainMove(
  organizationId: string,
  domainRefOrId: string,
  toClientId: string,
  now = new Date(),
): Promise<DomainMovePreviewOutcome> {
  const loaded = await loadMove(organizationId, domainRefOrId, toClientId);
  if (!loaded.ok) {
    return loaded;
  }

  const { domain, to } = loaded;
  const fromId = domain.clientId;

  const [
    dmarcReports,
    forensicReports,
    scans,
    alertRules,
    openAlerts,
    digests,
    liveShareLinks,
    pendingProposals,
    losingContacts,
    gainingContacts,
    fromSchedule,
    toSchedule,
    fromMapping,
    toMapping,
    openTickets,
  ] = await Promise.all([
    prisma.dmarcReport.count({ where: { domainId: domain.id } }),
    prisma.dmarcForensicReport.count({ where: { domainId: domain.id } }),
    prisma.scan.count({ where: { domainId: domain.id } }),
    prisma.alertRule.count({ where: { domainId: domain.id } }),
    prisma.alertEvent.count({ where: { domainId: domain.id, acknowledgedAt: null, resolvedAt: null } }),
    prisma.reportDigest.findMany({ where: { domainId: domain.id }, select: { recipientEmails: true } }),
    prisma.reportShare.count({ where: { domainId: domain.id, revokedAt: null, expiresAt: { gt: now } } }),
    prisma.policyProposal.count({ where: { domainId: domain.id, status: 'PENDING' } }),
    prisma.clientPortalAccess.count({ where: { organizationId, clientId: fromId, revokedAt: null } }),
    prisma.clientPortalAccess.count({ where: { organizationId, clientId: to.id, revokedAt: null } }),
    prisma.monthlyReportSchedule.findUnique({ where: { clientId: fromId }, select: { enabled: true } }),
    prisma.monthlyReportSchedule.findUnique({ where: { clientId: to.id }, select: { enabled: true } }),
    prisma.psaCompanyMapping.findUnique({ where: { clientId: fromId }, select: { externalCompanyName: true } }),
    prisma.psaCompanyMapping.findUnique({ where: { clientId: to.id }, select: { externalCompanyName: true } }),
    prisma.psaTicketLink.count({ where: { domainId: domain.id, state: 'OPEN' } }),
  ]);

  const recipients = [...new Set(digests.flatMap((digest) => digest.recipientEmails.map((email) => email.toLowerCase())))].sort();

  return {
    ok: true,
    preview: {
      domain: { id: domain.id, name: domain.name, slug: domain.slug, status: domain.status },
      from: { id: domain.client.id, name: domain.client.name },
      to: { id: to.id, name: to.name },
      alreadyThere: fromId === to.id,
      moves: {
        dmarcReports,
        forensicReports,
        scans,
        alertRules,
        openAlerts,
        reportDigests: digests.length,
        liveShareLinks,
      },
      digestRecipients: recipients,
      pendingProposals,
      portal: { losingContacts, gainingContacts },
      monthlyReports: { fromScheduled: fromSchedule?.enabled ?? false, toScheduled: toSchedule?.enabled ?? false },
      psa: {
        fromCompany: fromMapping?.externalCompanyName ?? null,
        toCompany: toMapping?.externalCompanyName ?? null,
        openTickets,
      },
      reportAddress: reportAddressFor(loaded),
      blockers: fromId === to.id ? [] : blockersFor(loaded),
    },
  };
}

/**
 * Moves the domain. One transaction: the domain's client, its share links'
 * client, the withdrawal of pending approval requests and the audit rows all
 * land together or not at all.
 *
 * Moving a domain to the client it is already under succeeds and changes
 * nothing, so a script that says "this domain belongs to that client" can run
 * every night without writing an audit row each time.
 */
export async function moveDomain(input: {
  organizationId: string;
  domainId: string;
  toClientId: string;
  actorUserId?: string | null;
  apiKeyId?: string | null;
  requestId?: string;
}): Promise<DomainMoveOutcome> {
  const loaded = await loadMove(input.organizationId, input.domainId, input.toClientId);
  if (!loaded.ok) {
    return loaded;
  }

  const { domain, to } = loaded;
  const from = { id: domain.client.id, name: domain.client.name };
  const reportAddress = reportAddressFor(loaded);
  const base = {
    domain: { id: domain.id, name: domain.name, slug: domain.slug, clientId: to.id },
    from,
    to: { id: to.id, name: to.name },
    reportAddress,
  };

  if (domain.clientId === to.id) {
    return { ok: true, result: { ...base, moved: false, shareLinksMoved: 0, withdrawnProposals: 0 } };
  }

  const blockers = blockersFor(loaded);
  if (blockers.length > 0) {
    return { ok: false, reason: 'blocked', blockers };
  }

  const outcome = await prisma.$transaction(async (tx) => {
    // Conditional on the client it was read under, so two moves sent at once
    // cannot both apply and leave the audit trail describing the wrong origin.
    const updated = await tx.domain.updateMany({
      where: { id: domain.id, clientId: domain.clientId },
      data: { clientId: to.id },
    });
    if (updated.count === 0) {
      return null;
    }

    const shares = await tx.reportShare.updateMany({
      where: { domainId: domain.id },
      data: { clientId: to.id },
    });

    const pending = await tx.policyProposal.findMany({
      where: { domainId: domain.id, status: 'PENDING' },
      select: { id: true },
    });
    if (pending.length > 0) {
      await tx.policyProposal.updateMany({
        where: { id: { in: pending.map((row) => row.id) }, status: 'PENDING' },
        data: { status: 'WITHDRAWN' },
      });
    }

    // The transaction client is passed in: the default client would open a
    // second connection and wait on the row this transaction has just locked.
    await recordAuditEvent(
      {
        organizationId: input.organizationId,
        domainId: domain.id,
        actorUserId: input.actorUserId ?? undefined,
        action: 'DOMAIN_MOVED',
        targetType: 'domain',
        targetId: domain.id,
        detail: {
          name: domain.name,
          fromClientId: from.id,
          fromClientName: from.name,
          toClientId: to.id,
          toClientName: to.name,
          shareLinksMoved: shares.count,
          withdrawnProposals: pending.length,
          recordNamesPreviousAddress: reportAddress.recordNamesPrevious,
          ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
        },
        requestId: input.requestId,
      },
      tx,
    );
    for (const proposal of pending) {
      await recordAuditEvent(
        {
          organizationId: input.organizationId,
          domainId: domain.id,
          actorUserId: input.actorUserId ?? undefined,
          action: 'POLICY_PROPOSAL_WITHDRAWN',
          targetType: 'policy_proposal',
          targetId: proposal.id,
          detail: { reason: 'domain_moved', fromClientName: from.name, toClientName: to.name },
          requestId: input.requestId,
        },
        tx,
      );
    }

    return { shareLinksMoved: shares.count, withdrawnProposals: pending.length };
  });

  if (!outcome) {
    return { ok: false, reason: 'changed' };
  }

  return { ok: true, result: { ...base, moved: true, ...outcome } };
}
