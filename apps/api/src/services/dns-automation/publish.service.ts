import type { DnsRecordKind } from '@prisma/client';
import { prisma } from '../../database/prisma.js';
import { recordAuditEvent } from '../audit.service.js';
import { verifyDomain } from '../client.service.js';
import { runDomainScan } from '../domain-scan.service.js';
import { buildDmarcRecord, getOnboardingState } from '../onboarding.service.js';
import { getSwitch } from '../switch-kit/switch.service.js';
import {
  createCloudflareClient,
  DnsAutomationError,
  type CloudflareClient,
  type CloudflareTxtRecord,
  type CloudflareZone,
} from './cloudflare.client.js';
import { loadDnsConnectionSecret, markDnsConnectionError, markDnsConnectionSuccess } from './connections.service.js';
import {
  addReportAddress,
  chooseDnsAction,
  currentValues,
  rewriteDmarcPolicy,
  fingerprintValues,
  matchingRecords,
  normaliseTxtValue,
  type PreviewAction,
  type PublishRecordInput,
  type PublishableKind,
} from './records.js';

export const restoreWindowDays = 7;

export class DnsPublishError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DnsPublishError';
  }
}

export interface DnsPreviewView {
  connection: { id: string; label: string | null };
  zone: { id: string; name: string };
  recordName: string;
  currentValues: string[];
  proposedValue: string;
  action: PreviewAction;
  reason: string | null;
  currentFingerprint: string;
  kind: PublishableKind;
}

export interface DnsPublicationView {
  id: string;
  provider: 'CLOUDFLARE';
  zoneId: string;
  recordName: string;
  kind: PublishableKind;
  previousValue: string | null;
  newValue: string;
  publishedAt: string;
  restoredAt: string | null;
}

interface PreparedRecord {
  kind: PublishableKind;
  recordName: string;
  /** The value written when no record of this kind exists yet. */
  value: string;
  /**
   * The value written over an existing record of this kind. DMARC kinds merge
   * into what is published instead of replacing it, so a click can never drop
   * tags or relax a policy nobody asked to change.
   */
  merge?: (existing: string) => string;
}

interface InternalPreview extends DnsPreviewView {
  matching: CloudflareTxtRecord | null;
  accountName: string | null;
}

const kindToPrisma: Record<PublishableKind, DnsRecordKind> = {
  verification: 'VERIFICATION',
  dmarc_suggested: 'DMARC_SUGGESTED',
  dmarc_policy: 'DMARC_POLICY',
  switch_dual: 'SWITCH_DUAL',
  switch_cutover: 'SWITCH_CUTOVER',
};

const prismaToKind: Record<DnsRecordKind, PublishableKind> = {
  VERIFICATION: 'verification',
  DMARC_SUGGESTED: 'dmarc_suggested',
  DMARC_POLICY: 'dmarc_policy',
  SWITCH_DUAL: 'switch_dual',
  SWITCH_CUTOVER: 'switch_cutover',
};

function isConnectionFailure(error: DnsAutomationError): boolean {
  return (
    error.code === 'TOKEN_INVALID' ||
    error.code === 'MISSING_PERMISSION' ||
    error.code === 'PROVIDER_UNAVAILABLE'
  );
}

function publicationView(row: {
  id: string;
  provider: 'CLOUDFLARE';
  zoneId: string;
  recordName: string;
  kind: DnsRecordKind;
  previousValue: string | null;
  newValue: string;
  publishedAt: Date;
  restoredAt: Date | null;
}): DnsPublicationView {
  return {
    id: row.id,
    provider: row.provider,
    zoneId: row.zoneId,
    recordName: row.recordName,
    kind: prismaToKind[row.kind],
    previousValue: row.previousValue,
    newValue: row.newValue,
    publishedAt: row.publishedAt.toISOString(),
    restoredAt: row.restoredAt?.toISOString() ?? null,
  };
}

