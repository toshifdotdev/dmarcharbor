import type { Organization } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../database/prisma.js';
import { queueEmail } from '../../email/email.service.js';
import { plainTextEmail } from '../../email/templates.js';
import { systemDnsReader } from '../../scanner/dns.js';
import type { DnsReader } from '../../scanner/types.js';
import { recordAuditEvent } from '../audit.service.js';
import { customHostnameCapacity } from '../hosted-dns/custom-hostname-capacity.js';
import { hostedCustomHostnameClient } from '../hosted-dns/provider.js';
import { guardedRequest, type GuardedResult } from '../net/guarded-request.js';

/**
 * Serving an agency's verified custom domain (Admiralty).
 *
 * Verifying the ownership TXT proves the agency controls the domain. It does
 * not make `https://portal.agency.example` open our pages: the hostname has to
 * point at us, and something has to hold a certificate for it. Until session 14
 * nothing did either, and the page said only that the hostname "must also
 * point at this service".
 *
 * Two ways, chosen by the deployment's configuration:
 *
 * - **automatic**: the hosted zone is on Cloudflare for SaaS and
 *   AGENCY_DOMAIN_ORIGIN names the web app's record in it. On verification the
 *   hostname is registered as a custom hostname with that origin, and
 *   Cloudflare issues the certificate once the agency's CNAME resolves.
 * - **manual**: only AGENCY_DOMAIN_CNAME_TARGET is set. The operator is emailed
 *   to add the hostname (and its certificate) to the hosting by hand.
 *
 * Either way the domain is **live** only once `https://<domain>` answers as
 * this agency through us. That probe is the one test both ways share, and it
 * is what emailed client links wait for: a link to a host that does not serve
 * us yet is a broken link in a client's inbox.
 */

export type AgencyDomainMode = 'automatic' | 'manual' | 'unavailable';

export type CnameState = 'found' | 'missing' | 'elsewhere';

export interface AgencyDomainHostingView {
  mode: AgencyDomainMode;
  /** The name the agency points its domain at, or null when the deployment has none. */
  cnameTarget: string | null;
  cnameState: CnameState | null;
  /** Cloudflare's view, automatic mode only. */
  hostnameStatus: string | null;
  sslStatus: string | null;
  sslError: string | null;
  setupError: string | null;
  /** True once https://<domain> has answered as this agency through us. */
  live: boolean;
  liveAt: string | null;
  checkedAt: string | null;
  /** Manual mode: when the operator was asked to switch it on. */
  requestedAt: string | null;
}

type HostingRow = Pick<
  Organization,
  | 'id'
  | 'name'
  | 'customDomain'
  | 'customDomainVerifiedAt'
  | 'customDomainHostnameId'
  | 'customDomainHostnameStatus'
  | 'customDomainSslStatus'
  | 'customDomainSslError'
  | 'customDomainCnameState'
  | 'customDomainCheckedAt'
  | 'customDomainLiveAt'
  | 'customDomainOperatorNotifiedAt'
  | 'customDomainSetupError'
>;

const hostingSelect = {
  id: true,
  name: true,
  customDomain: true,
  customDomainVerifiedAt: true,
  customDomainHostnameId: true,
  customDomainHostnameStatus: true,
  customDomainSslStatus: true,
  customDomainSslError: true,
  customDomainCnameState: true,
  customDomainCheckedAt: true,
  customDomainLiveAt: true,
  customDomainOperatorNotifiedAt: true,
  customDomainSetupError: true,
} as const;

/** Every hosting column, cleared: for a domain removed, changed or never set. */
export const clearedHosting = {
  customDomainHostnameId: null,
  customDomainHostnameStatus: null,
  customDomainSslStatus: null,
  customDomainSslError: null,
  customDomainCnameState: null,
  customDomainCheckedAt: null,
  customDomainLiveAt: null,
  customDomainOperatorNotifiedAt: null,
  customDomainSetupError: null,
  customDomainRecheckedAt: null,
  customDomainFailedChecks: 0,
} as const;

export function agencyDomainMode(): AgencyDomainMode {
  if (!env.AGENCY_DOMAIN_CNAME_TARGET) return 'unavailable';
  if (env.AGENCY_DOMAIN_ORIGIN && hostedCustomHostnameClient()) return 'automatic';
  return 'manual';
}

export class AgencyDomainHostingError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, code: string, status = 502) {
    super(message);
    this.name = 'AgencyDomainHostingError';
    this.code = code;
    this.status = status;
  }
}

