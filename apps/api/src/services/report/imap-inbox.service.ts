import { ImapFlow } from 'imapflow';
import { lookup as dnsLookup } from 'node:dns';
import { prisma } from '../../database/prisma.js';
import { decryptSensitive, encryptSensitive } from '../privacy.service.js';
import { processInboundDmarcEmail } from '../inbound-report.service.js';
import { isPrivateOrReservedHost } from '../net-guard.js';

/**
 * Emailed DMARC report collection.
 *
 * Some sending domains deliver their aggregate report as an email attachment to
 * the mailbox named in the rua tag rather than publishing a URL in DNS. A
 * high volume domain is typically split across both, which is why the same
 * report can arrive twice. The identity check in the ingest path is what makes
 * that count once; without it the reported volume would double, which is worse
 * than a gap because it looks like real traffic.
 *
 * Credentials are encrypted with the same key used for other sensitive values,
 * never stored in plain text, and never logged. A mailbox password is account
 * level access, so treating it as ordinary configuration would be a mistake.
 *
 * Polling resumes from the last UID seen rather than rescanning the mailbox, so
 * cost does not grow with how long the inbox has existed, and a report is not
 * re-fetched on every cycle.
 */

/**
 * How long a poll claim is honoured.
 *
 * Comfortably longer than the socket timeout, so a slow mailbox is never taken
 * over mid poll and then finished by two instances at once.
 */
const pollClaimTimeoutMs = 10 * 60 * 1000;

