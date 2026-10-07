/**
 * ops-client.ts — browser-side mutations for the Phase 3 screens. Calls hit
 * the same-origin rewrite to the API (see next.config.ts), so the session
 * cookie stays first-party.
 *
 * Every call returns a discriminated result instead of throwing, so a form can
 * render the API's own 402 body and route the upgrade prompt by the `feature`
 * key — never by matching on the message.
 *
 * Staff-only endpoints (POST /billing/reconcile, PATCH /workspaces/:id/plan,
 * PATCH/POST/DELETE /workspaces/:id/entitlement-overrides) are deliberately
 * absent: no user can reach them and no screen needs them.
 */

import type {
  ApiErrorBody,
  BillingCurrencyPreference,
  ErasureCreated,
  ExportJob,
  IssuedApiKey,
  PortalGrant,
  SlackDestination,
  VerifyDomainResult,
} from "./types";

export type OpsResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: ApiErrorBody["error"] };

async function call<T>(
  path: string,
  init?: RequestInit,
): Promise<OpsResult<T>> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      credentials: "include",
    });
    if (res.status === 204) return { ok: true, data: undefined as T };
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
      // Most endpoints nest their error under `error` (the contract shape), but
      // Slack's controller flattens it: { error: "message", code: … }. A
      // helpful message must survive either shape, or the UI would show
      // "undefined" where the API said exactly what was wrong.
      const nested = (body as ApiErrorBody)?.error;
      const flattened =
        nested && typeof nested === "object"
          ? nested
          : {
              message: typeof (body as { error?: unknown })?.error === "string"
                ? ((body as { error: string }).error)
                : `Request failed (${res.status})`,
              code: (body as { code?: string })?.code,
            };
      // A refusal like PLAN_CHANGE_OVER_QUOTA carries structured numbers. The
      // wire format is final and FLAT: overage/from/to live directly on the
      // error object ({ error: { code, message, overage, from, to } }): no
      // nested detail, so the rows land where the controller puts them.
      return {
        ok: false,
        status: res.status,
        error: flattened,
      };
    }
    return { ok: true, data: body as T };
  } catch {
    return {
      ok: false,
      status: 0,
      error: { message: "The request could not be sent." },
    };
  }
}

const wsPath = (orgId: string, tail: string) =>
  `/api/workspaces/${orgId}${tail}`;

/**
 * Exported so a feature client that is its own file (webhooks-client.ts) runs on
 * this exact call rather than writing a second copy of the error shaping. A
 * second implementation would be a second thing to keep correct: a 402 routed by
 * a differently parsed `feature` key silently stops offering the upgrade prompt.
 */
export const opsCall = call;

// ─── portal access grants (agency side) ─────────────────────────────────────

/** POST /portal-access — grant a contact access to ONE client's portal. The
 *  grant is held against the email address and activates the first time that
 *  person signs in with it. */
export const grantPortalAccess = (
  orgId: string,
  clientId: string,
  body: { email: string; displayName?: string },
) =>
  call<PortalGrant & { notice?: string }>(
    `${wsPath(orgId, "")}/clients/${clientId}/portal-access`,
    { method: "POST", body: JSON.stringify(body) },
  );

/** GET /portal-access — every grant in the workspace, active and revoked. */
export const listPortalAccess = (orgId: string) =>
  call<{ grants: PortalGrant[] }>(wsPath(orgId, "/portal-access"));

/** DELETE /portal-access/:id — revoke a grant. The contact loses the portal
 *  the next time they load it. */
export const revokePortalAccess = (orgId: string, accessId: string) =>
  call<void>(wsPath(orgId, `/portal-access/${accessId}`), { method: "DELETE" });

// ─── trust center (agency side) ─────────────────────────────────────────────

/** POST /clients/:id/trust-center — publish the public Trust Center. Gated on
 *  the trust.center entitlement. */
export const createTrustCenter = (orgId: string, clientId: string) =>
  call<{ url: string; slug: string }>(
    `${wsPath(orgId, "")}/clients/${clientId}/trust-center`,
    { method: "POST" },
  );

/** DELETE /clients/:id/trust-center — withdraw the link. The page goes down
 *  immediately; publishing again mints a NEW slug, so a leaked address stays
 *  dead. */
export const revokeTrustCenter = (orgId: string, clientId: string) =>
  call<{ status: string }>(
    `${wsPath(orgId, "")}/clients/${clientId}/trust-center`,
    { method: "DELETE" },
  );

