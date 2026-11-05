import { ImapFlow } from 'imapflow';
import { env } from '../../config/env.js';
import { processInboundDmarcEmail } from '../inbound-report.service.js';

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
 * State lives in the mailbox: a message is marked read once handled, and only
 * unread messages are fetched. Nothing to migrate, and re-reading a message
 * is harmless because ingest de-duplicates by report identity. A message that
 * fails is still marked read, so one malformed message cannot be retried on
 * every poll for ever; its outcome is in the log.
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

/** At most this many messages per poll, so one backlog cannot hold the timer. */
const PER_POLL = 200;

/** Reads unread messages and ingests them. Null when no mailbox is configured. */
export async function pollPlatformMailbox(): Promise<PlatformMailboxOutcome | null> {
  if (!platformMailboxConfigured()) return null;

  const client = new ImapFlow({
    host: env.REPORT_MAILBOX_HOST!,
    port: env.REPORT_MAILBOX_PORT,
    secure: env.REPORT_MAILBOX_PORT !== 143,
    auth: { user: env.REPORT_MAILBOX_USERNAME!, pass: env.REPORT_MAILBOX_PASSWORD! },
    logger: false,
    socketTimeout: 60_000,
  });

  const outcome: PlatformMailboxOutcome = { messages: 0, accepted: 0, duplicates: 0, unmatched: 0 };
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const found = await client.search({ seen: false }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).slice(0, PER_POLL);

      for (const uid of uids) {
        outcome.messages += 1;
        try {
          const download = await client.download(String(uid), undefined, { uid: true });
          const chunks: Buffer[] = [];
          for await (const part of download?.content ?? []) {
            chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
          }
          if (chunks.length === 0) {
            outcome.unmatched += 1;
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
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return outcome;
}
