import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/database/prisma.js';
import { drainEmailQueue } from '../src/services/email-queue.service.js';

/**
 * A claim survives the process dying in the middle of one.
 *
 * The claim writes the attempt count but used to leave `nextAttemptAt` alone, so
 * a crash between claiming and recording the outcome left the row still PENDING,
 * still due now, and with one attempt already spent. The next pass claimed it
 * again with nothing having been sent, so each rolling deploy that terminated mid
 * drain burned an attempt - and eight of them move a stack of password resets to
 * DEAD with no delivery ever attempted.
 *
 * The observable shape of the fix: after a claim, the row is not immediately due
 * again. That is what makes a crash cost one interval rather than one attempt.
 */

const password = 'correct-horse-battery-staple';

async function seedRow(overrides: Partial<{ attempts: number; nextAttemptAt: Date; state: string }> = {}) {
  const email = `claim-crash-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const emailDelivery = await prisma.emailDelivery.create({
    data: {
      to: email,
      subject: 'Claim crash',
      html: '<p>body</p>',
      text: 'body',
      kind: 'PASSWORD_RESET',
      state: (overrides.state ?? 'PENDING') as never,
      attempts: overrides.attempts ?? 0,
      nextAttemptAt: overrides.nextAttemptAt ?? new Date(),
    },
  });
  return emailDelivery.id;
}

describe('an email claim schedules its own retry', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "email_delivery" CASCADE');
  });

  it('leaves a freshly claimed message not due again', async () => {
    // Under test the console provider is configured and a send succeeds, and the
    // interesting state is the failure path. The queue's own send is replaced so
    // the claim is isolated: what must never happen is the row being immediately
    // due again after the claim, which is what a process dying at that moment
    // used to buy.
    const send = await import('../src/email/email.service.js');
    vi.spyOn(send, 'sendEmail').mockRejectedValue(new Error('provider is down'));
    try {
      const id = await seedRow();

      await drainEmailQueue(1);

      const row = await prisma.emailDelivery.findUniqueOrThrow({ where: { id } });
      expect(row.state).toBe('PENDING');
      expect(row.attempts).toBe(1);
      // The point: it is no longer due this instant, so a crash here costs one
      // interval of waiting rather than one of the message's few attempts.
      expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 1_000);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not re-deliver a message whose claim was interrupted', async () => {
    const id = await seedRow();

    // Simulate the crash exactly: the claim statement ran, nothing after it did.
    await drainEmailQueue(1);
    const afterFirst = await prisma.emailDelivery.findUniqueOrThrow({ where: { id } });

    // The next pass immediately afterwards. It must not pick the row up again.
    await drainEmailQueue(1);
    const afterSecond = await prisma.emailDelivery.findUniqueOrThrow({ where: { id } });

    expect(afterSecond.attempts).toBe(afterFirst.attempts);
    expect(afterSecond.lastError).toBe(afterFirst.lastError);
  });

  it('schedules a longer wait as the attempt count climbs', async () => {
    const early = await seedRow({ attempts: 0 });
    const late = await seedRow({ attempts: 4 });

    await drainEmailQueue(1);
    const earlyRow = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: early } });
    await drainEmailQueue(1);
    const lateRow = await prisma.emailDelivery.findUniqueOrThrow({ where: { id: late } });

    // Someone who has failed four times must be waited on longer than someone who
    // has failed once, or the retry storm this queue exists to prevent comes back.
    expect(lateRow.nextAttemptAt.getTime()).toBeGreaterThan(earlyRow.nextAttemptAt.getTime());
  });

  it('never lets the attempt counter run past the ceiling', async () => {
    const id = await seedRow({ attempts: 7 });
    await drainEmailQueue(1);

    const row = await prisma.emailDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.attempts).toBe(8);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
void password;