// ─── alerts ──────────────────────────────────────────────────────────────────

export interface AlertRuleCreateBody {
  domainId: string;
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  windowMinutes: number;
  cooldownMinutes: number;
  maxReminderLevel: number;
  recipientUserIds: string[];
}

export const createAlertRule = (orgId: string, body: AlertRuleCreateBody) =>
  call(wsPath(orgId, "/alert-rules"), { method: "POST", body: JSON.stringify(body) });

export const patchAlertRule = (
  orgId: string,
  ruleId: string,
  body: Partial<AlertRuleCreateBody> & { enabled?: boolean },
) =>
  call(wsPath(orgId, `/alert-rules/${ruleId}`), {
    method: "PATCH",
    body: JSON.stringify(body),
  });

export const removeAlertRule = (orgId: string, ruleId: string) =>
  call(wsPath(orgId, `/alert-rules/${ruleId}`), { method: "DELETE" });

export const acknowledgeAlert = (orgId: string, eventId: string) =>
  call(wsPath(orgId, `/alerts/${eventId}/acknowledge`), { method: "POST" });

// ─── digests ─────────────────────────────────────────────────────────────────

export interface ReportDigestCreateBody {
  domainId: string;
  frequency: "WEEKLY" | "MONTHLY";
  sendHourUtc: number;
  weekday: number;
  dayOfMonth: number;
  recipientEmails: string[];
  includeForensics: boolean;
}

export const createReportDigest = (orgId: string, body: ReportDigestCreateBody) =>
  call(wsPath(orgId, "/report-digests"), { method: "POST", body: JSON.stringify(body) });

export const patchReportDigest = (
  orgId: string,
  digestId: string,
  body: Partial<ReportDigestCreateBody> & { enabled?: boolean },
) =>
  call(wsPath(orgId, `/report-digests/${digestId}`), {
    method: "PATCH",
    body: JSON.stringify(body),
  });

export const removeReportDigest = (orgId: string, digestId: string) =>
  call(wsPath(orgId, `/report-digests/${digestId}`), { method: "DELETE" });

// ─── settings: branding ──────────────────────────────────────────────────────

export const patchBranding = (
  orgId: string,
  body: { brandPrimaryColor?: string | null; brandAccentColor?: string | null },
) => call(wsPath(orgId, "/branding"), { method: "PATCH", body: JSON.stringify(body) });

export const setCustomDomain = (orgId: string, customDomain: string | null) =>
  call(wsPath(orgId, "/branding/custom-domain"), {
    method: "PUT",
    body: JSON.stringify({ customDomain }),
  });

export const verifyCustomDomain = (orgId: string) =>
  call(wsPath(orgId, "/branding/custom-domain/verify"), { method: "POST" });

/**
 * The three-step logo upload. A typed logo URL is never rendered anywhere in
 * this app — the only logos that exist are objects uploaded through this flow
 * and confirmed with the workspace's own objectKey.
 */
export async function uploadLogo(
  orgId: string,
  file: File,
): Promise<OpsResult<unknown>> {
  // Accepted types and size are the API's contract; enforced before the first
  // round trip so the operator learns immediately.
  const accepted = [
    "image/svg+xml",
    "image/png",
    "image/jpeg",
    "image/webp",
  ];
  if (!accepted.includes(file.type)) {
    return {
      ok: false,
      status: 400,
      error: { message: "Accepted logo formats: SVG, PNG, JPEG, WebP." },
    };
  }
  if (file.size > 256 * 1024) {
    return {
      ok: false,
      status: 400,
      error: { message: "A logo must be 256KB or smaller." },
    };
  }

  const step1 = await call<{ uploadUrl: string; objectKey: string }>(
    wsPath(orgId, "/branding/logo/upload"),
    {
      method: "POST",
      body: JSON.stringify({ contentType: file.type, byteSize: file.size }),
    },
  );
  if (!step1.ok) return step1;

  const put = await fetch(step1.data.uploadUrl, {
    method: "PUT",
    body: file,
    headers: { "content-type": file.type },
  });
  if (!put.ok) {
    return {
      ok: false,
      status: put.status,
      error: { message: "The logo could not be uploaded to storage." },
    };
  }

  // Step 3: confirm with the objectKey the API itself returned. The UI never
  // constructs or rewrites one: an objectKey outside this workspace's prefix
  // is rejected server-side.
  return call(wsPath(orgId, "/branding/logo/confirm"), {
    method: "POST",
    body: JSON.stringify({ objectKey: step1.data.objectKey }),
  });
}

