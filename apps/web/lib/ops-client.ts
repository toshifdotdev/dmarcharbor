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
  DnsChangePage,
  DnsChangeRow,
  DnsConnectionRow,
  DnsPublishPreview,
  DnsPublishRecord,
  DnsPublishResult,
  DnsRestoreResult,
  DomainSwitchDetail,
  DomainSwitchView,
  ErasureCreated,
  ErasurePreview,
  ExportJob,
  HostedDmarcView,
  IssuedApiKey,
  MonthlyReportSchedule,
  PlanOverageRow,
  SenderReviewResult,
  PortalGrant,
  SlackDestination,
  SwitchCheckRow,
  SwitchKitImportResult,
  SwitchPlan,
  VerifyDomainResult,
} from "./types";
import { errorFromResponse, extractErrorCode, genericForStatus, networkUiError } from "./ui-errors";

export type OpsResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: ApiErrorBody["error"] };

async function call<T>(
  path: string,
  init?: RequestInit,
): Promise<OpsResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      credentials: "include",
    });
  } catch {
    // No response at all: the proxy is down, the build has no API to rewrite to,
    // or the network dropped. Saying "the request could not be sent" hid which.
    const network = networkUiError();
    return {
      ok: false,
      status: network.status,
      error: { code: "NETWORK", message: network.message },
    };
  }

  const raw = await res.text().catch(() => "");
  if (raw === "" && res.status >= 400) {
    // A body that could not be read at all: the status is what is left, and the
    // wording says the server did not explain itself rather than hiding the code.
    // An empty body on a 204 is normal, so only a failure reaches this.
    return {
      ok: false,
      status: res.status,
      error: { code: "BAD_RESPONSE", message: genericForStatus(res.status) },
    };
  }

  if (res.status === 204) return { ok: true, data: undefined as T };

  // The body is already in hand, so it is shaped directly rather than through
  // `readUiError`, which exists for a Response and would read the stream a
  // second time.
  const ui = errorFromResponse(res.status, raw);
  if (!res.ok) {
    // The API's own code and message both win, so a form can still route on
    // PLAN_LIMIT_REACHED or CONFLICT rather than matching on the wording.
    return {
      ok: false,
      status: ui.status,
      error: {
        code: extractErrorCode(raw) ?? String(res.status),
        message: ui.message,
        ...planKeys(raw),
        ...errorPreview(raw),
        ...conflictDetails(raw),
      },
    };
  }

  try {
    return { ok: true, data: (raw ? JSON.parse(raw) : null) as T };
  } catch {
    // A success with an unparseable body is a broken response, and its status
    // is the only honest thing to report.
    return {
      ok: false,
      status: res.status,
      error: { code: "BAD_RESPONSE", message: "The server sent a response we could not read." },
    };
  }
}

/**
 * The entitlement or quota key on a 402, wherever the API put it.
 *
 * The middleware spreads it onto the error (`error.feature`); the bulk import
 * nests it (`error.details.feature`). Dropping it meant every mutation 402
 * routed its upgrade prompt as "unknown". Keys only: the message is already
 * carried, and nothing is parsed out of a sentence.
 */
function planKeys(raw: string): Pick<ApiErrorBody["error"], "feature" | "quota" | "overage" | "from" | "to"> {
  try {
    const body = JSON.parse(raw) as {
      error?: {
        feature?: unknown;
        quota?: unknown;
        overage?: unknown;
        from?: unknown;
        to?: unknown;
        details?: { feature?: unknown; quota?: unknown };
      };
    };
    const e = body?.error;
    const feature = e?.feature ?? e?.details?.feature;
    const quota = e?.quota ?? e?.details?.quota;
    // A refused downgrade names its overage as rows (PLAN_CHANGE_OVER_QUOTA);
    // they are carried so the screen renders the numbers, never a paragraph.
    const overage = Array.isArray(e?.overage)
      ? (e.overage as PlanOverageRow[]).filter((r) => r && typeof r.used === "number" && typeof r.limit === "number")
      : undefined;
    return {
      ...(typeof feature === "string" ? { feature } : {}),
      ...(typeof quota === "string" ? { quota } : {}),
      ...(overage ? { overage } : {}),
      ...(typeof e?.from === "string" ? { from: e.from } : {}),
      ...(typeof e?.to === "string" ? { to: e.to } : {}),
    };
  } catch {
    return {};
  }
}

