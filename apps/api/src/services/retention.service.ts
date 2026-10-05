import { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';

/**
 * Retention for the tables that hold customer data and had no sweeper.
 *
 * Reports and forensic reports have always had one, and Phase 4 made the service
 * publish those windows instead of quoting a plan figure. These four did not:
 *
 * - `ExportJob` is a customer's entire dataset in one row, with `purgeAfter`
 *   already stamped on it at seven days and an index on `(state, purgeAfter)` built
 *   for a query that was never made. It was the largest concentration of personal
 *   data in the service and it was kept for ever.
 * - `IdempotencyRecord` stores the whole response body, which for a checkout call
 *   contains client ids and DNS verification values.
 * - `SsoAuthRequest` holds a PKCE verifier and a RelayState. Consumed requests are
 *   removed at the callback, but a user who abandons the flow at the identity
 *   provider leaves a row nothing collects.
 * - `BillingEvent.payload` is the provider's raw body, which carries the
 *   customer's name and email.
 *
 * Deliberately not swept:
 *
 * - `AuditLog`. It is the evidence that an erasure happened, so it is retained
 *   indefinitely and the compliance pack now says so rather than implying a window
 *   nobody enforces.
 * - `ErasureRequest`. `purgeAfter` on that row is the *execution* date, not a
 *   retention deadline, and the certificate on it is the proof a regulator asks for
 *   years later.
 * - `ReportShare`. The token is checked against `expiresAt` on every read, so an
 *   expired share is already unusable; the row carries no personal data beyond a
 *   view count.
 */
export interface RetentionSweep {
  exportJobs: number;
  idempotencyRecords: number;
  ssoAuthRequests: number;
  billingPayloads: number;
}

function hoursAgo(hours: number, now: Date): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

function daysAgo(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Removes or empties everything past its window.
 *
 * Each step is independent and batched, so one slow delete cannot starve the rest
 * and a partial run still makes progress. Every window is indexed, which is the
 * reason the `(state, purgeAfter)` and `(createdAt)` indexes existed before
 * anything read them.
 */
export async function purgeExpiredData(now: Date = new Date()): Promise<RetentionSweep> {
  // Exports first. The whole dataset, and the row is disposable once the download
  // window has passed because the link stops working at the same time.
  const exportJobs = await prisma.exportJob.deleteMany({
    where: { purgeAfter: { lte: now } },
  });

  const idempotencyRecords = await prisma.idempotencyRecord.deleteMany({
    where: { createdAt: { lte: hoursAgo(env.IDEMPOTENCY_RECORD_RETENTION_HOURS, now) } },
  });

  const ssoAuthRequests = await prisma.ssoAuthRequest.deleteMany({
    where: { createdAt: { lte: hoursAgo(env.SSO_REQUEST_RETENTION_HOURS, now) } },
  });

  /**
   * The payload is emptied rather than the row deleted.
   *
   * `providerEventId` is unique and is what makes webhook delivery idempotent, so
   * deleting the row would let a provider retry an old event and have it applied
   * twice. A duplicate charge is not an acceptable price for a smaller table.
   *
   * `Prisma.DbNull` rather than a literal `null`, because on a nullable `Json`
   * column Prisma treats a bare `null` as JSON null and would store the string
   * "null" rather than removing the value.
   */
  const billingPayloads = await prisma.billingEvent.updateMany({
    where: {
      payload: { not: Prisma.DbNull },
      createdAt: { lte: daysAgo(env.BILLING_PAYLOAD_RETENTION_DAYS, now) },
    },
    data: { payload: Prisma.DbNull },
  });

  return {
    exportJobs: exportJobs.count,
    idempotencyRecords: idempotencyRecords.count,
    ssoAuthRequests: ssoAuthRequests.count,
    billingPayloads: billingPayloads.count,
  };
}