// ─── settings: report mailbox ────────────────────────────────────────────────

export const setReportInbox = (
  orgId: string,
  body: { host: string; port: number; secure: boolean; username: string; password: string },
) => call(wsPath(orgId, "/report-inbox"), { method: "PUT", body: JSON.stringify(body) });

export const removeReportInbox = (orgId: string) =>
  call(wsPath(orgId, "/report-inbox"), { method: "DELETE" });

// ─── settings: SSO ───────────────────────────────────────────────────────────

export interface SsoCreateBody {
  label: string;
  protocol: "SAML" | "OIDC";
  issuer: string;
  entryPoint: string;
  clientId: string;
  clientSecret: string;
  idpCertificate?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  provisioning: "JIT" | "DISABLED";
  allowedEmailDomains: string[];
  defaultRole: "analyst" | "viewer" | "admin";
}

export const createSsoConnection = (orgId: string, body: SsoCreateBody) =>
  call(wsPath(orgId, "/sso-connections"), { method: "POST", body: JSON.stringify(body) });

export const removeSsoConnection = (orgId: string, connectionId: string) =>
  call(wsPath(orgId, `/sso-connections/${connectionId}`), { method: "DELETE" });

// ─── onboarding funnel (Phase 5) ─────────────────────────────────────────────

export const createClient = (
  orgId: string,
  body: { name: string; slug: string },
) =>
  call<{ id: string; name: string; slug: string }>(wsPath(orgId, "/clients"), {
    method: "POST",
    body: JSON.stringify(body),
  });

export const createDomain = (
  orgId: string,
  clientId: string,
  body: { name: string },
) =>
  call<{ id: string; name: string }>(
    wsPath(orgId, `/clients/${clientId}/domains`),
    { method: "POST", body: JSON.stringify(body) },
  );

/** Live DNS ownership lookup. PENDING is a normal propagation answer. */
export const verifyDomain = (orgId: string, domainId: string) =>
  call<VerifyDomainResult>(wsPath(orgId, `/domains/${domainId}/verify`), {
    method: "POST",
  });

// ─── report shares (Phase 5) ─────────────────────────────────────────────────

export const createReportShare = (
  orgId: string,
  body: {
    domainId: string;
    includeForensics: boolean;
    includeSources: boolean;
    expiresInDays?: number;
  },
) =>
  call<{ id: string; token: string; url: string; expiresAt: string }>(
    wsPath(orgId, "/report-shares"),
    { method: "POST", body: JSON.stringify(body) },
  );

export const revokeReportShare = (orgId: string, shareId: string) =>
  call<void>(wsPath(orgId, `/report-shares/${shareId}`), { method: "DELETE" });

// ─── settings: Slack (Phase 6) ───────────────────────────────────────────────

export const getSlackDestination = (orgId: string) =>
  call<SlackDestination | null>(wsPath(orgId, "/slack-destination"));

export const putSlackDestination = (
  orgId: string,
  body: { webhookUrl: string; channelLabel?: string | null },
) =>
  call<SlackDestination>(wsPath(orgId, "/slack-destination"), {
    method: "PUT",
    body: JSON.stringify(body),
  });

export const patchSlackDestinationEnabled = (orgId: string, enabled: boolean) =>
  call<void>(wsPath(orgId, "/slack-destination"), {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });

export const deleteSlackDestination = (orgId: string) =>
  call<void>(wsPath(orgId, "/slack-destination"), { method: "DELETE" });

// ─── settings: API keys (Phase 6) ────────────────────────────────────────────

export const createApiKeyClient = (
  orgId: string,
  body: { name: string; scopes: Array<"read" | "write">; expiresInDays?: number },
) =>
  call<IssuedApiKey>(wsPath(orgId, "/api-keys"), {
    method: "POST",
    body: JSON.stringify(body),
  });

export const revokeApiKeyClient = (orgId: string, keyId: string) =>
  call<void>(wsPath(orgId, `/api-keys/${keyId}`), { method: "DELETE" });

// ─── settings: export & erasure (Phase 6) ────────────────────────────────────

export const createExportJob = (
  orgId: string,
  body: { scope: "ORGANIZATION" | "CLIENT" | "DOMAIN"; targetId?: string; format: "JSON" | "CSV" },
) =>
  call<ExportJob>(wsPath(orgId, "/exports"), {
    method: "POST",
    body: JSON.stringify(body),
  });

