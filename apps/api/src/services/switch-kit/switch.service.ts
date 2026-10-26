import type { Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma.js';
import { systemDnsReader } from '../../scanner/dns.js';
import { readDmarcRecord } from '../../scanner/dmarc-tags.js';
import { recordAuditEvent } from '../audit.service.js';
import { bulkImportDomains, normaliseDomain, type BulkFailure } from '../bulk-onboarding.service.js';
import { verifyDomain } from '../client.service.js';
import { domainRef } from '../domain-ref.js';
import { clientAggregateAddress, isOurAddress } from '../report-address.service.js';
import { buildSwitchOverlap, cutoverReadiness, overlapNote, type SwitchOverlap } from './overlap.js';
import { planDomainSwitch, type SwitchPlan } from './plan.js';
import { buildCutoverRecord } from './record-rewrite.js';
import {
  nextSwitchState,
  switchIssueMessages,
  type SwitchIssueCode,
  type SwitchRecordObservation,
  type SwitchStatus,
} from './state.js';

export const switchKitLimits = {
  maxDomains: 100,
  dnsConcurrency: 10,
  deadlineMs: 25_000,
} as const;

const CHECK_THROTTLE_MS = 30_000;

export class SwitchKitError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SwitchKitError';
  }
}

const ISSUE_CODES = new Set<SwitchIssueCode>(Object.keys(switchIssueMessages) as SwitchIssueCode[]);

export interface SwitchIssue {
  code: SwitchIssueCode;
  message: string;
}

export interface SwitchKitResultRow {
  index: number;
  name: string;
  domainId: string;
  slug: string;
  created: boolean;
  verification: { host: string; value: string } | null;
  plan: SwitchPlan;
  switchStatus: SwitchStatus | null;
}

export interface SwitchKitImportResult {
  results: SwitchKitResultRow[];
  failed: BulkFailure[];
  planBlocked: BulkFailure[];
  limits: typeof switchKitLimits;
  ownershipNote: string | null;
}

