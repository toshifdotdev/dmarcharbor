/**
 * api-public.ts — the two public artefacts.
 *
 * PUBLIC AND STAYING PUBLIC: the Trust Center and the compliance verifier are
 * opened by an auditor with no account. Every call here deliberately sends NO
 * session cookie and no credentials — an accidental auth dependency on either
 * surface would break the product's contract. There is no import of the
 * session helpers on purpose.
 */

import type { TrustCenterPayload, CompliancePackRecord } from "./types";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

async function publicFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
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
 *  published fingerprint only: digest, size, dates. Never the document, never
 *  a client name. */
export async function verifyCompliancePack(
  reference: string,
): Promise<{ found: boolean; packs: CompliancePackRecord[] }> {
  return publicFetch(`/api/compliance-packs/verify?reference=${encodeURIComponent(reference)}`);
}