// ─── the live probe ─────────────────────────────────────────────────────────

export type AgencyDomainProbe = (host: string) => Promise<GuardedResult>;

/**
 * `https://<host>/api/branding/host` through the guarded requester: https on
 * 443 only, the address checked and pinned, no redirect followed. The web app
 * proxies `/api` here, so a 200 naming this agency proves three things at
 * once: the name points at us, the certificate is valid, and the proxy
 * resolves it to the right workspace.
 */
const systemProbe: AgencyDomainProbe = (host) =>
  guardedRequest({
    url: `https://${host}/api/branding/host`,
    method: 'GET',
    headers: { accept: 'application/json' },
    timeoutMs: 8_000,
    maxBytes: 65_536,
  });

let probeOverride: AgencyDomainProbe | null = null;

/** Test seam: replaces the network probe. Null restores it. */
export function setAgencyDomainProbeForTests(probe: AgencyDomainProbe | null): void {
  probeOverride = probe;
}

async function answersAsAgency(host: string, workspaceName: string): Promise<boolean> {
  const result = await (probeOverride ?? systemProbe)(host);
  if (result.status !== 'ok' || result.statusCode !== 200) return false;
  try {
    const body = JSON.parse(result.body.toString('utf8')) as { workspaceName?: unknown; customDomainVerified?: unknown };
    return body.customDomainVerified === true && body.workspaceName === workspaceName;
  } catch {
    return false;
  }
}

// ─── the view ───────────────────────────────────────────────────────────────

export function hostingViewFor(row: HostingRow | null): AgencyDomainHostingView {
  const mode = agencyDomainMode();
  return {
    mode,
    cnameTarget: env.AGENCY_DOMAIN_CNAME_TARGET ?? null,
    cnameState: (row?.customDomainCnameState as CnameState | null | undefined) ?? null,
    hostnameStatus: row?.customDomainHostnameStatus ?? null,
    sslStatus: row?.customDomainSslStatus ?? null,
    sslError: row?.customDomainSslError ?? null,
    setupError: row?.customDomainSetupError ?? null,
    live: Boolean(row?.customDomainLiveAt),
    liveAt: row?.customDomainLiveAt?.toISOString() ?? null,
    checkedAt: row?.customDomainCheckedAt?.toISOString() ?? null,
    requestedAt: row?.customDomainOperatorNotifiedAt?.toISOString() ?? null,
  };
}

export async function agencyDomainHosting(organizationId: string): Promise<AgencyDomainHostingView> {
  const row = await prisma.organization.findUnique({ where: { id: organizationId }, select: hostingSelect });
  return hostingViewFor(row);
}

// ─── telling the operator ───────────────────────────────────────────────────

/**
 * Asks a person to finish what the deployment cannot. Once per domain: the
 * timestamp is set before the email is queued, and the idempotency key holds a
 * second request for the same domain and reason to one message.
 */
async function notifyOperator(
  row: HostingRow,
  reason: 'manual' | 'refused',
  detail?: string,
): Promise<void> {
  if (row.customDomainOperatorNotifiedAt || !row.customDomain) return;
  await prisma.organization.update({
    where: { id: row.id },
    data: { customDomainOperatorNotifiedAt: new Date() },
  });
  if (!env.OPERATOR_EMAIL) {
    console.error(
      `[agency-domain] ${row.customDomain} (${row.name}) needs switching on by hand, and OPERATOR_EMAIL is not set.`,
    );
    return;
  }
  const domain = row.customDomain;
  const target = env.AGENCY_DOMAIN_CNAME_TARGET ?? 'the agency CNAME target';
  const text =
    reason === 'manual'
      ? [
          `${row.name} verified ${domain} as its custom domain and is waiting for it to go live.`,
          '',
          `Add ${domain} to the web app's hosting with a certificate for it (for example an alternate domain and an ACM certificate on the load balancer or CloudFront). The agency has been told to CNAME ${domain} to ${target}.`,
          '',
          `It goes live by itself once https://${domain} answers through us; the agency's page and the 15-minute check both look. Workspace id: ${row.id}.`,
        ].join('\n')
      : [
          `Cloudflare refused the custom hostname ${domain} for ${row.name}, so its certificate was not issued automatically.`,
          '',
          `Cloudflare said: ${detail ?? 'no reason given'}`,
          '',
          `Fix the cause (the hostname limit, the token's SSL and Certificates permission, AGENCY_DOMAIN_ORIGIN), then press Check on the agency's white label page, or add the hostname by hand. Workspace id: ${row.id}.`,
        ].join('\n');
  queueEmail(
    plainTextEmail({
      subject: `[operator] Switch on ${domain} for ${row.name}`,
      text,
      kind: 'Operator',
    }),
    env.OPERATOR_EMAIL,
    `agency-domain:${reason}:${row.id}:${domain}`,
  );
}

