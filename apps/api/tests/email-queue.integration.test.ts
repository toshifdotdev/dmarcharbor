import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/database/prisma.js';

/**
 * Email that survives a provider outage.
 *
 * Every send used to be a floating promise with a log line on failure. Correct instinct
 * for a notification, wrong mechanism for the messages where this email is the only
 * copy: a password reset, a domain verification link, the confirmation that an erasure
 * completed. A thirty second Resend outage destroyed all of them.
 */

const sendEmail = vi.hoisted(() => vi.fn());

vi.mock('../src/email/email.service.js', () => ({ sendEmail }));

const { backoffFor, drainEmailQueue, enqueueEmail, maxEmailAttempts } = await import(
  '../src/services/email-queue.service.js'
);

async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "email_delivery", "organization", invitation, member, session, account, verification, "user" CASCADE',
  );
}

function message(overrides: Partial<{ to: string; subject: string; idempotencyKey: string }> = {}) {
  return {
    kind: 'auth',
    to: overrides.to ?? 'customer@example.com',
    subject: overrides.subject ?? 'Reset your password',
    html: '<p>Reset</p>',
    text: 'Reset',
    ...(overrides.idempotencyKey ? { idempotencyKey: overrides.idempotencyKey } : {}),
  };
}

beforeEach(async () => {
  await resetDatabase();
  sendEmail.mockReset();
  sendEmail.mockResolvedValue(undefined);
});

afterEach(async () => {
  await resetDatabase();
});

describe('durable email queue', () => {
  it('writes the message down rather than handing it straight to the provider', async () => {
    await enqueueEmail(message());

    const rows = await prisma.emailDelivery.findMany();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('PENDING');
    expect(rows[0]?.to).toBe('customer@example.com');

    /**
     * The point of the change: nothing was sent yet, so a provider being down at this
     * moment cannot destroy the message.
     */
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('delivers on the next pass and marks it sent', async () => {
    await enqueueEmail(message());

    const result = await drainEmailQueue();

    expect(result.sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]?.[0]).toMatchObject({ to: 'customer@example.com' });

    const row = await prisma.emailDelivery.findFirstOrThrow();
    expect(row.state).toBe('SENT');
    expect(row.attempts).toBe(1);
    expect(row.sentAt).not.toBeNull();
  });

  it('keeps the message and retries when the provider is down', async () => {
    await enqueueEmail(message());
    sendEmail.mockRejectedValueOnce(new Error('Resend returned 503'));

    const result = await drainEmailQueue();

    expect(result.retried).toBe(1);
    expect(result.dead).toBe(0);

    const row = await prisma.emailDelivery.findFirstOrThrow();

    /**
     * The whole reason this exists. Before, this message was gone: a floating promise
     * rejected into a log line and nobody could resend a password reset that had never
     * been recorded.
     */
    expect(row.state).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('503');

    // And it is not retried immediately, so a provider outage is not a retry storm.
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('delivers on a later pass after the provider recovers', async () => {
    await enqueueEmail(message());

    sendEmail.mockRejectedValueOnce(new Error('Resend returned 503'));
    await drainEmailQueue();

    // Backoff has not elapsed, so the next pass leaves it alone.
    expect((await drainEmailQueue()).retried).toBe(0);

    await prisma.emailDelivery.updateMany({
      where: {},
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

    expect((await drainEmailQueue()).sent).toBe(1);
    expect(await prisma.emailDelivery.findFirstOrThrow().then((row) => row.state)).toBe('SENT');
  });

  it('gives up as a dead letter rather than deleting the message', async () => {
    await enqueueEmail(message());
    sendEmail.mockRejectedValue(new Error('Resend returned 500'));

    for (let attempt = 0; attempt < maxEmailAttempts; attempt += 1) {
      await prisma.emailDelivery.updateMany({
        where: {},
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
      await drainEmailQueue();
    }

    const row = await prisma.emailDelivery.findFirstOrThrow();

    expect(row.state).toBe('DEAD');
    expect(row.attempts).toBe(maxEmailAttempts);

    /**
     * Kept rather than removed. A message that silently disappeared is the failure this
     * table exists to remove; a row naming the message, the address and the attempt
     * count is at least something an operator can see and resend by hand.
     */
    expect(row.lastError).toContain('500');
    expect(await prisma.emailDelivery.count()).toBe(1);
  });

  it('backs off exponentially and then stops growing', () => {
    expect(backoffFor(1)).toBe(30_000);
    expect(backoffFor(2)).toBe(60_000);
    expect(backoffFor(3)).toBe(120_000);
    expect(backoffFor(20)).toBe(60 * 60 * 1000);
  });

  it('collapses a duplicate message rather than sending two reset links', async () => {
    await enqueueEmail(message({ idempotencyKey: 'reset-user-1' }));
    await enqueueEmail(message({ idempotencyKey: 'reset-user-1' }));

    expect(await prisma.emailDelivery.count()).toBe(1);

    await drainEmailQueue();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('does not treat a unique violation as an error worth alarming about', async () => {
    await enqueueEmail(message({ idempotencyKey: 'same-key' }));

    /**
     * A duplicate is the expected outcome of a retried request, so it is swallowed
     * rather than logged as a failure an operator would then go and investigate.
     */
    await expect(enqueueEmail(message({ idempotencyKey: 'same-key' }))).resolves.toBeUndefined();
  });

  it('leaves messages that are not due yet', async () => {
    await enqueueEmail(message());
    await prisma.emailDelivery.updateMany({
      where: {},
      data: { nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000) },
    });

    const result = await drainEmailQueue();

    expect(result.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('drains oldest first, so a backlog does not starve', async () => {
    const now = Date.now();

    /**
     * Queued in the reverse of the order they should be sent, with explicit due times.
     * Enqueue order proves nothing on its own, because every row gets the same default
     * `nextAttemptAt` and the tie would then be decided by insertion rather than by age.
     */
    for (const [to, offset] of [
      ['third@example.com', -1000],
      ['first@example.com', -3000],
      ['second@example.com', -2000],
    ] as const) {
      await enqueueEmail(message({ to }));
      await prisma.emailDelivery.updateMany({
        where: { to },
        data: { nextAttemptAt: new Date(now + offset) },
      });
    }

    await drainEmailQueue(10);

    expect(sendEmail.mock.calls.map((call) => (call[0] as { to: string }).to)).toEqual([
      'first@example.com',
      'second@example.com',
      'third@example.com',
    ]);
  });
});