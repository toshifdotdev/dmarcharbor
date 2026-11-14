import { ImapFlow } from 'imapflow';
import { env } from '../../config/env.js';
import { processInboundDmarcEmail } from '../inbound-report.service.js';
import { maxReportEmailBytes } from './imap-inbox.service.js';

/**
 * The mailbox our own report addresses deliver to.
 *
 * Every client is told to send reports to an address of ours (the shared one,
 * or `agg+<token>@` with per-client addresses). Those land in one mailbox, and
 * this reads it. A workspace's own mailbox (imap-inbox.service.ts) is a
 * different thing: a tenant's credentials, scoped to that tenant's domains.
 * This one is ours, so each report goes to whichever workspace holds the
 * verified domain it names, exactly as the inbound webhook routes it.
 *
 * A mailbox rather than only the webhook because a mailbox holds mail: a
 * report that arrives while the API is down or deploying waits there, where a
 * webhook delivery that fails its retries is gone.
 *
 * State lives in the mailbox: a message is moved out of the inbox to the
 * PROCESSED_FOLDER once handled, and every message still in the inbox is read.
 * Read or unread does not matter, so a person opening a report in the mail app
 * cannot hide it from the app. Nothing to migrate, and reading a message twice
 * is harmless because ingest de-duplicates by report identity. A message that
 * fails is moved too, so one malformed message is not retried for ever; its
 * outcome is in the log, and it can be moved back to the inbox to try again.
 */

export interface PlatformMailboxOutcome {
  messages: number;
  accepted: number;
  duplicates: number;
  unmatched: number;
}

export function platformMailboxConfigured(): boolean {
  return Boolean(env.REPORT_MAILBOX_HOST && env.REPORT_MAILBOX_USERNAME && env.REPORT_MAILBOX_PASSWORD);
}

/** Where handled messages go (a label in Gmail). */
export const PROCESSED_FOLDER = 'DMARC Harbor processed';

/** At most this many messages per poll, so one backlog cannot hold the timer. */
const PER_POLL = 200;

/** Reads the inbox and ingests what is there. Null when no mailbox is configured. */
export async function pollPlatformMailbox(): Promise<PlatformMailboxOutcome | null> {
  if (!platformMailboxConfigured()) return null;

  const client = new ImapFlow({
    host: env.REPORT_MAILBOX_HOST!,
    port: env.REPORT_MAILBOX_PORT,
    secure: env.REPORT_MAILBOX_PORT !== 143,
    // On the plain port, STARTTLS is required rather than used when offered.
    ...(env.REPORT_MAILBOX_PORT === 143 ? { doSTARTTLS: true } : {}),
    auth: { user: env.REPORT_MAILBOX_USERNAME!, pass: env.REPORT_MAILBOX_PASSWORD! },
    logger: false,
    socketTimeout: 60_000,
  });
  // ImapFlow emits 'error' on a socket timeout; with no listener Node treats it
  // as uncaught and the whole API exits. The pending command rejects as well,
  // so the poll still reports the failure.
  client.on('error', (error: Error) => {
    console.error(`[report-mailbox] connection error: ${error.message}`);
  });

  const outcome: PlatformMailboxOutcome = { messages: 0, accepted: 0, duplicates: 0, unmatched: 0 };
  await client.connect();
  try {
    // Created once; an existing folder is the normal answer after that.
    await client.mailboxCreate(PROCESSED_FOLDER).catch(() => undefined);
    const lock = await client.getMailboxLock('INBOX');
    try {
      const found = await client.search({ all: true }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).slice(0, PER_POLL);

      for (const uid of uids) {
        outcome.messages += 1;
        try {
          // Bounded: anyone can mail this address, and one huge message must
          // not fill the process's memory. One byte past the limit tells a
          // message at the limit from one over it; an oversized one is moved
          // aside unread like any other, so it cannot block the queue.
          const download = await client.download(String(uid), undefined, { uid: true, maxBytes: maxReportEmailBytes + 1 });
          const chunks: Buffer[] = [];
          let received = 0;
          for await (const part of download?.content ?? []) {
            const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
            received += chunk.length;
            if (received > maxReportEmailBytes) break;
            chunks.push(chunk);
          }
          if (chunks.length === 0 || received > maxReportEmailBytes) {
            outcome.unmatched += 1;
            if (received > maxReportEmailBytes) {
              console.warn(`[report-mailbox] message ${uid} is larger than ${maxReportEmailBytes} bytes; moved aside unread`);
            }
          } else {
            // Unscoped: our own address serves every workspace.
            const result = await processInboundDmarcEmail(Buffer.concat(chunks).toString('utf8'));
            for (const item of result.results.length > 0 ? result.results : [{ status: 'failed' as const }]) {
              if (item.status === 'created') outcome.accepted += 1;
              else if (item.status === 'duplicate') outcome.duplicates += 1;
              else outcome.unmatched += 1;
            }
          }
        } catch (error) {
          outcome.unmatched += 1;
          console.error(`[report-mailbox] message ${uid} could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => undefined);
        await client.messageMove(String(uid), PROCESSED_FOLDER, { uid: true }).catch((error: unknown) => {
          console.error(`[report-mailbox] message ${uid} could not be moved: ${error instanceof Error ? error.message : 'unknown error'}`);
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return outcome;
}
