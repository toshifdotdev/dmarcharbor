import { env } from '../config/env.js';

/**
 * A ceiling on how many expensive documents are built at once.
 *
 * PDF generation buffers the whole document, paginates it to count the pages, and holds
 * the result twice over while the hash is computed. Several in flight at the same moment
 * is a few hundred megabytes of buffer, and Node's default heap on a small container is
 * not large: the symptom is the process being OOM killed under load, which takes down
 * every tenant's API rather than just the pack that was too big.
 *
 * The limit is a semaphore rather than a rejection. Refusing outright would turn one
 * customer's pack into another's error, and an agency issuing packs for several clients
 * at once is doing something entirely normal.
 *
 * A queue would be the better design, since a burst is worth absorbing rather than
 * shedding. What is here is the part that prevents the outage; unbounded concurrency is
 * the actual defect and bounding it is enough to stop the crash.
 */

let active = 0;
const waiting: (() => void)[] = [];

export interface PdfSlotStats {
  active: number;
  waiting: number;
  limit: number;
}

export function pdfSlotStats(): PdfSlotStats {
  return { active, waiting: waiting.length, limit: env.PDF_MAX_CONCURRENCY };
}

/**
 * Runs `work` once a slot is free, releasing it whatever happens.
 *
 * The `finally` is the whole reason this is a helper rather than a counter the caller
 * decrements: a build that throws while holding a slot would otherwise permanently
 * reduce capacity, and a few failures in a row would wedge document generation for the
 * process's lifetime with no error anywhere.
 */
export async function withPdfSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= env.PDF_MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  active += 1;

  try {
    return await work();
  } finally {
    active -= 1;

    // Hand the slot straight to the next waiter rather than letting them all wake,
    // discover the slot is gone and queue again.
    const next = waiting.shift();
    next?.();
  }
}