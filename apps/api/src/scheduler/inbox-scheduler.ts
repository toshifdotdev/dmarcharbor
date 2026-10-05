import { env } from '../config/env.js';
import { prisma } from '../database/prisma.js';
import { pollInbox, recordInboxFailure } from '../services/report/imap-inbox.service.js';
import { withJobLease } from './job-lease.service.js';
import { recordJobFailure, recordJobSuccess } from './heartbeat.js';

/**
 * Polling the emailed report mailboxes.
 *
 * Kept out of the alert scheduler because polling holds an open connection to a
 * third party mail host. Folded into the alert tick, a slow or hanging server
 * would sit on a connection through a fifteen minute cycle, and one unreachable
 * provider would delay every other alert job behind it. A separate timer with
 * its own guard means one bad mailbox cannot stall the queue, and a slow mailbox
 * cannot hold up alerting.
 *
 * Workspaces are polled one at a time, in sequence, rather than all at once.
 * A burst of parallel logins is the fastest way to get an IMAP host to rate
 * limit or temporarily block the address, which would stop reports arriving
 * for every customer in the mailbox rather than just the slow one.
 */

let timer: NodeJS.Timeout | undefined;
let running = false;

/** The interval last observed, exposed so a test can assert the gating. */
let lastPollAt = 0;

export function inboxJobState(): { lastPoll: number } {
  return { lastPoll: lastPollAt };
}

/**
 * Polls every enabled mailbox once.
 *
 * A failure is recorded against the mailbox and the loop continues, because one
 * workspace with a rotated password must not stop every other workspace's
 * reports from arriving. The error surface is the stored status, which the
 * agency can read, rather than a log line nobody sees.
 */
export async function runInboxPollOnce(): Promise<{ polled: number; accepted: number; duplicates: number; failed: number }> {
  if (running) {
    return { polled: 0, accepted: 0, duplicates: 0, failed: 0 };
  }

  running = true;
  lastPollAt = Date.now();

  const summary = { polled: 0, accepted: 0, duplicates: 0, failed: 0 };

  try {
    // Each mailbox is also claimed individually, because two instances racing on
    // the same provider is exactly what gets an address blocked. This lease is
    // the coarser gate, so the fleet does not each walk the same candidate list.
    const ran = await withJobLease('inbox-poll', async () => {
    const inboxes = await prisma.reportInbox.findMany({
      where: { enabled: true },
      select: { organizationId: true },
      orderBy: { lastPolledAt: { sort: 'asc', nulls: 'first' } },
    });

    for (const inbox of inboxes) {
      try {
        const outcome = await pollInbox(inbox.organizationId);
        summary.polled += 1;
        summary.accepted += outcome.accepted;
        summary.duplicates += outcome.duplicates;
      } catch (error) {
        summary.failed += 1;
        const detail = error instanceof Error ? error.message : 'Unknown IMAP failure';
        await recordInboxFailure(inbox.organizationId, detail).catch(() => undefined);
        console.error(`[inbox] poll failed for workspace ${inbox.organizationId}: ${detail}`);
      }
    }

    if (summary.polled > 0) {
      console.info(
        `[inbox] polled ${summary.polled} mailbox(es), ${summary.accepted} accepted, ${summary.duplicates} already held, ${summary.failed} failed`,
      );
    }

    return true;
    });

    // Skipped because another replica held the lease is neither success nor failure:
    // the replica that did the work is the one that beats.
    if (ran) {
      recordJobSuccess('inbox-poll');
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown inbox scheduler error.';
    console.error(`[inbox] poll cycle failed: ${detail}`);
    recordJobFailure('inbox-poll');
  } finally {
    running = false;
  }

  return summary;
}

export function startInboxScheduler(): void {
  if (timer || env.ALERT_SCHEDULER_DISABLED) {
    return;
  }

  const intervalMs = Math.max(env.REPORT_INBOX_POLL_INTERVAL_MINUTES, 5) * 60 * 1000;
  timer = setInterval(() => {
    void runInboxPollOnce();
  }, intervalMs);

  timer.unref?.();
  console.info(
    `[inbox] scheduler started, polling every ${env.REPORT_INBOX_POLL_INTERVAL_MINUTES} minutes`,
  );
}

export function stopInboxScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