// ─── setting it up ──────────────────────────────────────────────────────────

/**
 * After the ownership TXT is verified: register the hostname (automatic) or
 * ask the operator (manual). Idempotent: a hostname already registered, or an
 * operator already asked, is left alone.
 */
async function provision(row: HostingRow): Promise<HostingRow> {
  if (!row.customDomain || !row.customDomainVerifiedAt) return row;
  const mode = agencyDomainMode();
  if (mode === 'unavailable') return row;

  if (mode === 'manual') {
    await notifyOperator(row, 'manual');
    return (await prisma.organization.findUniqueOrThrow({ where: { id: row.id }, select: hostingSelect })) as HostingRow;
  }

  if (row.customDomainHostnameId) return row;
  const client = hostedCustomHostnameClient();
  if (!client) return row;

  const capacity = await customHostnameCapacity();
  if (capacity.full) {
    const message = `This deployment holds its limit of ${capacity.limit} custom hostnames, so the certificate could not be requested.`;
    await prisma.organization.update({ where: { id: row.id }, data: { customDomainSetupError: message } });
    await notifyOperator(row, 'refused', message);
    return (await prisma.organization.findUniqueOrThrow({ where: { id: row.id }, select: hostingSelect })) as HostingRow;
  }

  try {
    const created = await client.create(row.customDomain, { customOriginServer: env.AGENCY_DOMAIN_ORIGIN });
    return (await prisma.organization.update({
      where: { id: row.id },
      data: {
        customDomainHostnameId: created.id,
        customDomainHostnameStatus: created.status,
        customDomainSslStatus: created.sslStatus,
        customDomainSslError: created.sslError,
        customDomainSetupError: null,
      },
      select: hostingSelect,
    })) as HostingRow;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Cloudflare refused the custom hostname.';
    await prisma.organization.update({ where: { id: row.id }, data: { customDomainSetupError: message } });
    await notifyOperator(row, 'refused', message);
    return (await prisma.organization.findUniqueOrThrow({ where: { id: row.id }, select: hostingSelect })) as HostingRow;
  }
}

function cnameStateOf(found: string[] | undefined, status: string): CnameState | null {
  if (status === 'error') return null;
  const target = env.AGENCY_DOMAIN_CNAME_TARGET;
  const first = found?.[0]?.trim().toLowerCase().replace(/\.+$/, '');
  if (status !== 'found' || !first) return 'missing';
  return target && first === target ? 'found' : 'elsewhere';
}

/**
 * Looks at everything once: provisions if needed, reads the CNAME and
 * Cloudflare's certificate state, and probes the host. Called by Check on the
 * agency's page (with the TXT verification) and by the 15-minute pass.
 *
 * A read that fails changes nothing: "could not ask" is not "broken". Once
 * live, a later failed probe does not take it back; the domain stays live
 * until it is changed or removed, because a short outage must not flip every
 * client link back to our address and forward again.
 */
export async function checkAgencyDomain(
  organizationId: string,
  deps: { reader?: DnsReader; now?: Date } = {},
): Promise<AgencyDomainHostingView> {
  const now = deps.now ?? new Date();
  let row = (await prisma.organization.findUnique({ where: { id: organizationId }, select: hostingSelect })) as HostingRow | null;
  if (!row?.customDomain || !row.customDomainVerifiedAt) {
    return hostingViewFor(row);
  }
  row = await provision(row);
  const domain = row.customDomain!;

  const update: Record<string, unknown> = { customDomainCheckedAt: now };

  const reader = deps.reader ?? systemDnsReader;
  if (reader.resolveCname) {
    const lookup = await reader.resolveCname(domain).catch(() => ({ status: 'error' as const, value: undefined }));
    const state = cnameStateOf(lookup.value, lookup.status);
    if (state) update.customDomainCnameState = state;
  }

  const client = hostedCustomHostnameClient();
  if (agencyDomainMode() === 'automatic' && client && row.customDomainHostnameId) {
    try {
      const hostname = await client.get(row.customDomainHostnameId);
      update.customDomainHostnameStatus = hostname.status;
      update.customDomainSslStatus = hostname.sslStatus;
      update.customDomainSslError = hostname.sslError;
    } catch {
      // unchanged
    }
  }

  let becameLive = false;
  if (!row.customDomainLiveAt && (await answersAsAgency(domain, row.name))) {
    update.customDomainLiveAt = now;
    becameLive = true;
  }

  const saved = (await prisma.organization.update({
    where: { id: organizationId },
    data: update,
    select: hostingSelect,
  })) as HostingRow;

  if (becameLive) {
    await recordAuditEvent({
      organizationId,
      action: 'CUSTOM_DOMAIN_LIVE',
      targetType: 'organization',
      targetId: organizationId,
      detail: { customDomain: domain, mode: agencyDomainMode() },
    });
  }

  return hostingViewFor(saved);
}