function jsonStringArray(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function issueObjects(value: Prisma.JsonValue | null | undefined): SwitchIssue[] {
  const codes = jsonStringArray(value).filter((code): code is SwitchIssueCode => ISSUE_CODES.has(code as SwitchIssueCode));
  return codes.map((code) => ({ code, message: switchIssueMessages[code] }));
}

function planIssueCodes(plan: SwitchPlan): SwitchIssueCode[] {
  return plan.warnings
    .map((warning) => warning.code)
    .filter((code): code is SwitchIssueCode => ISSUE_CODES.has(code as SwitchIssueCode));
}

function timedOutPlan(domainName: string): SwitchPlan {
  return {
    domain: domainName,
    host: `_dmarc.${domainName}`,
    lookup: 'lookup_failed',
    record: null,
    currentRecord: null,
    cname: null,
    hostedByUs: false,
    alreadyReportingToUs: false,
    incumbents: [],
    incumbentAggregateTargets: [],
    incumbentForensicTargets: [],
    primaryIncumbent: null,
    externalAuthorization: 'error',
    warnings: [],
    message: 'Not checked yet; check again',
  };
}

const TIMEOUT = Symbol('timeout');

/**
 * Bounded work with one shared deadline.
 *
 * A hundred domains at ten at a time is fine on its own; what this stops is a
 * slow resolver turning one import request into a minute of open connections.
 * Work not started by the deadline is reported as not checked, which is a
 * truthful answer rather than a failure.
 */
async function mapWithDeadline<T, R>(
  items: readonly T[],
  limit: number,
  deadlineMs: number,
  work: (item: T) => Promise<R>,
  onTimeout: (item: T) => R,
  onError: (item: T) => R,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const deadline = Date.now() + deadlineMs;
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }

      const item = items[index]!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        results[index] = onTimeout(item);
        continue;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raced = await Promise.race([
          work(item).then((value) => ({ value })),
          new Promise<typeof TIMEOUT>((resolve) => {
            timer = setTimeout(() => resolve(TIMEOUT), remaining);
          }),
        ]);
        results[index] = raced === TIMEOUT ? onTimeout(item) : raced.value;
      } catch {
        results[index] = onError(item);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function findDomainWithSwitch(organizationId: string, domainIdOrSlug: string) {
  return prisma.domain.findFirst({
    where: { client: { organizationId }, ...domainRef(domainIdOrSlug) },
    include: {
      client: { select: { reportToken: true } },
      switch: true,
    },
  });
}

type DomainWithSwitch = NonNullable<Awaited<ReturnType<typeof findDomainWithSwitch>>>;

function serializeSwitch(row: NonNullable<DomainWithSwitch['switch']>) {
  return {
    status: row.status as SwitchStatus,
    incumbent: {
      vendor: row.incumbentVendor,
      label: row.incumbentLabel,
      aggregateTargets: jsonStringArray(row.incumbentAggregateTargets),
      forensicTargets: jsonStringArray(row.incumbentForensicTargets),
    },
    startedAt: row.startedAt,
    cutOverAt: row.cutOverAt,
    lastCheckedAt: row.lastCheckedAt,
    externalAuthorization: row.externalAuthorization,
    issues: issueObjects(row.issues),
  };
}

async function loadOverlap(
  domainId: string,
  row: NonNullable<DomainWithSwitch['switch']>,
  now: Date,
): Promise<SwitchOverlap> {
  if (!row.startedAt) {
    return buildSwitchOverlap([], { startedAt: null, now });
  }

  const reports = await prisma.dmarcReport.findMany({
    where: {
      domainId,
      reportType: 'AGGREGATE',
      dateRangeBegin: { gte: new Date(row.startedAt.getTime() - 86_400_000) },
    },
    select: {
      reportingOrganization: true,
      reportingEmail: true,
      dateRangeBegin: true,
      receivedAt: true,
      records: { select: { messageCount: true } },
    },
    take: 5_000,
  });

  return buildSwitchOverlap(
    reports.map((report) => ({
      reportingOrganization: report.reportingOrganization,
      reportingEmail: report.reportingEmail,
      dateRangeBegin: report.dateRangeBegin,
      receivedAt: report.receivedAt,
      messages: report.records.reduce((total, record) => total + record.messageCount, 0),
    })),
    { startedAt: row.startedAt, now },
  );
}

function cutoverRecordFor(domain: DomainWithSwitch, row: NonNullable<DomainWithSwitch['switch']>) {
  const record = row.lastSeenRecord ?? row.plannedRecord;
  const incumbentUris = [
    ...jsonStringArray(row.incumbentAggregateTargets),
    ...jsonStringArray(row.incumbentForensicTargets),
  ];
  const cutover = buildCutoverRecord(record, incumbentUris, clientAggregateAddress(domain.client.reportToken));
  return {
    host: `_dmarc.${domain.name}`,
    type: 'TXT' as const,
    value: cutover.value,
    warnings: cutover.warnings,
  };
}

async function detailFor(domain: DomainWithSwitch, now = new Date()) {
  const row = domain.switch!;
  const overlap = await loadOverlap(domain.id, row, now);

  return {
    switch: serializeSwitch(row),
    records: {
      dual: {
        host: `_dmarc.${domain.name}`,
        type: 'TXT' as const,
        value: row.plannedRecord,
      },
      cutover: cutoverRecordFor(domain, row),
    },
    overlap,
    readiness: cutoverReadiness(row.status, overlap),
    note: overlapNote,
  };
}

function eligibility(domain: Pick<DomainWithSwitch, 'dmarcRecord'>): boolean {
  const tags = readDmarcRecord(domain.dmarcRecord);
  return (
    tags.aggregateMailtoTargets.some((target) => !isOurAddress(target)) ||
    tags.aggregateWebTargets.length > 0
  );
}

export async function getSwitch(organizationId: string, domainIdOrSlug: string) {
  const domain = await findDomainWithSwitch(organizationId, domainIdOrSlug);
  if (!domain) {
    return null;
  }

  if (!domain.switch) {
    return { switch: null, eligible: eligibility(domain) };
  }

  return detailFor(domain);
}

async function upsertPlannedSwitch(input: {
  organizationId: string;
  domainId: string;
  plan: SwitchPlan;
  actorUserId?: string;
}): Promise<SwitchStatus> {
  const existing = await prisma.domainSwitch.findUnique({
    where: { domainId: input.domainId },
    select: { id: true, status: true },
  });

  const data = {
    incumbentVendor: input.plan.primaryIncumbent?.vendor ?? 'other',
    incumbentLabel: input.plan.primaryIncumbent?.label ?? 'other',
    incumbentAggregateTargets: input.plan.incumbentAggregateTargets as Prisma.InputJsonValue,
    incumbentForensicTargets: input.plan.incumbentForensicTargets as Prisma.InputJsonValue,
    originalRecord: input.plan.currentRecord ?? '',
    plannedRecord: input.plan.record?.value ?? '',
    externalAuthorization: input.plan.externalAuthorization,
    issues: planIssueCodes(input.plan) as unknown as Prisma.InputJsonValue,
  };

  if (!existing) {
    try {
      await prisma.domainSwitch.create({
        data: {
          ...data,
          organizationId: input.organizationId,
          domainId: input.domainId,
          status: 'PLANNED',
          createdById: input.actorUserId ?? null,
        },
      });
      return 'PLANNED';
    } catch (error) {
      // Two imports naming the same domain at once: the other one created the
      // row. Fall through and treat it as existing rather than answering 500.
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
  }

  // Conditional on PLANNED, so a plan read before a concurrent check moved the
  // row on cannot overwrite a switch that is already dual reporting.
  await prisma.domainSwitch.updateMany({ where: { domainId: input.domainId, status: 'PLANNED' }, data });
  const current = await prisma.domainSwitch.findUnique({ where: { domainId: input.domainId }, select: { status: true } });
  return (current?.status ?? 'PLANNED') as SwitchStatus;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

/**
 * Writes a new state only if the row is still in the state it was read in.
 *
 * A check and a scan can read the same PLANNED row at once. Without the
 * condition both would write DUAL_REPORTING and both would audit the start, so
 * the audit trail would record one transition twice. The loser's write is
 * dropped, and it reports no transition.
 */
async function writeSwitchState(input: {
  rowId: string;
  readStatus: SwitchStatus;
  data: Prisma.DomainSwitchUpdateManyMutationInput;
}): Promise<boolean> {
  const written = await prisma.domainSwitch.updateMany({
    where: { id: input.rowId, status: input.readStatus },
    data: input.data,
  });
  return written.count === 1;
}

export async function importSwitchKit(input: {
  organizationId: string;
  actorUserId?: string | null;
  clientId: string;
  domains: string[];
}): Promise<SwitchKitImportResult> {
  const client = await prisma.client.findFirst({
    where: { id: input.clientId, organizationId: input.organizationId },
    select: { id: true, reportToken: true },
  });

  if (!client) {
    throw new SwitchKitError(404, 'NOT_FOUND', 'Client not found in this workspace.');
  }

  if (input.domains.length > switchKitLimits.maxDomains) {
    throw new SwitchKitError(
      400,
      'VALIDATION_ERROR',
      `A switch import accepts up to ${switchKitLimits.maxDomains} domains.`,
      { limit: switchKitLimits.maxDomains, requested: input.domains.length },
    );
  }

  const ourAddress = clientAggregateAddress(client.reportToken);
  const normalised = input.domains.map((domain) => normaliseDomain(domain));

  const existingRows =
    normalised.filter((name): name is string => name !== null).length > 0
      ? await prisma.domain.findMany({
          where: {
            clientId: client.id,
            name: { in: normalised.filter((name): name is string => name !== null) },
          },
          select: { id: true, name: true, slug: true, verificationToken: true },
        })
      : [];
  const existingByName = new Map(existingRows.map((row) => [row.name, row]));

  const existingOccurrences: Array<{ index: number; row: (typeof existingRows)[number] }> = [];
  const pendingIndexes: number[] = [];
  const pendingNames: string[] = [];

  for (const [index, name] of normalised.entries()) {
    if (name && existingByName.has(name)) {
      existingOccurrences.push({ index, row: existingByName.get(name)! });
    } else {
      pendingIndexes.push(index);
      // The raw value for invalid rows, so bulkImportDomains reports the thing
      // the caller actually pasted.
      pendingNames.push(name ?? input.domains[index]!.trim());
    }
  }

  const bulk =
    pendingNames.length > 0
      ? await bulkImportDomains({
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          clientId: client.id,
          domains: pendingNames,
        })
      : { created: [], failed: [], planBlocked: [] };

  const createdRows = bulk.created.map((row) => ({
    index: pendingIndexes[row.index]!,
    row: {
      id: row.domainId,
      name: row.name,
      slug: row.slug,
      verificationHost: row.verificationHost,
      verificationValue: row.verificationValue,
    },
  }));

  const failed: BulkFailure[] = bulk.failed.map((failure) => ({
    ...failure,
    index: pendingIndexes[failure.index] ?? failure.index,
  }));
  const planBlocked: BulkFailure[] = bulk.planBlocked.map((failure) => ({
    ...failure,
    index: pendingIndexes[failure.index] ?? failure.index,
  }));

  const createdByIndex = new Map(createdRows.map((entry) => [entry.index, entry.row]));
  const existingByIndex = new Map(existingOccurrences.map((entry) => [entry.index, entry.row]));

  interface Plannable {
    index: number;
    name: string;
    domainId: string;
    slug: string;
    created: boolean;
    verification: { host: string; value: string } | null;
  }

  const plannable: Plannable[] = [];

  for (let index = 0; index < input.domains.length; index += 1) {
    const created = createdByIndex.get(index);
    if (created) {
      plannable.push({
        index,
        name: created.name,
        domainId: created.id,
        slug: created.slug,
        created: true,
        verification: { host: created.verificationHost, value: created.verificationValue },
      });
      continue;
    }

    const existing = existingByIndex.get(index);
    if (existing) {
      plannable.push({
        index,
        name: existing.name,
        domainId: existing.id,
        slug: existing.slug,
        created: false,
        verification: null,
      });
    }
  }

  // Plan each domain once even when a name was pasted twice.
  const uniqueDomains = new Map<string, Plannable>();
  for (const entry of plannable) {
    if (!uniqueDomains.has(entry.domainId)) {
      uniqueDomains.set(entry.domainId, entry);
    }
  }
  const uniqueList = [...uniqueDomains.values()];
  const plans = await mapWithDeadline(
    uniqueList,
    switchKitLimits.dnsConcurrency,
    switchKitLimits.deadlineMs,
    (entry) =>
      planDomainSwitch({
        domainName: entry.name,
        ourAddress,
        dns: systemDnsReader,
      }),
    (entry) => timedOutPlan(entry.name),
    (entry) => timedOutPlan(entry.name),
  );

  const planByDomainId = new Map(uniqueList.map((entry, index) => [entry.domainId, plans[index]!]));
  const statusByDomainId = new Map<string, SwitchStatus | null>();

  for (const [domainId, plan] of planByDomainId) {
    if (plan.incumbents.length === 0) {
      statusByDomainId.set(domainId, null);
      continue;
    }

    const status = await upsertPlannedSwitch({
      organizationId: input.organizationId,
      domainId,
      plan,
      actorUserId: input.actorUserId ?? undefined,
    });
    statusByDomainId.set(domainId, status);
  }

  const results: SwitchKitResultRow[] = plannable.map((entry) => ({
    index: entry.index,
    name: entry.name,
    domainId: entry.domainId,
    slug: entry.slug,
    created: entry.created,
    verification: entry.verification,
    plan: planByDomainId.get(entry.domainId)!,
    switchStatus: statusByDomainId.get(entry.domainId) ?? null,
  }));
  results.sort((a, b) => a.index - b.index);

  const plannedCount = results.filter((row) => row.switchStatus !== null).length;

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'SWITCH_KIT_IMPORTED',
    targetType: 'client',
    targetId: client.id,
    detail: {
      requested: input.domains.length,
      created: createdRows.length,
      existing: existingOccurrences.length,
      planned: plannedCount,
      failed: failed.length,
      planBlocked: planBlocked.length,
    },
  });

  return {
    results,
    failed,
    planBlocked,
    limits: switchKitLimits,
    ownershipNote: /\+[0-9a-f]{12}@/.test(ourAddress)
      ? 'Publishing the DMARC record below also proves ownership.'
      : null,
  };
}

export async function startSwitch(input: {
  organizationId: string;
  actorUserId?: string | null;
  domainIdOrSlug: string;
}) {
  const domain = await findDomainWithSwitch(input.organizationId, input.domainIdOrSlug);
  if (!domain) {
    return null;
  }

  if (domain.switch && domain.switch.status !== 'PLANNED') {
    throw new SwitchKitError(
      409,
      'SWITCH_IN_PROGRESS',
      'This domain is already switching. Check DNS to move it forward, or stop the switch first.',
    );
  }

  const ourAddress = clientAggregateAddress(domain.client.reportToken);
  const plan = await planDomainSwitch({
    domainName: domain.name,
    ourAddress,
    dns: systemDnsReader,
  });

  if (plan.incumbents.length === 0) {
    throw new SwitchKitError(
      409,
      'NO_INCUMBENT',
      plan.lookup === 'lookup_failed'
        ? 'The DMARC record could not be read, so there is no other provider to switch from. Check DNS and try again.'
        : 'The DMARC record does not send reports to another provider, so there is nothing to switch from.',
    );
  }

  await upsertPlannedSwitch({
    organizationId: input.organizationId,
    domainId: domain.id,
    plan,
    actorUserId: input.actorUserId ?? undefined,
  });

  const updated = await findDomainWithSwitch(input.organizationId, domain.id);
  return {
    switch: serializeSwitch(updated!.switch!),
    plan,
  };
}

export async function deleteSwitch(input: {
  organizationId: string;
  actorUserId?: string | null;
  domainIdOrSlug: string;
}): Promise<boolean> {
  const domain = await findDomainWithSwitch(input.organizationId, input.domainIdOrSlug);
  if (!domain || !domain.switch) {
    return false;
  }

  await prisma.domainSwitch.delete({ where: { id: domain.switch.id } });

  await recordAuditEvent({
    organizationId: input.organizationId,
    domainId: domain.id,
    actorUserId: input.actorUserId ?? undefined,
    action: 'DOMAIN_SWITCH_CANCELLED',
    targetType: 'domain_switch',
    targetId: domain.switch.id,
  });

  return true;
}

interface CheckableDomain {
  id: string;
  name: string;
  status: string;
  client: { reportToken: string };
  switch: NonNullable<DomainWithSwitch['switch']>;
}

interface CheckOutcome {
  status: SwitchStatus;
  transitioned: 'started' | 'cut_over' | null;
  issues: SwitchIssue[];
  throttled: boolean;
  verification: NonNullable<Awaited<ReturnType<typeof verifyDomain>>>['verification'] | null;
}

async function auditTransition(input: {
  organizationId: string;
  domainId: string;
  switchId: string;
  actorUserId?: string | null;
  transitioned: 'started' | 'cut_over' | null;
}): Promise<void> {
  if (!input.transitioned) {
    return;
  }

  await recordAuditEvent({
    organizationId: input.organizationId,
    domainId: input.domainId,
    actorUserId: input.actorUserId ?? undefined,
    action: input.transitioned === 'started' ? 'DOMAIN_SWITCH_STARTED' : 'DOMAIN_SWITCH_CUT_OVER',
    targetType: 'domain_switch',
    targetId: input.switchId,
  });
}

async function performCheck(input: {
  organizationId: string;
  domain: CheckableDomain;
  actorUserId?: string | null;
  now: Date;
}): Promise<CheckOutcome> {
  const row = input.domain.switch!;
  const ourAddress = clientAggregateAddress(input.domain.client.reportToken);

  if (row.lastCheckedAt && input.now.getTime() - row.lastCheckedAt.getTime() < CHECK_THROTTLE_MS) {
    return {
      status: row.status as SwitchStatus,
      transitioned: null,
      issues: issueObjects(row.issues),
      throttled: true,
      verification: null,
    };
  }

  const plan = await planDomainSwitch({
    domainName: input.domain.name,
    ourAddress,
    dns: systemDnsReader,
  });

  const observation: SwitchRecordObservation =
    plan.lookup === 'found' && plan.currentRecord
      ? { kind: 'found', record: plan.currentRecord }
      : plan.lookup === 'multiple_records'
        ? { kind: 'multiple_records' }
        : plan.lookup === 'lookup_failed'
          ? { kind: 'lookup_failed' }
          : { kind: 'no_record' };

  const state = nextSwitchState(
    {
      status: row.status as SwitchStatus,
      startedAt: row.startedAt,
      cutOverAt: row.cutOverAt,
      incumbentTargets: jsonStringArray(row.incumbentAggregateTargets),
    },
    observation,
    input.now,
  );
  const issues = [...state.issues];
  if (plan.externalAuthorization === 'missing' && !issues.includes('authorization_missing')) {
    issues.push('authorization_missing');
  }

  const written = await writeSwitchState({
    rowId: row.id,
    readStatus: row.status as SwitchStatus,
    data: {
      status: state.status,
      startedAt: state.startedAt,
      cutOverAt: state.cutOverAt,
      issues: issues as unknown as Prisma.InputJsonValue,
      // Only a record that was actually read replaces the last one seen. A
      // failed lookup leaves the cutover record built from the last good read.
      ...(plan.lookup === 'lookup_failed' ? {} : { lastSeenRecord: plan.currentRecord }),
      externalAuthorization: plan.externalAuthorization,
      lastCheckedAt: input.now,
    },
  });

  const transitioned = written ? state.transitioned : null;

  await auditTransition({
    organizationId: input.organizationId,
    domainId: input.domain.id,
    switchId: row.id,
    actorUserId: input.actorUserId,
    transitioned,
  });

  let verification: CheckOutcome['verification'] = null;
  if (input.domain.status !== 'VERIFIED') {
    const verified = await verifyDomain(input.organizationId, input.domain.id);
    verification = verified?.verification ?? null;
  }

  return {
    status: state.status,
    transitioned,
    issues: issues.map((code) => ({ code, message: switchIssueMessages[code] })),
    throttled: false,
    verification,
  };
}

export async function checkSwitch(input: {
  organizationId: string;
  actorUserId?: string | null;
  domainIdOrSlug: string;
}) {
  const domain = await findDomainWithSwitch(input.organizationId, input.domainIdOrSlug);
  if (!domain || !domain.switch) {
    return null;
  }

  const outcome = await performCheck({
    organizationId: input.organizationId,
    domain: { ...domain, switch: domain.switch },
    actorUserId: input.actorUserId,
    now: new Date(),
  });

  const updated = await findDomainWithSwitch(input.organizationId, domain.id);
  const detail = await detailFor(updated!);

  return {
    ...detail,
    verification: outcome.verification,
    throttled: outcome.throttled,
  };
}

export async function checkClientSwitches(input: {
  organizationId: string;
  actorUserId?: string | null;
  clientId: string;
}) {
  const client = await prisma.client.findFirst({
    where: { id: input.clientId, organizationId: input.organizationId },
    select: { id: true },
  });

  if (!client) {
    throw new SwitchKitError(404, 'NOT_FOUND', 'Client not found in this workspace.');
  }

  const rows = await prisma.domainSwitch.findMany({
    where: { organizationId: input.organizationId, domain: { clientId: client.id } },
    include: {
      domain: {
        select: {
          id: true,
          name: true,
          status: true,
          client: { select: { reportToken: true } },
        },
      },
    },
    take: switchKitLimits.maxDomains,
  });

  const withSwitch: CheckableDomain[] = rows.map((row) => ({
    id: row.domain.id,
    name: row.domain.name,
    status: row.domain.status,
    client: row.domain.client,
    switch: row,
  }));
  const now = new Date();

  const outcomes = await mapWithDeadline(
    withSwitch,
    switchKitLimits.dnsConcurrency,
    switchKitLimits.deadlineMs,
    (domain) =>
      performCheck({
        organizationId: input.organizationId,
        domain,
        actorUserId: input.actorUserId,
        now,
      }),
    (domain) => ({
      status: domain.switch.status as SwitchStatus,
      transitioned: null,
      issues: [{ code: 'lookup_failed' as const, message: switchIssueMessages.lookup_failed }],
      throttled: false,
      verification: null,
    }),
    (domain) => ({
      status: domain.switch.status as SwitchStatus,
      transitioned: null,
      issues: [{ code: 'lookup_failed' as const, message: switchIssueMessages.lookup_failed }],
      throttled: false,
      verification: null,
    }),
  );

  return {
    results: withSwitch.map((domain, index) => ({
      domainId: domain.id,
      name: domain.name,
      status: outcomes[index]!.status,
      transitioned: outcomes[index]!.transitioned,
      issues: outcomes[index]!.issues,
      throttled: outcomes[index]!.throttled,
    })),
  };
}

/**
 * Keeps a switch row current after a scan.
 *
 * Best effort by design: a scan is the customer's evidence and must not fail
 * because the switch bookkeeping did. The next check repairs the row.
 */
export async function applySwitchRecord(domainId: string, observation: SwitchRecordObservation): Promise<void> {
  try {
    const row = await prisma.domainSwitch.findUnique({
      where: { domainId },
      include: { domain: { select: { client: { select: { organizationId: true } } } } },
    });
    if (!row) {
      return;
    }

    const now = new Date();
    const state = nextSwitchState(
      {
        status: row.status as SwitchStatus,
        startedAt: row.startedAt,
        cutOverAt: row.cutOverAt,
        incumbentTargets: jsonStringArray(row.incumbentAggregateTargets),
      },
      observation,
      now,
    );

    // A scan does not re-read the report-authorization record, so the last
    // check's finding is carried forward rather than silently cleared.
    const issues = [...state.issues];
    if (row.externalAuthorization === 'missing' && !issues.includes('authorization_missing')) {
      issues.push('authorization_missing');
    }

    const written = await writeSwitchState({
      rowId: row.id,
      readStatus: row.status as SwitchStatus,
      data: {
        status: state.status,
        startedAt: state.startedAt,
        cutOverAt: state.cutOverAt,
        issues: issues as unknown as Prisma.InputJsonValue,
        ...(observation.kind === 'found' ? { lastSeenRecord: observation.record } : {}),
        ...(observation.kind === 'no_record' ? { lastSeenRecord: null } : {}),
      },
    });

    await auditTransition({
      organizationId: row.domain.client.organizationId,
      domainId,
      switchId: row.id,
      transitioned: written ? state.transitioned : null,
    });
  } catch (error) {
    console.warn(
      `[switch-kit] Could not update the switch for domain ${domainId}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}