export const revokeExportJob = (orgId: string, exportId: string) =>
  call<void>(wsPath(orgId, `/exports/${exportId}`), { method: "DELETE" });

export const requestErasureJob = (
  orgId: string,
  body: { scope: "ORGANIZATION" | "CLIENT" | "DOMAIN"; targetId?: string; reason?: string },
) =>
  call<ErasureCreated>(wsPath(orgId, "/erasures"), {
    method: "POST",
    body: JSON.stringify(body),
  });

export const cancelErasureJob = (orgId: string, erasureId: string) =>
  call<void>(wsPath(orgId, `/erasures/${erasureId}/cancel`), { method: "POST" });

export const pollInboxNow = (orgId: string) =>
  call<unknown>(wsPath(orgId, "/report-inbox/poll"), { method: "POST" });

// ─── sessions (account level) (Phase 7) ─────────────────────────────────────

export const revokeSession = (sessionId: string) =>
  call<void>(`/api/me/sessions/${sessionId}`, { method: "DELETE" });

/** The lost-laptop action: every other session, this one spared. */
export const revokeOtherSessions = () =>
  call(`/api/me/sessions/revoke-others`, { method: "POST" });

/** The deliberate nuke — INCLUDING this device. Confirm in the UI first. */
export const revokeAllSessions = () =>
  call<void>(`/api/me/sessions/revoke-all`, { method: "POST" });

// ─── compliance packs (Phase 7) ─────────────────────────────────────────────

/**
 * Issues a pack: the response IS the PDF and the fingerprint travels in its
 * headers. Returns both so the caller can present the SHA-256 as the primary
 * artefact and hand the PDF to the browser — the fingerprint is the claim that
 * goes in the email, the file is what it fingerprints.
 */
export async function issueCompliancePack(
  orgId: string,
  clientId: string,
): Promise<
  | { ok: true; data: { bytes: Blob; reference: string; sha256: string; filename: string } }
  | { ok: false; status: number; error: ApiErrorBody["error"] }
> {
  try {
    const res = await fetch(wsPath(orgId, `/clients/${clientId}/compliance-packs`), {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      const text = await res.text();
      const body = text ? (JSON.parse(text) as ApiErrorBody) : null;
      return {
        ok: false,
        status: res.status,
        error: body?.error ?? { message: `Request failed (${res.status})` },
      };
    }
    const disposition = res.headers.get("content-disposition") ?? "";
    const filenameMatch = disposition.match(/filename="([^"]+)"/);
    return {
      ok: true,
      data: {
        bytes: await res.blob(),
        reference: res.headers.get("x-dmarc-pack-reference") ?? "",
        sha256: res.headers.get("x-dmarc-pack-sha256") ?? "",
        filename: filenameMatch?.[1] ?? `dmarc-compliance-${Date.now()}.pdf`,
      },
    };
  } catch {
    return { ok: false, status: 0, error: { message: "The request could not be sent." } };
  }
}

// ─── billing ─────────────────────────────────────────────────────────────────

export const startCheckout = (
  orgId: string,
  body: {
    plan: string;
    interval: "monthly" | "annual";
    currency: "USD" | "INR";
    contact: { name: string; email: string; taxId?: string | null };
  },
) => call<{ url?: string; checkoutUrl?: string }>(
  wsPath(orgId, "/billing/checkout"),
  { method: "POST", body: JSON.stringify(body) },
);

export const changeBillingPlan = (
  orgId: string,
  body: { plan: string; interval?: "monthly" | "annual" },
) => call(wsPath(orgId, "/billing/plan"), { method: "PATCH", body: JSON.stringify(body) });

export const cancelSubscription = (orgId: string) =>
  call(wsPath(orgId, "/billing/cancel"), { method: "POST" });

export const resumeSubscription = (orgId: string) =>
  call(wsPath(orgId, "/billing/resume"), { method: "POST" });

export const openBillingPortal = (orgId: string) =>
  call<{ url: string }>(wsPath(orgId, "/billing/portal"), { method: "POST" });

/** PATCH /billing/currency — sets the currency a future checkout charges.
 *  Refused with CURRENCY_LOCKED (409) once a payment exists; the reason travels
 *  on the error and is shown as the explanation, never parsed from a message. */
export const setBillingCurrency = (orgId: string, currency: "USD" | "INR") =>
  call<BillingCurrencyPreference>(wsPath(orgId, "/billing/currency"), {
    method: "PATCH",
    body: JSON.stringify({ currency }),
  });