export class InboxError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'INBOX_ERROR', status = 400) {
    super(message);
    this.name = 'InboxError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Only public mail servers are accepted.
 *
 * This refused three literals: `localhost`, `127.0.0.1` and `::1`. Everything
 * else went through, including 10.0.0.5, 192.168.1.1 and 169.254.169.254. The
 * poll opens a real TCP and TLS connection with the credentials supplied, so the
 * feature is a port scanner pointed wherever a tenant tells it, and
 * `inboxStatus` returns `lastError` back to the same tenant, so `connect
 * ECONNREFUSED 10.0.0.5:993` confirms exactly which internal hosts are closed.
 *
 * It now shares the guard webhook delivery uses, so the two cannot drift apart
 * and leave one of them as the way in.
 */
function assertAllowedHost(host: string): void {
  const lower = host.trim().toLowerCase();

  if (!lower.includes('.')) {
    throw new InboxError('Enter a fully qualified mail server hostname.', 'INBOX_HOST_INVALID', 400);
  }

  if (isPrivateOrReservedHost(lower)) {
    throw new InboxError(
      'The mail server must be a public address, not a local or private one.',
      'INBOX_HOST_REFUSED',
      400,
    );
  }
}

/**
 * Resolves the configured host and refuses it if any answer is private.
 *
 * Used by the poll, where the connection is actually made, because a hostname
 * check without resolution cannot answer where a connection will go.
 */
async function assertPublicHostForPoll(host: string): Promise<Array<{ address: string }>> {
  const lower = host.trim().toLowerCase();
  assertAllowedHost(lower);

  const addresses = await new Promise<Array<{ address: string }>>((resolve, reject) => {
    dnsLookup(lower, { all: true }, (error, found) => {
      if (error) {
        reject(new InboxError('That mail server could not be resolved.', 'INBOX_HOST_UNRESOLVED', 400));
        return;
      }
      resolve(found);
    });
  });

  for (const entry of addresses) {
    if (isPrivateOrReservedHost(entry.address)) {
      throw new InboxError(
        'That mail server resolves to a private or reserved address.',
        'INBOX_HOST_REFUSED',
        400,
      );
    }
  }

  return addresses;
}

export interface InboxSettings {
  host: string;
  port?: number;
  secure?: boolean;
  username: string;
  password: string;
}

export async function configureInbox(organizationId: string, settings: InboxSettings): Promise<void> {
  assertAllowedHost(settings.host);

  const port = settings.port ?? (settings.secure === false ? 143 : 993);
  if (port !== 993 && port !== 143 && port !== 2525) {
    throw new InboxError('Use port 993 for implicit TLS, 143 for STARTTLS, or 2525.', 'INBOX_PORT_INVALID', 400);
  }

  const data = {
    host: settings.host.trim(),
    port,
    secure: settings.secure !== false,
    username: settings.username.trim(),
    encryptedPassword: encryptSensitive(settings.password),
  };

  await prisma.reportInbox.upsert({
    where: { organizationId },
    create: { organizationId, ...data },
    update: { ...data, enabled: true, consecutiveFailures: 0, lastError: null },
  });
}

export async function disableInbox(organizationId: string): Promise<void> {
  await prisma.reportInbox.updateMany({ where: { organizationId }, data: { enabled: false } });
}

export async function inboxStatus(organizationId: string): Promise<{
  configured: boolean;
  enabled: boolean;
  host: string | null;
  username: string | null;
  lastPolledAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}> {
  const inbox = await prisma.reportInbox.findUnique({ where: { organizationId } });
  if (!inbox) {
    return {
      configured: false,
      enabled: false,
      host: null,
      username: null,
      lastPolledAt: null,
      lastError: null,
      consecutiveFailures: 0,
    };
  }

  return {
    configured: true,
    enabled: inbox.enabled,
    host: inbox.host,
    // The username is an address, not a secret, and showing it lets support
    // confirm which mailbox a workspace is reading.
    username: inbox.username,
    lastPolledAt: inbox.lastPolledAt?.toISOString() ?? null,
    lastError: inbox.lastError,
    consecutiveFailures: inbox.consecutiveFailures,
  };
}

export interface PollOutcome {
  messages: number;
  accepted: number;
  duplicates: number;
  unmatched: number;
}

/**
 * Polls one mailbox and ingests what it finds.
 *
 * Reports for domains this workspace does not monitor are left alone rather than
 * guessed at. Ingesting them would either fail the domain check or, worse,
 * attach another workspace's data to this one.
 */
export async function pollInbox(organizationId: string): Promise<PollOutcome> {
  const inbox = await prisma.reportInbox.findUnique({ where: { organizationId } });
  if (!inbox || !inbox.enabled) {
    return { messages: 0, accepted: 0, duplicates: 0, unmatched: 0 };
  }

  const password = decryptSensitive(inbox.encryptedPassword);
  if (!password) {
    throw new InboxError('The stored mailbox password could not be read.', 'INBOX_CREDENTIALS_UNREADABLE', 500);
  }

  /**
   * Resolved and re-checked here, not only where the mailbox was configured.
   *
   * A hostname is checked as written at configuration time and can answer
   * differently at connection time, so a host accepted when it was saved can
   * point at a private address by the time a poll reaches it - and the poll is
   * what sends the stored credentials there. The addresses are pinned onto the
   * connection so the socket goes to what was checked.
   *
   * The module's own comment states the consequence: this feature is a port
   * scanner pointed wherever a tenant tells it, and a poll receives both the
   * connection outcome and the credentials. Closing the resolution window is
   * what makes the port check worth having.
   */
  const checked = await assertPublicHostForPoll(inbox.host);
  const primary = checked[0]?.address ?? inbox.host;

  const client = new ImapFlow({
    host: primary,
    port: inbox.port,
    secure: inbox.secure,
    auth: { user: inbox.username, pass: password },
    logger: false,
    // A mailbox that hangs must not hold a scheduler slot open.
    socketTimeout: 60_000,
    // SNI and the advertised login still use the real name, so the certificate
    // matches what the customer configured even though the socket is pinned.
    servername: inbox.host,
  });

  // Claimed before connecting. Every instance starts the inbox scheduler on
  // boot, so without this each one opens a connection to the customer's mail
  // host and reads the same cursor. That is the exact behaviour this module is
  // written to avoid, and the thing a mail host blocks an address over.
  const claim = await prisma.reportInbox.updateMany({
    where: {
      organizationId,
      enabled: true,
      OR: [{ pollClaimedAt: null }, { pollClaimedAt: { lt: new Date(Date.now() - pollClaimTimeoutMs) } }],
    },
    data: { pollClaimedAt: new Date() },
  });

  if (claim.count !== 1) {
    return { messages: 0, accepted: 0, duplicates: 0, unmatched: 0 };
  }

  const outcome: PollOutcome = { messages: 0, accepted: 0, duplicates: 0, unmatched: 0 };

  // UIDs are bigint in Prisma and number in IMAP, so the cursor is carried as a
  // number and converted at the boundary rather than mixing the two types.
  const startAfter = inbox.lastUid === null || inbox.lastUid === undefined ? null : Number(inbox.lastUid);
  let highestUid: number | null = startAfter;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Resuming from the last UID is what keeps the cost flat regardless of how
      // long the mailbox has existed.
      const range = startAfter !== null ? `${startAfter + 1}:*` : '1:*';
      // imapflow returns false when a search matches nothing, which is normal
      // on an empty mailbox and must not be treated as an error.
      const found = await client.search({ seq: range }, { uid: true });
      const uids: number[] = Array.isArray(found) ? found : [];

      for (const uid of uids) {
        if (startAfter !== null && uid <= startAfter) {
          continue;
        }

        outcome.messages += 1;

        try {
          const download = await client.download(uid);
          const chunks: Buffer[] = [];
          for await (const part of download?.content ?? []) {
            chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
          }

          if (chunks.length === 0) {
            outcome.unmatched += 1;
            continue;
          }

          // Routed through the same entry point an inbound webhook uses, rather
          // than a second parser. That way an emailed report is attributed
          // exactly like a fetched one, and forensic reports are handled too:
          // a shared mailbox receives those as well, and a collection path that
          // only understood aggregate XML would drop them silently.
          const result = await processInboundDmarcEmail(Buffer.concat(chunks).toString('utf8'));

          if (result.kind === 'aggregate') {
            for (const item of result.results) {
              if (item.status === 'created') {
                outcome.accepted += 1;
              } else if (item.status === 'duplicate') {
                outcome.duplicates += 1;
              } else {
                outcome.unmatched += 1;
              }
            }
          } else if (result.results.some((item) => item.status === 'created')) {
            outcome.accepted += 1;
          } else {
            outcome.unmatched += 1;
          }
        } catch {
          // One malformed message must not abandon the rest of the mailbox.
          outcome.unmatched += 1;
        }

        highestUid = Math.max(highestUid ?? 0, Number(uid));
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  await prisma.reportInbox.update({
    where: { organizationId },
    data: {
      lastPolledAt: new Date(),
      pollClaimedAt: null,
      ...(highestUid !== null ? { lastUid: BigInt(highestUid) } : {}),
      consecutiveFailures: 0,
      lastError: null,
    },
  });

  return outcome;
}

/**
 * Reads the policy domain without a full parse.
 *
 * The report is parsed again during ingest, so this is deliberately a cheap
 * substring read. A full parse here would mean parsing every message twice, and
 * it would also reject on a malformed report before the parser can record why.
 */
export function readPolicyDomain(xml: string): string | null {
  const match = xml.match(/<policy_published>[\s\S]*?<domain>([^<\s]+)<\/domain>/i);
  return match?.[1]?.trim().toLowerCase() ?? null;
}

/** Records a poll failure without throwing, so one bad mailbox cannot stop the rest. */
export async function recordInboxFailure(organizationId: string, detail: string): Promise<void> {
  /**
   * `updateMany` with an increment, rather than a read followed by a write.
   *
   * Two schedulers can be inside this function at once for the same mailbox, and
   * read-then-write would have both write N+1, permanently under-reporting how
   * long a mailbox has been failing and so never tripping the threshold that
   * stops us logging in to it. It also cannot throw on a mailbox deleted midway,
   * which is what the existence check was for.
   */
  await prisma.reportInbox.updateMany({
    where: { organizationId },
    // Deliberately the message only. An IMAP error string can contain the
    // username, and this column is read by the billing screen.
    data: { consecutiveFailures: { increment: 1 }, lastError: detail.slice(0, 200), pollClaimedAt: null },
  });
}