async function prepareRecord(input: {
  organizationId: string;
  domain: { id: string; name: string; verificationToken: string };
  record: PublishRecordInput;
}): Promise<PreparedRecord> {
  if (input.record.kind === 'verification') {
    return {
      kind: 'verification',
      recordName: `_dmarc-harbor-verification.${input.domain.name}`,
      value: `dmarc-harbor-verification=${input.domain.verificationToken}`,
    };
  }

  if (input.record.kind === 'dmarc_suggested') {
    const onboarding = await getOnboardingState(input.organizationId, input.domain.id);
    if (!onboarding) {
      throw new DnsPublishError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
    }
    const ourAddress = onboarding.suggestedRecord.aggregateAddress;
    return {
      kind: 'dmarc_suggested',
      recordName: onboarding.suggestedRecord.host,
      value: onboarding.suggestedRecord.value,
      merge: (existing) => addReportAddress(existing, ourAddress),
    };
  }

  if (input.record.kind === 'dmarc_policy') {
    if (!input.record.policy) {
      throw new DnsPublishError('Choose the DMARC policy to publish.', 'INVALID_REQUEST', 400);
    }
    const onboarding = await getOnboardingState(input.organizationId, input.domain.id);
    if (!onboarding) {
      throw new DnsPublishError('That domain is not in this workspace.', 'DOMAIN_NOT_FOUND', 404);
    }
    const ourAddress = onboarding.suggestedRecord.aggregateAddress;
    const change = {
      policy: input.record.policy,
      testing: input.record.testing === true,
      np: input.record.np ?? null,
    };
    const draft = buildDmarcRecord(input.domain.name, change.policy, !onboarding.reporting.forensicConfigured, {
      testing: change.testing,
      nonExistentSubdomains: change.np,
      aggregateAddress: ourAddress,
    });
    return {
      kind: 'dmarc_policy',
      recordName: draft.host,
      value: draft.value,
      merge: (existing) => rewriteDmarcPolicy(existing, ourAddress, change),
    };
  }

  const view = await getSwitch(input.organizationId, input.domain.id);
  if (!view || !('records' in view) || !view.records) {
    throw new DnsPublishError(
      'There is no switch record for this domain yet. Start the switch first.',
      'SWITCH_NOT_FOUND',
      409,
    );
  }

  const record = input.record.kind === 'switch_dual' ? view.records.dual : view.records.cutover;
  return { kind: input.record.kind, recordName: record.host, value: record.value };
}

async function readPreview(input: {
  client: CloudflareClient;
  connection: { id: string; label: string | null };
  domainName: string;
  prepared: PreparedRecord;
}): Promise<InternalPreview> {
  const zone: CloudflareZone = await input.client.findZone(input.domainName);
  const [records, cname] = await Promise.all([
    input.client.listTxtRecords(zone.id, input.prepared.recordName),
    input.client.findCname(zone.id, input.prepared.recordName),
  ]);
  const values = currentValues(records);
  const existing = matchingRecords(input.prepared.kind, records);
  const proposedValue =
    existing.length === 1 && input.prepared.merge
      ? input.prepared.merge(existing[0]!.content)
      : input.prepared.value;
  const choice = chooseDnsAction({
    kind: input.prepared.kind,
    records,
    cname,
    proposedValue,
  });

  return {
    connection: { id: input.connection.id, label: input.connection.label },
    zone: { id: zone.id, name: zone.name },
    recordName: input.prepared.recordName,
    currentValues: values,
    proposedValue,
    action: choice.action,
    reason: choice.reason,
    currentFingerprint: fingerprintValues(values),
    kind: input.prepared.kind,
    matching: choice.matching,
    accountName: zone.accountName,
  };
}

export function publicPreview(preview: InternalPreview): DnsPreviewView {
  const view: Partial<InternalPreview> = { ...preview };
  delete view.matching;
  delete view.accountName;
  return view as DnsPreviewView;
}

async function defaultRefresh(input: {
  organizationId: string;
  domainId: string;
  kind: PublishableKind;
  actorUserId: string | null;
}): Promise<void> {
  if (input.kind === 'verification') {
    await verifyDomain(input.organizationId, input.domainId);
    return;
  }
  await runDomainScan({
    organizationId: input.organizationId,
    domainId: input.domainId,
    requestedById: input.actorUserId,
    trigger: 'MANUAL',
  });
}

type RefreshInput = {
  organizationId: string;
  domainId: string;
  kind: PublishableKind;
  actorUserId: string | null;
};

let refreshImplementation: (input: RefreshInput) => Promise<void> = defaultRefresh;

/**
 * Test seam for the post-publish verification/scan.
 *
 * The publish itself must not depend on DNS being reachable. Tests replace this
 * with a recorder so they can prove it is called, and that throwing from it
 * leaves the successful publish untouched.
 */
export function setDnsPublishRefreshForTests(
  impl: ((input: RefreshInput) => Promise<void>) | null,
): void {
  refreshImplementation = impl ?? defaultRefresh;
}

