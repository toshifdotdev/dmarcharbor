import { BillingProviderError } from './provider.js';
import type { BillingProvider, ProviderName } from './provider.js';
import { paddleConfigured, PaddleBillingProvider } from './paddle.provider.js';
import { razorpayConfigured, RazorpayBillingProvider } from './razorpay.provider.js';
import { MockBillingProvider } from './mock-provider.js';
import type { BillingCurrency } from '../services/entitlements/plan-catalog.js';

/**
 * Chooses which provider serves a checkout.
 *
 * The routing is not arbitrary. Razorpay is the default for INR because it
 * settles straight into an Indian bank account and supports UPI, which is how
 * most Indian businesses actually pay. Paddle is the merchant of record for
 * everything else, so it handles international sales tax that we would
 * otherwise have to handle ourselves.
 *
 * A customer who already has a subscription is never routed to a different
 * provider, because the two have no way to see each other's subscriptions. That
 * would strand a paying customer with a workspace stuck on the free plan.
 */

const razorpay = new RazorpayBillingProvider();
const paddle = new PaddleBillingProvider();
const mock = new MockBillingProvider();

export function billingProviders(): Record<Exclude<ProviderName, 'NONE'>, BillingProvider> {
  return { RAZORPAY: razorpay, PADDLE: paddle };
}

export function providerFor(name: Exclude<ProviderName, 'NONE'>): BillingProvider {
  const providers = billingProviders();
  const provider = providers[name];
  if (!provider) {
    throw new BillingProviderError(`No billing provider named ${name}.`, 'UNKNOWN_PROVIDER', 400);
  }
  return provider;
}

/**
 * Whether a provider can actually be used right now.
 *
 * A configured provider is not necessarily a usable one, and the difference
 * matters: a provider with keys but no stored plans cannot take payment, so
 * checkout must refuse before the customer reaches a hosted page that will fail.
 */
export function providerReady(name: Exclude<ProviderName, 'NONE'>): boolean {
  if (name === 'RAZORPAY') {
    return razorpayConfigured();
  }
  return paddleConfigured();
}

export function providerForCurrency(currency: BillingCurrency): Exclude<ProviderName, 'NONE'> {
  return currency === 'INR' ? 'RAZORPAY' : 'PADDLE';
}

/**
 * Resolves the provider for a new checkout, and refuses clearly when the chosen
 * one is not usable yet.
 */
export function resolveProviderForCheckout(input: {
  currency: BillingCurrency;
  existingProvider?: Exclude<ProviderName, 'NONE'> | 'NONE' | null;
}): BillingProvider {
  const target = input.existingProvider && input.existingProvider !== 'NONE' ? input.existingProvider : providerForCurrency(input.currency);

  if (!providerReady(target)) {
    throw new BillingProviderError(
      target === 'RAZORPAY'
        ? 'Payments are not available yet. Razorpay has not been configured.'
        : 'Payments are not available yet. Paddle has not been configured.',
      'PROVIDER_NOT_CONFIGURED',
      503,
    );
  }

  return providerFor(target);
}

/** Test seam, so the state machine and dunning can run without merchant keys. */
export function mockProvider(): BillingProvider {
  return mock;
}

export { razorpay, paddle };
