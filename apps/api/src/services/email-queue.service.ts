import { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma.js';
import { sendEmail } from '../email/email.service.js';
import { withJobLease } from '../scheduler/job-lease.service.js';

/**
 * Email delivery that survives a provider outage.
 *
 * Every send used to be fire and forget: a floating promise with a log line on
 * failure. That is the right instinct for a notification, which is never worth failing
 * a request over, and the wrong mechanism when the message is the only copy of
 * something the customer needs. A password reset, a domain verification link, or the
 * confirmation that an erasure has completed simply does not exist anywhere else, and
 * a thirty second Resend outage threw all of them away with a line in a log nobody is
 * watching.
 *
 * So sends are written down first and delivered second. The caller's behaviour does not
 * change: nothing here throws, and a notification still cannot fail a request.
 */

/**
 * Attempts before a message is given up on.
 *
 * With the backoff below that is roughly four hours of trying. Long enough to ride out
 * a provider incident, short enough that a genuinely undeliverable address is not
 * retried for days.
 */
export const maxEmailAttempts = 8;

/** Base for the exponential backoff, doubling each attempt up to the cap below. */
const backoffBaseMs = 30_000;
const backoffCapMs = 60 * 60 * 1000;

export function backoffFor(attempt: number): number {
  return Math.min(backoffBaseMs * 2 ** Math.max(0, attempt - 1), backoffCapMs);
}

export interface QueueInput {
  kind: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey?: string;
  organizationId?: string;
}

/**
 * Writes the message down. Synchronous, and it has to be.
 *
 * The caller's request may end the moment this returns, so anything deferred to a
 * promise risks losing the row along with the reason it was queued.
 */
export async function enqueueEmail(input: QueueInput, now = new Date()): Promise<void> {
  try {
    await prisma.emailDelivery.create({
      data: {
        kind: input.kind,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        organizationId: input.organizationId ?? null,
        /**
         * Written from here rather than left to the column default.
         *
         * The default would come from the database clock while every "is it due"
         * comparison comes from this process's clock. When those two disagree by even a
         * little, a freshly queued message is not due yet, and the pass silently does
         * nothing. Same clock on both sides removes the whole class of problem.
         */
        nextAttemptAt: now,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // The same logical message is already queued. Not an error: a retried request
      // should not become a second password reset link.
      return;
    }

    const detail = error instanceof Error ? error.message : 'Unknown email queue error.';
    console.error(`[email] could not queue "${input.kind}" to ${input.to}: ${detail}`);
  }
}

export interface EmailSweep {
  sent: number;
  retried: number;
  dead: number;
}

/**
 * Claims and delivers everything due.
 *
 * Rows are claimed one at a time with a conditional update on state, so several
 * instances draining at once each deliver a different message instead of all of them
 * delivering all of them.
 */
export async function drainEmailQueue(limit = 25, now = new Date()): Promise<EmailSweep> {
  const summary: EmailSweep = { sent: 0, retried: 0, dead: 0 };

  for (let index = 0; index < limit; index += 1) {
    const due = await prisma.emailDelivery.findFirst({
      where: { state: 'PENDING', nextAttemptAt: { lte: now } },
      orderBy: { nextAttemptAt: 'asc' },
      select: { id: true },
    });

    if (!due) {
      break;
    }

    const claim = await prisma.emailDelivery.updateMany({
      where: { id: due.id, state: 'PENDING' },
      data: { lastAttemptAt: now, attempts: { increment: 1 } },
    });

    // Another instance took it between the read and the claim.
    if (claim.count !== 1) {
      continue;
    }

    const row = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: due.id } });

    try {
      await sendEmail({
        to: row.to,
        subject: row.subject,
        html: row.html,
        text: row.text,
        ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
      });

      await prisma.emailDelivery.update({
        where: { id: row.id },
        data: { state: 'SENT', sentAt: new Date(), lastError: null },
      });
      summary.sent += 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown email delivery error.';
      const exhausted = row.attempts >= maxEmailAttempts;

      if (exhausted) {
        /**
         * Kept as a dead letter rather than deleted.
         *
         * A message that silently disappeared is the failure this whole table exists
         * to remove. A row saying which message gave up, for which address and after
         * how many attempts, is at least something an operator can see and resend.
         */
        await prisma.emailDelivery.update({
          where: { id: row.id },
          data: { state: 'DEAD', lastError: detail },
        });
        console.error(
          `[email] giving up on "${row.kind}" to ${row.to} after ${row.attempts} attempt(s): ${detail}`,
        );
        summary.dead += 1;
      } else {
        await prisma.emailDelivery.update({
          where: { id: row.id },
          data: { lastError: detail, nextAttemptAt: new Date(now.getTime() + backoffFor(row.attempts)) },
        });
        summary.retried += 1;
      }
    }
  }

  return summary;
}

/** One leased pass, so the fleet does not each drain the same rows. */
export async function runEmailQueueOnce(): Promise<EmailSweep> {
  const empty: EmailSweep = { sent: 0, retried: 0, dead: 0 };

  try {
    const summary = await withJobLease('email-queue', async () => {
      const swept = await drainEmailQueue();

      if (swept.sent + swept.retried + swept.dead > 0) {
        console.info(
          `[email] queue drained: ${swept.sent} sent, ${swept.retried} awaiting retry, ${swept.dead} given up`,
        );
      }

      return swept;
    });

    return summary ?? empty;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown email queue error.';
    console.error(`[email] queue pass failed: ${detail}`);
    return empty;
  }
}