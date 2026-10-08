/**
 * scans-client.ts — the browser side of the domain scan endpoints.
 *
 * Split from api-ops.ts for the same reason webhooks-client.ts is split from
 * ops-client.ts: these are server reads in one file and browser writes in this
 * one, and a component must never reach for the wrong transport. `opsCall` is
 * imported, not reimplemented, so there is still exactly one browser fetch
 * wrapper in the app.
 *
 * The 502 IS THE INTERESTING CASE.
 *
 * createDomainScanController answers 502 when the scan ran and failed, and it
 * puts the FAILED row in the body beside the error. `opsCall` returns the error
 * and drops the row, which is the right default for every other call and is
 * wrong to lose here: the failed scan is still a scan somebody asked for, and it
 * belongs in the history. So the caller refreshes on 502 rather than treating it
 * as "nothing happened".
 *
 * No entitlement is applied here. domain-scan.routes.ts has no requireFeature on
 * any of its three routes and the plan catalog has no scan key, so the only
 * gate is the caller's domain:update permission, which the API owns.
 */

import { opsCall, type OpsResult } from "./ops-client";
import type { ScanRow } from "./types";

const wsPath = (orgId: string, tail: string) => `/api/workspaces/${orgId}${tail}`;

/**
 * POST /domains/:domainId/scans — runs the authenticated DNS scan now.
 *
 * Synchronous, so a success carries the finished scan: status COMPLETED, a
 * score, and the full result. The domain row has already been rewritten from it
 * by the time this resolves, which is what makes `domain.dmarcPolicy` real for
 * the first time on a domain that had never been scanned.
 *
 * Refusals worth naming: 409 when the domain is not VERIFIED (there is nothing
 * to scan against an unverified ownership check), 429 at twenty a minute from
 * scanRateLimiter, 502 when the lookups ran and failed.
 */
export const runDomainScan = (
  orgId: string,
  domainId: string,
): Promise<OpsResult<ScanRow>> =>
  opsCall<ScanRow>(wsPath(orgId, `/domains/${domainId}/scans`), { method: "POST" });

/**
 * GET /scans/:scanId — one scan's full result, loaded when a row is opened
 * rather than rendered for every row of the history. The list already carries
 * the result, but the history is the screen a person scrolls, and a DNS dump per
 * row turns it into a wall.
 */
export const fetchDomainScan = (
  orgId: string,
  scanId: string,
): Promise<OpsResult<ScanRow>> =>
  opsCall<ScanRow>(wsPath(orgId, `/scans/${scanId}`));