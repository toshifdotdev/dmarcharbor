/**
 * api-public.ts — the public artefacts.
 *
 * PUBLIC AND STAYING PUBLIC: the Trust Center, the compliance verifier and a
 * prospect risk report are opened by someone with no account. Every call here deliberately sends NO
 * session cookie and no credentials — an accidental auth dependency on either
 * surface would break the product's contract. There is no import of the
 * session helpers on purpose.
 */

import { API_BASE, apiFetch } from "./api-fetch";
import { retryAfterFrom } from "./retry-after";
import type { TrustCenterPayload, CompliancePackRecord, PublicProspectReport } from "./types";


async function publicFetch<T>(path: string): Promise<T> {
  const res = await apiFetch(`${API_BASE}${path}`, {
    cache: "no-store",
    credentials: "omit",
    headers: { accept: "application/json" },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (error) {
    // A failure answered in HTML (a proxy's 502 page, a gateway's 429) still
    // has a status, and the status is what the page decides on. Only a
    // success that cannot be read is a broken response.
    if (res.ok) throw error;
  }
  if (!res.ok) {
    const err = body as { error?: { code?: string; message?: string } } | null;
    throw new PublicError(
      res.status,
      err?.error?.code,
      err?.error?.message,
      res.status === 429 ? retryAfterFrom(res.headers) : null,
    );
  }
  return body as T;
}

export class PublicError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** Seconds a 429 asked to wait, from Retry-After; null when it did not say. */
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    code: string | undefined,
    message: string | undefined,
    retryAfterSeconds: number | null = null,
  ) {
    super(message ?? `Public request failed (${status})`);
    this.name = "PublicError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** GET /api/trust/{slug} — unauthenticated. A missing slug answers 404 with
 *  the same body as a withdrawn one, so the endpoint cannot confirm a client
 *  ever existed. */
export function getTrustCenter(slug: string): Promise<TrustCenterPayload> {
  return publicFetch<TrustCenterPayload>(`/api/trust/${encodeURIComponent(slug)}`);
}

/** GET /api/prospect-reports/{token} — unauthenticated. A revoked, expired or
 *  made-up token answers the same 404. Reading it never scans; it is the
 *  snapshot taken when the report was created. */
export function getProspectReport(token: string): Promise<PublicProspectReport> {
  return publicFetch<PublicProspectReport>(`/api/prospect-reports/${encodeURIComponent(token)}`);
}

/** GET /api/compliance-packs/verify?reference= — unauthenticated. Returns the
 * published fingerprint only: digest, size, dates. Never the document, never
 * a client name. */
export async function verifyCompliancePack(
  reference: string,
): Promise<{ found: boolean; packs: CompliancePackRecord[] }> {
  return publicFetch(`/api/compliance-packs/verify?reference=${encodeURIComponent(reference)}`);
}

export interface ServiceMeta {
  retention: {
    /** Aggregate report retention, enforced by the purge sweep. */
    reportDays: number;
    /** Forensic report retention, enforced by the purge sweep. */
    forensicDays: number;
    /** Named forensic PII retention, the shortest and the most sensitive. */
    forensicPiiDays: number;
  };
  alerting: {
    evaluationIntervalMinutes: number;
    rollupHours: number;
    staleDays: number;
  };
  monitoring?: {
    /** How often each verified domain is rescanned. */
    rescanIntervalMinutes: number;
    enabled: boolean;
  };
  /** The zone hosted DMARC records are served from, when the feature is on. */
  hostedZone?: string | null;
  /** Services whose vendor documentation names an SPF include. */
  spfServices?: Array<{ id: string; name: string; include: string }>;
  /** The shared aggregate report address. Absent on an older API. */
  reports?: { aggregateAddress: string };
}

/**
 * GET /api/meta — unauthenticated, and the authority on what this deployment
 * actually does.
 *
 * Read by the billing page to replace the plan figures it used to print.
 * The plan used to carry `dataRetentionDays` and `auditRetentionDays`, which looked
 * like retention statements and governed nothing: the first was a quota rule about
 * dormant domains counting against the active-domain limit (now named
 * `activeDomainWindowDays`), and the second was read nowhere, because nothing deletes
 * an audit log. Both are gone from the catalog. A signed compliance pack
 * was corrected for exactly this in the backend, and the price page was still quoting
 * the same two numbers to anyone deciding whether to buy.
 *
 * The audit trail has no automatic expiry, so it is deliberately absent from this
 * shape rather than reported as a window that does not exist.
 */
export async function getServiceMeta(): Promise<ServiceMeta> {
  return publicFetch<ServiceMeta>("/api/meta");
}
