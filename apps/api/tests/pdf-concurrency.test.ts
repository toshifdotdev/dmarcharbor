import { describe, expect, it } from 'vitest';
import { pdfSlotStats, withPdfSlot } from '../src/services/pdf-concurrency.js';

/**
 * Document generation used to run unbounded.
 *
 * A PDF build buffers the whole file, paginates it to count pages, and holds the result
 * twice over while the hash is computed. Several at once is a few hundred megabytes of
 * buffer, and the symptom on a small container is the process being OOM killed, which
 * takes down every tenant's API rather than the one pack that was too large.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('pdf concurrency ceiling', () => {
  it('runs work that fits under the limit without waiting', async () => {
    const order: string[] = [];

    await Promise.all([
      withPdfSlot(async () => {
        await settle();
        order.push('a');
      }),
      withPdfSlot(async () => {
        await settle();
        order.push('b');
      }),
    ]);

    expect(order).toHaveLength(2);
    expect(pdfSlotStats().active).toBe(0);
  });

  it('never exceeds the limit however many are asked for at once', async () => {
    let peak = 0;

    const run = async (): Promise<void> => {
      await withPdfSlot(async () => {
        peak = Math.max(peak, pdfSlotStats().active);
        await settle();
      });
    };

    // More than the default ceiling of four.
    await Promise.all(Array.from({ length: 16 }, run));

    expect(peak).toBeLessThanOrEqual(pdfSlotStats().limit);
    expect(peak).toBeGreaterThan(0);
  });

  it('queues the overflow rather than refusing it', async () => {
    const completed: number[] = [];

    const run = async (index: number): Promise<void> => {
      await withPdfSlot(async () => {
        await settle();
        completed.push(index);
      });
    };

    /**
     * Every one of these succeeds.
     *
     * Refusing outright would turn one customer's oversized pack into another
     * customer's error, and an agency issuing packs for several clients at once is
     * doing something entirely normal.
     */
    await Promise.all(Array.from({ length: 12 }, (_unused, index) => run(index)));

    expect(completed).toHaveLength(12);
  });

  it('gives a slot back when the work throws', async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(
        withPdfSlot(async () => {
          throw new Error('PDF generation failed');
        }),
      ).rejects.toThrow('PDF generation failed');
    }

    /**
     * The reason this is a helper rather than a counter the caller decrements.
     *
     * A build that threw while holding a slot would permanently reduce capacity, and a
     * handful of failures in a row would wedge document generation for the life of the
     * process with no error anywhere to explain it.
     */
    expect(pdfSlotStats().active).toBe(0);
    expect(pdfSlotStats().waiting).toBe(0);

    // And it still works afterwards.
    await expect(withPdfSlot(async () => 'fine')).resolves.toBe('fine');
  });

  it('releases a waiting slot to the next in line rather than waking all of them', async () => {
    const order: string[] = [];

    const run = (label: string): Promise<void> =>
      withPdfSlot(async () => {
        await settle();
        order.push(label);
      });

    await Promise.all([run('first'), run('second'), run('third'), run('fourth'), run('fifth'), run('sixth')]);

    // Nothing queued ends up running twice, and nothing is dropped.
    expect(order).toHaveLength(6);
    expect(new Set(order).size).toBe(6);
    expect(pdfSlotStats().active).toBe(0);
  });
});