function errorPreview(raw: string): Pick<ApiErrorBody["error"], "preview"> {
  try {
    const body = JSON.parse(raw) as { preview?: DnsPublishPreview };
    return body?.preview ? { preview: body.preview } : {};
  } catch {
    return {};
  }
}

/** A hosted-DMARC 409 carries blockers or the current view at the top level. */
function conflictDetails(raw: string): Pick<ApiErrorBody["error"], "blockers" | "view"> {
  try {
    const body = JSON.parse(raw) as { blockers?: unknown; view?: unknown };
    return {
      ...(Array.isArray(body.blockers)
        ? { blockers: body.blockers.filter((entry): entry is string => typeof entry === "string") }
        : {}),
      ...(body.view && typeof body.view === "object" ? { view: body.view as HostedDmarcView } : {}),
    };
  } catch {
    return {};
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

/** DELETE /portal-access/:id/permanent — remove a REVOKED grant's row.
 *
 *  A separate act from revoking, and the API refuses it while the grant is still
 *  active. Revoking is what ends access; this is clearing the residue afterwards,
 *  so the contact's address is not held forever with no remaining purpose. */
export const deletePortalAccessRecord = (orgId: string, accessId: string) =>
  call<void>(wsPath(orgId, `/portal-access/${accessId}/permanent`), { method: "DELETE" });

/** DELETE /portal-access/revoked — every revoked grant in the workspace, gone.
 *  Answers with how many it actually removed, because "nothing to clean up" and
 *  "cleaned up" are different outcomes and the caller must not have to guess. */
export const deleteAllRevokedPortalAccess = (orgId: string) =>
  call<{ removed: number }>(wsPath(orgId, "/portal-access/revoked"), { method: "DELETE" });

/** DELETE /report-shares/:id/permanent — remove a REVOKED share link's row.
 *  Refused by the API while the link is still live. */
export const deleteReportShareRecord = (orgId: string, shareId: string) =>
  call<void>(wsPath(orgId, `/report-shares/${shareId}/permanent`), { method: "DELETE" });

/** DELETE /report-shares/revoked — every revoked share link, gone, with a count. */
export const deleteAllRevokedReportShares = (orgId: string) =>
  call<{ removed: number }>(wsPath(orgId, "/report-shares/revoked"), { method: "DELETE" });

/** DELETE /api-keys/:id/permanent — remove a REVOKED key's row. */
export const deleteApiKeyRecord = (orgId: string, keyId: string) =>
  call<void>(wsPath(orgId, `/api-keys/${keyId}/permanent`), { method: "DELETE" });

/** DELETE /api-keys/revoked — every revoked key, gone, with a count. */
export const deleteAllRevokedApiKeys = (orgId: string) =>
  call<{ removed: number }>(wsPath(orgId, "/api-keys/revoked"), { method: "DELETE" });

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

/**
 * Saves the two brand colours.
 *
 * The read side and the write side spell these differently, and the write side is
 * the one that matters: `brandingSchema` accepts `primaryColor` and `accentColor`
 * (branding.controller.ts:16-20), while the workspace row and the settings screen
 * call them `brandPrimaryColor` and `brandAccentColor`. zod strips unknown keys
 * rather than rejecting them, so passing the read-side names validated as an empty
 * object, Prisma wrote nothing, and the route answered 200 - so the screen
 * reported "Brand colours saved." and changed nothing on every plan. The mapping
 * lives here, at the transport, so no caller has to know the two disagree.
 */
export const patchBranding = (
  orgId: string,
  body: { brandPrimaryColor?: string | null; brandAccentColor?: string | null; logoUrl?: null },
) =>
  call(wsPath(orgId, "/branding"), {
    method: "PATCH",
    body: JSON.stringify({
      ...(body.brandPrimaryColor === undefined ? {} : { primaryColor: body.brandPrimaryColor }),
      ...(body.brandAccentColor === undefined ? {} : { accentColor: body.brandAccentColor }),
      // Only ever cleared from here: a logo is set by upload, never by URL.
      ...(body.logoUrl === null ? { logoUrl: null } : {}),
    }),
  });

/**
 * Claims a custom domain.
 *
 * The response carries the TXT record the operator has to publish, which is the
 * only time it is ever available: `setCustomDomain` generates a fresh random
 * token on every call, so after this response neither the host nor the value can
 * be shown again. Typing this as `unknown` and discarding the body meant the
 * branding screen said "publish the TXT record at your DNS provider" without
 * saying which record, which is a control that cannot be used.
 */
export interface CustomDomainInstructions {
  customDomain: string | null;
  /** The host to create, e.g. `_dmarc-harbor-branding.reports.acme.test`. */
  verificationHost: string | null;
  /** The TXT value, e.g. `dmarc-harbor-branding=<token>`. */
  verificationValue: string | null;
  /** Human-readable guidance from the API, shown alongside the record. */
  notice: string | null;
}

export const setCustomDomain = (orgId: string, customDomain: string | null) =>
  call<CustomDomainInstructions>(wsPath(orgId, "/branding/custom-domain"), {
    method: "PUT",
    body: JSON.stringify({ customDomain }),
  });

/**
 * Re-reads the TXT record.
 *
 * `verified` is a boolean in its own right, not implied by the status code: a 200
 * can mean the record was found, or that it is missing, or that the lookup timed
 * out, and `lookupStatus` is what tells those apart. Reading only `res.ok` let
 * this print "the custom domain is live" on a hostname that resolves to
 * nothing.
 */
export interface CustomDomainVerification {
  verified: boolean;
  lookupStatus: string;
  error?: string;
}

export const verifyCustomDomain = (orgId: string) =>
  call<CustomDomainVerification>(wsPath(orgId, "/branding/custom-domain/verify"), {
    method: "POST",
  });

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

  /**
   * The bytes go to OUR origin, not straight to storage.
   *
   * That was not the first design: the browser used to PUT to a presigned S3
   * URL, which made a 200KB upload depend on a preflight, a signature, and
   * headers the browser alone controls. One browser did it; a second returned a
   * bare "Failed to fetch" against a URL that worked from curl every time, and
   * the server logged nothing because the request never arrived. Same-origin
   * removes the whole category.
   *
   * Guarded: a network failure rejects with no status and no body, and an
   * unhandled rejection took the whole page down instead of printing why.
   */
  try {
    return await call<{ objectKey: string; logoUrl: string }>(
      wsPath(orgId, "/branding/logo/store"),
      {
        method: "POST",
        body: file,
        // The type travels as a header, not as multipart metadata: the payload
        // is the raw file, so there is no envelope to carry it in.
        headers: { "content-type": file.type },
      },
    );
  } catch {
    return {
      ok: false,
      status: 0,
      error: { message: "The logo could not be sent to the server. Check the connection and try again." },
    };
  }
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

/** PATCH a connection: on/off, label, who may join and as what. The provider
 *  details are not editable; a corrected provider is a new connection. */
export const updateSsoConnection = (
  orgId: string,
  connectionId: string,
  body: Partial<Pick<SsoCreateBody, "label" | "allowedEmailDomains" | "provisioning" | "defaultRole">> & { enabled?: boolean },
) =>
  call<unknown>(wsPath(orgId, `/sso-connections/${connectionId}`), { method: "PATCH", body: JSON.stringify(body) });

export const removeSsoConnection = (orgId: string, connectionId: string) =>
  call(wsPath(orgId, `/sso-connections/${connectionId}`), { method: "DELETE" });

// ─── members and invitations (Better Auth organization plugin) ──────────────
//
// The API adds no routes of its own for these: the organization plugin serves
// them under /api/auth/organization, with its own permission checks (owner
// and admin for member and invitation actions). Inviting emails the address a
// link to /welcome (sendInvitationEmail in the API's auth.config.ts), where the
// invitation is listed (list-user-invitations) with Join and Decline. Joining
// through the workspace's SSO connection also accepts it on the way in.

const orgCall = <T>(path: string, body: unknown) =>
  call<T>(`/api/auth/organization/${path}`, { method: "POST", body: JSON.stringify(body) });

export const inviteMember = (orgId: string, email: string, role: "admin" | "analyst" | "viewer") =>
  orgCall<{ id: string; email: string; role: string; expiresAt?: string }>("invite-member", {
    organizationId: orgId,
    email,
    role,
  });

export const cancelInvitation = (orgId: string, invitationId: string) =>
  orgCall<unknown>("cancel-invitation", { organizationId: orgId, invitationId });

export const updateMemberRole = (orgId: string, memberId: string, role: string) =>
  orgCall<unknown>("update-member-role", { organizationId: orgId, memberId, role });

export const removeMember = (orgId: string, memberId: string) =>
  orgCall<unknown>("remove-member", { organizationId: orgId, memberIdOrEmail: memberId });

/** Owner-only: removes the member's authenticator, backup codes and sessions. */
export const resetMemberMfa = (orgId: string, memberId: string) =>
  call<{ status: boolean }>(wsPath(orgId, `/members/${memberId}/mfa/reset`), { method: "POST" });

/** Owner-only: turns the workspace two-step requirement on or off. */
export const setWorkspaceMfaRequirement = (orgId: string, requireMfa: boolean) =>
  call<{ requireMfa: boolean; membersWithout: number }>(wsPath(orgId, "/security"), {
    method: "PUT",
    body: JSON.stringify({ requireMfa }),
  });

/** Invitations addressed to the signed-in person, from any workspace. */
export interface InvitationForMe {
  id: string;
  organizationId: string;
  organizationName?: string;
  email: string;
  role: string;
  status: string;
  expiresAt?: string;
}

export const acceptInvitation = (invitationId: string) => orgCall<unknown>("accept-invitation", { invitationId });

export const rejectInvitation = (invitationId: string) => orgCall<unknown>("reject-invitation", { invitationId });

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
    // `slug` comes back so the "Domain added" link can carry the URL identifier
    // rather than the cuid. It is the same field the list endpoints return.
    call<{ id: string; slug: string; name: string }>(

wsPath(orgId, `/clients/${clientId}/domains`),
      { method: "POST", body: JSON.stringify(body) },
    );

/** One row of a bulk import that did not create a domain. */
export interface BulkDomainFailure {
  index: number;
  name: string;
  reason: string;
}

/** A domain a bulk import created, with what has to be published to verify it. */
export interface BulkDomainCreated {
  index: number;
  domainId: string;
  slug: string;
  name: string;
  clientId: string;
  verificationHost: string;
  verificationValue: string;
}

export interface BulkDomainResult {
  created: number;
  failed: number;
  planBlocked: number;
  domains: BulkDomainCreated[];
  failures: BulkDomainFailure[];
  planLimitRejections: BulkDomainFailure[];
  limits: { maxDomains: number };
}

/**
 * Adds many domains to a client at once.
 *
 * The three verdict lists stay separate all the way to the screen: a duplicate is
 * a line the operator can delete from the list, a plan-blocked row needs a plan
 * change, and collapsing them into one "some failed" count is what makes a bulk
 * import feel like it did not work.
 */
export const bulkCreateDomains = (
  orgId: string,
  clientId: string,
  domains: string[],
) =>
  call<BulkDomainResult>(wsPath(orgId, `/clients/${clientId}/domains/bulk`), {
    method: "POST",
    body: JSON.stringify({ domains }),
  });

/** Live DNS ownership lookup. PENDING is a normal propagation answer. */
export const verifyDomain = (orgId: string, domainId: string) =>
  call<VerifyDomainResult>(wsPath(orgId, `/domains/${domainId}/verify`), {
    method: "POST",
  });

// ─── provider switch ─────────────────────────────────────────────────────────

/** POST /clients/:id/switch-kit — create domains and plan each switch. */
export const importSwitchKit = (
  orgId: string,
  clientId: string,
  domains: string[],
) =>
  call<SwitchKitImportResult>(
    wsPath(orgId, `/clients/${clientId}/switch-kit`),
    { method: "POST", body: JSON.stringify({ domains }) },
  );

/** POST /domains/:id/switch — plan one existing domain. NO_INCUMBENT and
 *  SWITCH_IN_PROGRESS are the two refusals the screen explains as states. */
export const startDomainSwitch = (orgId: string, domainId: string) =>
  call<{ switch: DomainSwitchDetail; plan: SwitchPlan }>(
    wsPath(orgId, `/domains/${domainId}/switch`),
    { method: "POST" },
  );

/** POST /domains/:id/switch/check — read DNS and move the state. */
export const checkDomainSwitch = (orgId: string, domainId: string) =>
  call<DomainSwitchView>(wsPath(orgId, `/domains/${domainId}/switch/check`), {
    method: "POST",
  });

/** POST /clients/:id/switch-kit/check — every switch in the client. */
export const checkClientSwitches = (orgId: string, clientId: string) =>
  call<{ results: SwitchCheckRow[] }>(
    wsPath(orgId, `/clients/${clientId}/switch-kit/check`),
    { method: "POST" },
  );

/** DELETE /domains/:id/switch — stop the switch. Never touches the domain. */
export const stopDomainSwitch = (orgId: string, domainId: string) =>
  call<void>(wsPath(orgId, `/domains/${domainId}/switch`), { method: "DELETE" });

// ─── DNS monitoring ──────────────────────────────────────────────────────────

/** GET /domains/:id/dns-changes — paginated change history, optionally filtered. */
export const listDnsChanges = (
  orgId: string,
  domainId: string,
  options: { cursor?: string; severity?: string[] } = {},
) => {
  const query = new URLSearchParams({ limit: "50" });
  if (options.cursor) query.set("cursor", options.cursor);
  for (const severity of options.severity ?? []) query.append("severity", severity);
  return call<DnsChangePage>(wsPath(orgId, `/domains/${domainId}/dns-changes?${query.toString()}`));
};

/** POST /domains/:id/dns-changes/:changeId/acknowledge — idempotent. */
export const acknowledgeDnsChange = (orgId: string, domainId: string, changeId: string) =>
  call<DnsChangeRow>(
    wsPath(orgId, `/domains/${domainId}/dns-changes/${changeId}/acknowledge`),
    { method: "POST" },
  );

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

/**
 * The API's own preview of what an erasure of this scope would do.
 *
 * The page only ever asks for ORGANIZATION, which was fine while the form had
 * one option. It now offers one client as well, so the preview is fetched per
 * scope: the counts under "What a request would do" have to describe the scope
 * that is about to be submitted.
 */
export const previewErasure = (
  orgId: string,
  scope: "ORGANIZATION" | "CLIENT" | "DOMAIN",
  targetId?: string,
) => {
  const query = new URLSearchParams({ scope });
  if (targetId) query.set("targetId", targetId);
  return call<ErasurePreview>(
    `${wsPath(orgId, "/erasures/preview")}?${query.toString()}`,
  );
};

/**
 * The poll outcome, not an opaque value.
 *
 * The mailbox page reports how many messages were read, how many were new, how
 * many were already seen and how many were for domains nobody monitors. Typed as
 * `unknown` all of that became a cast at the call site, which is the drift this
 * file exists to prevent.
 */
export interface InboxPollOutcome {
  messages: number;
  accepted: number;
  duplicates: number;
  unmatched: number;
}

export const pollInboxNow = (orgId: string) =>
  call<InboxPollOutcome>(wsPath(orgId, "/report-inbox/poll"), { method: "POST" });

// ─── sessions (account level) (Phase 7) ─────────────────────────────────────

export const revokeSession = (sessionId: string) =>
  call<void>(`/api/me/sessions/${sessionId}`, { method: "DELETE" });

/** The lost-laptop action: every other session, this one spared. */
export const revokeOtherSessions = () =>
  call<{ remaining: number }>(`/api/me/sessions/revoke-others`, { method: "POST" });

/** The deliberate nuke — INCLUDING this device. Confirm in the UI first. */
export const revokeAllSessions = () =>
  call<void>(`/api/me/sessions/revoke-all`, { method: "POST" });

// ─── sender intelligence ─────────────────────────────────────────────────────

export const reviewSender = (
  orgId: string,
  domainId: string,
  body: {
    senderKey: string;
    status: "APPROVED" | "NOT_OURS" | "UNREVIEWED";
    note?: string | null;
  },
) =>
  call<SenderReviewResult>(wsPath(orgId, `/domains/${domainId}/senders/review`), {
    method: "PUT",
    body: JSON.stringify(body),
  });

export const setSenderOwner = (
  orgId: string,
  domainId: string,
  body: { senderKey: string; ownerUserId: string | null },
) =>
  call<SenderReviewResult>(wsPath(orgId, `/domains/${domainId}/senders/owner`), {
    method: "PUT",
    body: JSON.stringify(body),
  });

// ─── monthly evidence reports ────────────────────────────────────────────────

/**
 * POST /clients/:clientId/monthly-reports — the response is the PDF.
 *
 * Mirrors the compliance pack's issue call: the bytes, the reference and the
 * fingerprint all arrive in one response, so the screen can hand the file to
 * the browser and show what was issued without a second request.
 */
export async function issueMonthlyReport(
  orgId: string,
  clientId: string,
  period: string,
): Promise<
  | { ok: true; data: { bytes: Blob; reference: string; sha256: string; filename: string } }
  | { ok: false; status: number; error: ApiErrorBody["error"] }
> {
  try {
    const res = await fetch(wsPath(orgId, `/clients/${clientId}/monthly-reports`), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ period }),
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      const ui = errorFromResponse(res.status, raw);
      const code = extractErrorCode(raw) ?? String(res.status);
      return { ok: false, status: ui.status, error: { code, message: ui.message } };
    }
    const disposition = res.headers.get('content-disposition') ?? '';
    const filenameMatch = disposition.match(/filename="([^"]+)"/);
    return {
      ok: true,
      data: {
        bytes: await res.blob(),
        reference: res.headers.get('x-dmarc-pack-reference') ?? '',
        sha256: res.headers.get('x-dmarc-pack-sha256') ?? '',
        filename: filenameMatch?.[1] ?? `dmarc-report-${period}.pdf`,
      },
    };
  } catch {
    const network = networkUiError();
    return { ok: false, status: network.status, error: { code: 'NETWORK', message: network.message } };
  }
}

