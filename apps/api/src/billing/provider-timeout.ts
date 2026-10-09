import { BillingProviderError } from './provider.js';

/**
 * How long a payment provider has to answer.
 *
 * Long enough for a create-subscription round trip on a slow connection, short
 * enough that a provider accepting TCP and then stalling cannot hold a request,
 * and everything queued behind it, open for ever.
 */
export const PROVIDER_TIMEOUT_MS = 10_000;

/**
 * How long an email provider has to answer.
 *
 * Longer than the payment timeout because a send is one request carrying a body
 * and attachments, but still bounded: the queue holds a claim while it waits, so
 * an unbounded send turns one stalled response into every password reset on the
 * system arriving late.
 */
export const EMAIL_SEND_TIMEOUT_MS = 20_000;

/**
 * Runs an operation with a deadline, translating a timeout into a provider error.
 *
 * Nothing in the Razorpay or Paddle SDK sets one, and their HTTP clients default
 * to waiting for ever, so every call through `private async call()` was
 * unbounded. A provider that stops answering then takes the request, the
 * connection and the worker with it, and there is no retry that fixes a hanging
 * socket.
 *
 * The deadline is enforced on the promise rather than by passing a signal,
 * because "the SDK called my callback too late" and "the SDK never called back"
 * are both cases this has to cover, and a signal only reaches the ones that read
 * it.
 */
export async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  providerName: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new BillingProviderError(
              `${providerName} did not respond within ${Math.round(timeoutMs / 1000)} seconds.`,
              'PROVIDER_TIMEOUT',
              504,
            ),
          );
        }, timeoutMs);
        // Does not hold the process open on its own.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * The same deadline, for a caller with no business throwing a
 * `BillingProviderError`.
 *
 * The email queue is that caller. It retries and dead-letters on its own logic and
 * needs an error it can classify, so a timeout here is an ordinary `Error`. The
 * email case is where a hung provider does the most damage, because a claim is
 * held while the socket sits open and every later pass waits on the same row.
 */
export async function withGenericTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  providerName: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${providerName} did not respond within ${Math.round(timeoutMs / 1000)} seconds.`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