// ─── letting it go ──────────────────────────────────────────────────────────

/**
 * Removes the stored Cloudflare hostname before the domain is changed or
 * removed. Throws when Cloudflare refuses, so the caller keeps the stored id:
 * it is the only handle on a hostname that is still ours and still billed.
 */
export async function releaseAgencyHostname(organizationId: string): Promise<void> {
  const row = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { customDomainHostnameId: true },
  });
  if (!row?.customDomainHostnameId) return;
  const client = hostedCustomHostnameClient();
  if (!client) {
    throw new AgencyDomainHostingError(
      'The certificate for this domain is held by Cloudflare, and this deployment cannot reach it to remove it. Nothing was changed.',
      'CUSTOM_DOMAIN_HOSTNAME_STUCK',
      503,
    );
  }
  try {
    await client.remove(row.customDomainHostnameId);
  } catch (error) {
    throw new AgencyDomainHostingError(
      `Cloudflare would not remove the certificate for this domain yet, so nothing was changed. Try again in a few minutes. (${
        error instanceof Error ? error.message : 'no reason given'
      })`,
      'CUSTOM_DOMAIN_HOSTNAME_STUCK',
      502,
    );
  }
}

export interface AgencyHostnameSnapshot {
  organizationId: string;
  hostnameId: string;
  domain: string | null;
}

/**
 * Read before a workspace is deleted, while the row (the only record of the
 * Cloudflare hostname id) still exists. The cascade cannot reach Cloudflare.
 */
export async function agencyHostnameSnapshotFor(organizationId: string): Promise<AgencyHostnameSnapshot | null> {
  const row = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { customDomain: true, customDomainHostnameId: true },
  });
  if (!row?.customDomainHostnameId) return null;
  return { organizationId, hostnameId: row.customDomainHostnameId, domain: row.customDomain };
}

/**
 * After the delete has committed: removes the hostname, best effort. A failure
 * is logged with the id so the operator can delete it by hand; it never stops
 * the deletion, which has already happened.
 */
export async function removeAgencyHostnameForDeletion(snapshot: AgencyHostnameSnapshot | null): Promise<void> {
  if (!snapshot) return;
  const client = hostedCustomHostnameClient();
  try {
    if (!client) throw new Error('this deployment has no Cloudflare custom hostname client');
    await client.remove(snapshot.hostnameId);
  } catch (error) {
    console.error(
      `[agency-domain] could not remove Cloudflare custom hostname ${snapshot.hostnameId} (${
        snapshot.domain ?? '?'
      }) for deleted workspace ${snapshot.organizationId}; delete it by hand: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }
}

// ─── the pass ───────────────────────────────────────────────────────────────

export interface AgencyDomainPassSummary {
  checked: number;
  live: number;
}

/**
 * Every verified domain that is not live yet, so an agency that published its
 * CNAME and walked away still goes live, and a manual one goes live when the
 * operator has finished. Bounded per pass; the oldest check goes first.
 */
export async function runAgencyDomainPass(now: Date = new Date(), limit = 50): Promise<AgencyDomainPassSummary> {
  const summary: AgencyDomainPassSummary = { checked: 0, live: 0 };
  if (agencyDomainMode() === 'unavailable') return summary;
  const due = await prisma.organization.findMany({
    where: { customDomain: { not: null }, customDomainVerifiedAt: { not: null }, customDomainLiveAt: null },
    orderBy: { customDomainCheckedAt: { sort: 'asc', nulls: 'first' } },
    take: limit,
    select: { id: true },
  });
  for (const { id } of due) {
    try {
      const view = await checkAgencyDomain(id, { now });
      summary.checked += 1;
      if (view.live) summary.live += 1;
    } catch (error) {
      console.error(`[agency-domain] check failed for ${id}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  return summary;
}