export const saveMonthlyReportSchedule = (
  orgId: string,
  clientId: string,
  body: {
    enabled: boolean;
    dayOfMonth: number;
    sendHourUtc: number;
    recipientEmails: string[];
  },
) =>
  call<{ schedule: MonthlyReportSchedule }>(
    wsPath(orgId, `/clients/${clientId}/monthly-report-schedule`),
    { method: 'PUT', body: JSON.stringify(body) },
  );

export const deleteMonthlyReportSchedule = (orgId: string, clientId: string) =>
  call<void>(wsPath(orgId, `/clients/${clientId}/monthly-report-schedule`), { method: 'DELETE' });

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
      // Read once, shaped once. A Response body is a stream and a second read
      // throws, which is how the previous version produced "the request could
      // not be sent" for a refusal the API had explained perfectly.
      const raw = await res.text().catch(() => "");
      const ui = errorFromResponse(res.status, raw);
      // The code is the API's own when it sent one, and only falls back to the
      // status. The fallback is a string, because `error.code` is typed as one
      // and a number there failed the build.
      const code = extractErrorCode(raw) ?? String(res.status);
      return { ok: false, status: ui.status, error: { code, message: ui.message } };
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
    const network = networkUiError();
    return { ok: false, status: network.status, error: { code: "NETWORK", message: network.message } };
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
) =>
  call<{
    url?: string;
    checkoutUrl?: string;
    priceLabel?: string;
    priceMinor?: number;
    unitPriceMinor?: number;
    quantity?: number;
    currency?: string;
  }>(wsPath(orgId, "/billing/checkout"), {
    method: "POST",
    body: JSON.stringify(body),
  });

