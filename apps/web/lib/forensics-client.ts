/**
 * forensics-client.ts — the browser-side forensic calls.
 *
 * It lives beside ops-client.ts rather than inside it for the reason
 * webhooks-client.ts gives: these are the calls that destroy evidence, and the
 * file they live in should say so before a reader sees a signature that takes a
 * whole domain's forensic history with it. Everything here is a write except
 * `fetchForensicReport`, which is here so a single report can be opened without
 * a second server round trip for the whole page.
 *
 * Two transport notes, both about the same split:
 *
 *  - api-ops.ts is the SERVER transport: it forwards the session cookie out of
 *    next/headers. This module is the BROWSER transport: same-origin requests
 *    that keep the cookie first-party through the rewrite in next.config.ts.
 *    Same routes, different plumbing, and only one fetch implementation each:
 *    `opsCall` is the browser one, imported rather than reimplemented.
 *  - Every call returns the same OpsResult discriminated union, so a 402 still
 *    routes by its `feature` key (reports.forensicNamed) instead of by matching
 *    a message.
 *
 * NOTHING HERE INVENTS A CONTRACT. Three of these routes refuse in ways the UI
 * has to read rather than guess at:
 *
 *  - PATCH identities answers 400 legal_basis_required when named recipients are
 *    switched on without confirmLegalBasis, because retaining them is personal
 *    data.
 *  - The same route answers 400 purge_confirmation_required, carrying
 *    `requiresNamePurgeConfirmation`, when a purge is asked for without
 *    confirmNamePurge. That flag is how the UI offers the confirmation instead
 *    of quoting an error at somebody who has already been warned.
 *  - POST refuses with 409 forensics_not_enabled or ruf_not_configured, which are
 *    setup answers rather than errors: the domain has not opted in, or it
 *    publishes no ruf= address for reports to arrive at.
 */

import { opsCall, type OpsResult } from "./ops-client";
import type {
  ForensicCollectionSettings,
  ForensicIdentitySettings,
  ForensicIngestResult,
  ForensicPurgeResult,
  ForensicReportRow,
} from "./types";

const wsPath = (orgId: string, tail: string) => `/api/workspaces/${orgId}${tail}`;

/**
 * PATCH /domains/:domainId/forensics — the collection opt in.
 *
 * Turning this OFF stops new forensic reports being collected. It deletes
 * nothing: reports already stored stay stored, with their pseudonyms and, where
 * they were retained, their identities. That asymmetry is the reason this is a
 * plain button and not a ConfirmAction: the destructive version of this setting
 * is the identity mapping, which is a separate route and is confirmed twice.
 *
 * The response repeats the retention windows and whether a ruf= address is
 * actually published, because "collection is on" and "reports will arrive" are
 * different claims and only the second one depends on DNS.
 */
export const setForensicCollection = (
  orgId: string,
  domainId: string,
  collectForensicReports: boolean,
): Promise<OpsResult<ForensicCollectionSettings>> =>
  opsCall<ForensicCollectionSettings>(
    wsPath(orgId, `/domains/${domainId}/forensics`),
    { method: "PATCH", body: JSON.stringify({ collectForensicReports }) },
  );

/**
 * PATCH /domains/:domainId/forensics/identities — retain named recipients or
 * stop, on the paid reports.forensicNamed entitlement.
 *
 * `confirmLegalBasis` is required to turn identities ON. `confirmNamePurge` is
 * required to turn them OFF while they are on, and that call is what destroys
 * the stored recipient addresses, subject lines and envelope senders for every
 * report of this domain. Both flags are passed explicitly from the UI rather
 * than defaulted, so what was confirmed is exactly what was sent.
 */
export const setForensicIdentityRetention = (
  orgId: string,
  domainId: string,
  body: {
    retainForensicPii: boolean;
    confirmLegalBasis: boolean;
    confirmNamePurge: boolean;
  },
): Promise<OpsResult<ForensicIdentitySettings>> =>
  opsCall<ForensicIdentitySettings>(
    wsPath(orgId, `/domains/${domainId}/forensics/identities`),
    { method: "PATCH", body: JSON.stringify(body) },
  );

/**
 * POST /domains/:domainId/forensics — store one raw forensic report email.
 *
 * This ADDS evidence rather than removing it, and it is the only way to put a
 * report in the store without a real reporter sending one. The body is the raw
 * RFC822 message exactly as a reporter would have delivered it; the parser
 * decides everything else, and a message it cannot read comes back as a 400
 * carrying the parser's own reason.
 *
 * A repeat delivery of the same message is not an error: the API fingerprints
 * the report and answers 200 with `duplicate: true` and the row already stored,
 * so the UI reports which of the two happened instead of claiming a new one.
 */
export const ingestForensicReport = (
  orgId: string,
  domainId: string,
  rawEmail: string,
): Promise<OpsResult<ForensicIngestResult>> =>
  opsCall<ForensicIngestResult>(wsPath(orgId, `/domains/${domainId}/forensics`), {
    method: "POST",
    body: JSON.stringify({ rawEmail }),
  });

/**
 * DELETE /domains/:domainId/forensics — every forensic report for one domain.
 *
 * Irreversible, and it takes the pseudonyms with the identities. There is no
 * grace period and no undo: the rows are deleted, the evidence is gone, and the
 * audit trail records that somebody did it. `deleted` is the count, so the
 * result can say how much was destroyed rather than "done".
 */
export const purgeDomainForensics = (
  orgId: string,
  domainId: string,
): Promise<OpsResult<ForensicPurgeResult>> =>
  opsCall<ForensicPurgeResult>(
    wsPath(orgId, `/domains/${domainId}/forensics`),
    { method: "DELETE" },
  );

/**
 * DELETE /forensics/:forensicId — one report. 204, so there is no body to read
 * and the UI learns it worked from the status alone.
 */
export const deleteForensicReport = (
  orgId: string,
  forensicId: string,
): Promise<OpsResult<void>> =>
  opsCall<void>(wsPath(orgId, `/forensics/${forensicId}`), { method: "DELETE" });

/**
 * GET /forensics/:forensicId, in the browser.
 *
 * Read on demand rather than rendered from the list row, for one honest reason:
 * whether identities come back depends on the caller's role, and this call
 * answers that question for this caller. A list row rendered for somebody who
 * can read identities would leak them into a page somebody else can open.
 */
export const fetchForensicReport = (
  orgId: string,
  forensicId: string,
): Promise<OpsResult<ForensicReportRow>> =>
  opsCall<ForensicReportRow>(wsPath(orgId, `/forensics/${forensicId}`));