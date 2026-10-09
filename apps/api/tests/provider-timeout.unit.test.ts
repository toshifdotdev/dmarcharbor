import { describe, expect, it, vi } from 'vitest';
import { BillingProviderError } from '../src/billing/provider.js';
import {
  EMAIL_SEND_TIMEOUT_MS,
  PROVIDER_TIMEOUT_MS,
  withGenericTimeout,
  withTimeout,
} from '../src/billing/provider-timeout.js';

/**
 * The deadline on a provider call.
 *
 * Neither the Razorpay nor the Paddle SDK sets a timeout, and neither accepts a
 * signal, so every call through `private async call()` was unbounded. A provider
 * that accepts TCP and then stalls holds the request, the connection and the
 * worker with it, and checkout, plan change and refund all sit inside that call.
 *
 * The enforced deadline is the observable change; what the caller receives is
 * asserted as well, because a raw abort or a hang both leave the caller unable to
 * tell the difference between "slow" and "broken".
 */

describe('provider call deadlines', () => {
  it('resolves when the call answers inside the window', async () => {
    const result = await withTimeout(async () => 'answered', PROVIDER_TIMEOUT_MS, 'Razorpay');
    expect(result).toBe('answered');
  });

  it('rejects with a 504 provider error when the call never answers', async () => {
    vi.useFakeTimers();
    try {
      const pending = withTimeout(() => new Promise<never>(() => {}), 100, 'Razorpay');
      const assertion = expect(pending).rejects.toBeInstanceOf(BillingProviderError);

      await vi.advanceTimersByTimeAsync(150);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports which provider timed out, and by how long', async () => {
    vi.useFakeTimers();
    try {
      const pending = withTimeout(() => new Promise<never>(() => {}), 10_000, 'Paddle');
      const assertion = expect(pending).rejects.toThrow('Paddle did not respond within 10 seconds.');

      await vi.advanceTimersByTimeAsync(10_100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('translates a timeout into a plain Error for the email caller', async () => {
    vi.useFakeTimers();
    try {
      const pending = withGenericTimeout(() => new Promise<never>(() => {}), 100, 'Resend');
      const assertion = expect(pending).rejects.toThrow('Resend did not respond within 0 seconds.');

      await vi.advanceTimersByTimeAsync(150);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not leave a timer behind once the call answers', async () => {
    vi.useFakeTimers();
    try {
      await withTimeout(async () => 'fast', 60_000, 'Razorpay');
      // A timer left running would be the reason a shutdown waits, and with no
      // unref a fast call would hold the event loop anyway.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a distinct, longer window for email than for payments', () => {
    expect(EMAIL_SEND_TIMEOUT_MS).toBeGreaterThan(PROVIDER_TIMEOUT_MS);
    expect(EMAIL_SEND_TIMEOUT_MS).toBe(20_000);
    expect(PROVIDER_TIMEOUT_MS).toBe(10_000);
  });
});