/** PATCH /billing/plan. MOORING is a cancellation at period end and answers
 *  `cancelling`; otherwise `applied` when the provider moved the plan at once
 *  (Paddle) or `scheduled` when it moves at period end (Razorpay). */
export const changeBillingPlan = (
  orgId: string,
  body: { plan: string; interval?: "monthly" | "annual" },
) =>
  call<{ status: "scheduled" | "applied" | "cancelling"; effectiveAt: string; effectiveDate?: string | null }>(wsPath(orgId, "/billing/plan"), {
    method: "PATCH",
    body: JSON.stringify(body),
  });

/** POST /billing/cancel. Access runs until `accessUntil`, the paid period's end. */
export const cancelSubscription = (orgId: string) =>
  call<{ status: "cancelling"; accessUntil: string | null }>(wsPath(orgId, "/billing/cancel"), { method: "POST" });

export const resumeSubscription = (orgId: string) =>
  call<{ status: "active" }>(wsPath(orgId, "/billing/resume"), { method: "POST" });

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

// ─── deletion ────────────────────────────────────────────────────────────────

/**
 * What a delete destroys.
 *
 * The API returns this with the deletion result and from the preview endpoint,
 * so the confirmation a person sees before pressing delete is the same set of
 * numbers the server reports after. They cannot disagree.
 */