async function bestEffortRefresh(input: RefreshInput): Promise<void> {
  try {
    await refreshImplementation(input);
  } catch (error) {
    console.warn(
      `[dns-automation] post-publish refresh failed for ${input.domainId}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

export async function previewDnsPublication(input: {
  organizationId: string;
  domain: { id: string; name: string; verificationToken: string };
  connectionId: string;
  record: PublishRecordInput;
  client?: CloudflareClient;
}): Promise<DnsPreviewView> {
  const secret = await loadDnsConnectionSecret({
    organizationId: input.organizationId,
    connectionId: input.connectionId,
  });
  const prepared = await prepareRecord(input);
  const client = input.client ?? createCloudflareClient({ token: secret.token });

  try {
    const preview = await readPreview({
      client,
      connection: { id: secret.id, label: secret.label },
      domainName: input.domain.name,
      prepared,
    });
    await markDnsConnectionSuccess({ connectionId: secret.id, accountName: preview.accountName });
    return publicPreview(preview);
  } catch (error) {
    if (error instanceof DnsAutomationError && isConnectionFailure(error)) {
      await markDnsConnectionError(secret.id, error.message);
    }
    throw error;
  }
}

export async function publishDnsRecord(input: {
  organizationId: string;
  domain: { id: string; name: string; verificationToken: string };
  connectionId: string;
  record: PublishRecordInput;
  expectedFingerprint: string;
  actorUserId?: string | null;
  client?: CloudflareClient;
}): Promise<{
  action: PreviewAction;
  message: string;
  preview: DnsPreviewView;
  publication: DnsPublicationView | null;
}> {
  const secret = await loadDnsConnectionSecret({
    organizationId: input.organizationId,
    connectionId: input.connectionId,
  });
  const prepared = await prepareRecord(input);
  const client = input.client ?? createCloudflareClient({ token: secret.token });

  let preview: InternalPreview;
  try {
    preview = await readPreview({
      client,
      connection: { id: secret.id, label: secret.label },
      domainName: input.domain.name,
      prepared,
    });
  } catch (error) {
    if (error instanceof DnsAutomationError && isConnectionFailure(error)) {
      await markDnsConnectionError(secret.id, error.message);
    }
    throw error;
  }

  if (preview.currentFingerprint !== input.expectedFingerprint) {
    throw new DnsPublishError(
      'The record changed in Cloudflare after this preview. Check the new values and publish again.',
      'DNS_CHANGED',
      409,
      { preview: publicPreview(preview) },
    );
  }

  if (preview.action === 'refused') {
    throw new DnsPublishError(preview.reason ?? 'That record cannot be published.', 'RECORD_REFUSED', 400, {
      preview: publicPreview(preview),
    });
  }

  if (preview.action === 'unchanged') {
    return {
      action: 'unchanged',
      message: 'That value is already published. DNS can take a few minutes to show it everywhere.',
      preview: publicPreview(preview),
      publication: null,
    };
  }

  let providerRecordId: string;
  let previousValue: string | null = null;

  try {
    if (preview.action === 'update') {
      const existing = preview.matching;
      if (!existing) {
        throw new DnsPublishError('The record to update could not be identified.', 'RECORD_CHANGED', 409);
      }
      const updated = await client.updateTxtRecord(preview.zone.id, existing, preview.proposedValue);
      providerRecordId = updated.id;
      previousValue = normaliseTxtValue(existing.content);
    } else {
      const created = await client.createTxtRecord(preview.zone.id, prepared.recordName, preview.proposedValue);
      providerRecordId = created.id;
    }
  } catch (error) {
    if (error instanceof DnsAutomationError && isConnectionFailure(error)) {
      await markDnsConnectionError(secret.id, error.message);
    }
    throw error;
  }

  const publication = await prisma.dnsPublication.create({
    data: {
      organizationId: input.organizationId,
      domainId: input.domain.id,
      connectionId: secret.id,
      provider: 'CLOUDFLARE',
      zoneId: preview.zone.id,
      recordName: preview.recordName,
      providerRecordId,
      kind: kindToPrisma[prepared.kind],
      previousValue,
      newValue: preview.proposedValue,
      publishedById: input.actorUserId ?? null,
    },
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    domainId: input.domain.id,
    actorUserId: input.actorUserId ?? undefined,
    action: 'DNS_RECORD_PUBLISHED',
    targetType: 'dns_publication',
    targetId: publication.id,
    detail: {
      domainId: input.domain.id,
      recordName: preview.recordName,
      kind: prepared.kind,
      action: preview.action,
    },
  });

  await markDnsConnectionSuccess({
    connectionId: secret.id,
    accountName: preview.accountName,
  });

  await bestEffortRefresh({
    organizationId: input.organizationId,
    domainId: input.domain.id,
    kind: prepared.kind,
    actorUserId: input.actorUserId ?? null,
  });

  return {
    action: preview.action,
    message: 'Published. DNS can take a few minutes to show the new value everywhere.',
    preview: publicPreview(preview),
    publication: publicationView(publication),
  };
}

export async function restoreDnsPublication(input: {
  organizationId: string;
  publicationId: string;
  actorUserId?: string | null;
  now?: Date;
  client?: CloudflareClient;
}): Promise<{ message: string; publication: DnsPublicationView }> {
  const now = input.now ?? new Date();
  const publication = await prisma.dnsPublication.findFirst({
    where: { id: input.publicationId, organizationId: input.organizationId },
    include: { domain: { select: { id: true, name: true } } },
  });

  if (!publication) {
    throw new DnsPublishError('That publication is not in this workspace.', 'PUBLICATION_NOT_FOUND', 404);
  }
  if (publication.restoredAt) {
    throw new DnsPublishError('That record has already been restored once.', 'PUBLICATION_ALREADY_RESTORED', 409);
  }
  if (now.getTime() - publication.publishedAt.getTime() > restoreWindowDays * 24 * 60 * 60 * 1000) {
    throw new DnsPublishError(
      `That publication is more than ${restoreWindowDays} days old, so it can no longer be restored here.`,
      'RESTORE_EXPIRED',
      409,
    );
  }
  if (!publication.connectionId) {
    throw new DnsPublishError(
      'The Cloudflare connection used for that publication has been removed. The record has to be restored in Cloudflare.',
      'CONNECTION_REMOVED',
      409,
    );
  }

  const secret = await loadDnsConnectionSecret({
    organizationId: input.organizationId,
    connectionId: publication.connectionId,
  });
  const client = input.client ?? createCloudflareClient({ token: secret.token });
  const kind = prismaToKind[publication.kind];

  let records: CloudflareTxtRecord[];
  try {
    records = await client.listTxtRecords(publication.zoneId, publication.recordName);
  } catch (error) {
    if (error instanceof DnsAutomationError && isConnectionFailure(error)) {
      await markDnsConnectionError(secret.id, error.message);
    }
    throw error;
  }

  const matches = matchingRecords(kind, records);
  const current = matches[0];
  if (
    matches.length !== 1 ||
    !current ||
    normaliseTxtValue(current.content) !== normaliseTxtValue(publication.newValue)
  ) {
    throw new DnsPublishError(
      'The record in Cloudflare no longer has the value this publication wrote. Nothing was changed; restore it in Cloudflare if needed.',
      'RECORD_CHANGED',
      409,
    );
  }

  const claimed = await prisma.dnsPublication.updateMany({
    where: { id: publication.id, organizationId: input.organizationId, restoredAt: null },
    data: { restoredAt: now },
  });
  if (claimed.count !== 1) {
    throw new DnsPublishError('That record has already been restored once.', 'PUBLICATION_ALREADY_RESTORED', 409);
  }

  try {
    if (publication.previousValue === null) {
      await client.deleteTxtRecord(publication.zoneId, current.id);
    } else {
      await client.updateTxtRecord(publication.zoneId, current, publication.previousValue);
    }
  } catch (error) {
    await prisma.dnsPublication
      .updateMany({ where: { id: publication.id, restoredAt: now }, data: { restoredAt: null } })
      .catch(() => undefined);
    if (error instanceof DnsAutomationError && isConnectionFailure(error)) {
      await markDnsConnectionError(secret.id, error.message);
    }
    throw error;
  }

  await recordAuditEvent({
    organizationId: input.organizationId,
    domainId: publication.domainId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'DNS_RECORD_RESTORED',
    targetType: 'dns_publication',
    targetId: publication.id,
    detail: {
      domainId: publication.domainId,
      recordName: publication.recordName,
      kind,
    },
  });

  await markDnsConnectionSuccess({ connectionId: secret.id, accountName: null });

  await bestEffortRefresh({
    organizationId: input.organizationId,
    domainId: publication.domainId,
    kind,
    actorUserId: input.actorUserId ?? null,
  });

  return {
    message:
      publication.previousValue === null
        ? 'Record removed. DNS can take a few minutes to show the change everywhere.'
        : 'Previous value restored. DNS can take a few minutes to show it everywhere.',
    publication: publicationView({ ...publication, restoredAt: now }),
  };
}
