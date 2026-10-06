/**
 * api-public.ts — the two public artefacts.
 *
 * PUBLIC AND STAYING PUBLIC: the Trust Center and the compliance verifier are
 * opened by an auditor with no account. Every call here deliberately sends NO
 * session cookie and no credentials — an accidental auth dependency on either
 * surface would break the product's contract. There is no import of the
 * session helpers on purpose.
 */

import { API_BASE, apiFetch } from "./api-fetch";
import type { TrustCenterPayload, CompliancePackRecord } from "./types";


async function publicFetch<T>(path: string): Promise<T> {
  const res = await apiFetch(`${API_BASE}${path}`, {
    cache: "no-store",
    credentials: "omit",
    headers: { accept: "application/json" },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = body as { error?: { code?: string; message?: string } } | null;
    throw new PublicError(res.status, err?.error?.code, err?.error?.message);
  }
  return body as T;
}

export class PublicError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string | undefined) {
    super(message ?? `Public request failed (${status})`);
    this.name = "PublicError";
    this.status = status;
    this.code = code;
  }
}

/** GET /api/trust/{slug} — unauthenticated. A missing slug answers 404 with
 *  the same body as a withdrawn one, so the endpoint cannot confirm a client
 *  ever existed. */
export function getTrustCenter(slug: string): Promise<TrustCenterPayload> {
  return publicFetch<TrustCenterPayload>(`/api/trust/${encodeURIComponent(slug)}`);
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
}

/**
 * GET /api/meta — unauthenticated, and the authority on what this deployment
 * actually does.
 *
 * Read by the billing page to replace the plan figures it used to print.
 * `plan.dataRetentionDays` and `plan.auditRetentionDays` look like retention
 * statements and govern nothing: the first is read in exactly one place, a quota rule
 * about dormant domains counting against the active-domain limit, and the second is
 * read nowhere at all, because nothing deletes an audit log. A signed compliance pack
 * was corrected for exactly this in the backend, and the price page was still quoting
 * the same two numbers to anyone deciding whether to buy.
 *
 * The audit trail has no automatic expiry, so it is deliberately absent from this
 * shape rather than reported as a window that does not exist.
 */
export async function getServiceMeta(): Promise<ServiceMeta> {
  return publicFetch<ServiceMeta>("/api/meta");
}