export interface DeletionSummary {
  domains: number;
  dmarcReports: number;
  forensicReports: number;
  alertRules: number;
  alertEvents: number;
  reportDigests: number;
  scans: number;
  reportShares: number;
  portalAccessGrants: number;
  compliancePacks: number;
}

/** A deletion, plus what went with it. */
export interface DeletionResult {
  deleted: string;
  summary: DeletionSummary;
}

/**
 * Reads what deleting a workspace would destroy, before anything is deleted.
 *
 * Exists so the confirmation can say "3 domains, 14 reports, 2 share links"
 * rather than "are you sure?". A preview that cannot be read is a confirmation
 * that asks the operator to trust a guess.
 */
export interface HostedDeletionPreview {
  domain: string;
  republish: { host: string; type: "TXT"; value: string };
}

export const previewWorkspaceDeletion = (orgId: string, clientId?: string) =>
  call<{ summary: DeletionSummary; hostedDmarc: HostedDeletionPreview[] }>(
    wsPath(orgId, `/deletion-preview${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ""}`),
  );

export const deleteDomain = (orgId: string, domainId: string) =>
  call<DeletionResult>(wsPath(orgId, `/domains/${domainId}`), { method: "DELETE" });

export const deleteClient = (orgId: string, clientId: string) =>
  call<DeletionResult>(wsPath(orgId, `/clients/${clientId}`), { method: "DELETE" });

export const deleteWorkspace = (orgId: string) =>
  call<DeletionResult>(wsPath(orgId, ""), { method: "DELETE" });

// ─── Cloudflare DNS publishing ───────────────────────────────────────────────

export const createDnsConnection = (
  orgId: string,
  body: { provider: "CLOUDFLARE"; token: string; label?: string | null },
) =>
  call<DnsConnectionRow>(wsPath(orgId, "/dns-connections"), {
    method: "POST",
    body: JSON.stringify(body),
  });

export const deleteDnsConnection = (orgId: string, connectionId: string) =>
  call<void>(wsPath(orgId, `/dns-connections/${connectionId}`), { method: "DELETE" });

export const previewDnsRecord = (
  orgId: string,
  domainId: string,
  body: { connectionId: string; record: DnsPublishRecord },
) =>
  call<DnsPublishPreview>(wsPath(orgId, `/domains/${domainId}/dns-publish/preview`), {
    method: "POST",
    body: JSON.stringify(body),
  });

export const publishDnsRecord = (
  orgId: string,
  domainId: string,
  body: { connectionId: string; record: DnsPublishRecord; expectedFingerprint: string },
) =>
  call<DnsPublishResult>(wsPath(orgId, `/domains/${domainId}/dns-publish`), {
    method: "POST",
    body: JSON.stringify(body),
  });

export const restoreDnsPublication = (orgId: string, publicationId: string) =>
  call<DnsRestoreResult>(wsPath(orgId, `/dns-publications/${publicationId}/restore`), { method: "POST" });

// ─── hosted DMARC records ────────────────────────────────────────────────────

const hostedPath = (orgId: string, domainId: string) =>
  wsPath(orgId, `/domains/${domainId}/hosted-dmarc`);

export const startHostedDmarc = (orgId: string, domainId: string) =>
  call<HostedDmarcView>(hostedPath(orgId, domainId), { method: "POST" });

export const checkHostedDmarc = (orgId: string, domainId: string) =>
  call<HostedDmarcView>(`${hostedPath(orgId, domainId)}/check`, { method: "POST" });

export const updateHostedDmarc = (
  orgId: string,
  domainId: string,
  body: {
    expectedVersion: number;
    policy: "none" | "quarantine" | "reject";
    testing: boolean;
    np: "none" | "quarantine" | "reject" | null;
    override?: boolean;
  },
) =>
  call<HostedDmarcView & { action?: "updated" | "unchanged" }>(hostedPath(orgId, domainId), {
    method: "PUT",
    body: JSON.stringify(body),
  });

export const restoreHostedDmarc = (
  orgId: string,
  domainId: string,
  changeId: string,
  expectedVersion: number,
) =>
  call<HostedDmarcView>(`${hostedPath(orgId, domainId)}/changes/${changeId}/restore`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion }),
  });

export const releaseHostedDmarc = (orgId: string, domainId: string) =>
  call<HostedDmarcView>(`${hostedPath(orgId, domainId)}/release`, { method: "POST" });
