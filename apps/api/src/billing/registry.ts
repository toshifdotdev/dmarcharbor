import { BillingProviderError } from './provider.js';
import type { BillingProvider, ProviderName } from './provider.js';
import { dodoAllowedForWorkspace, dodoConfigured, DodoBillingProvider } from './dodo.provider.js';
import { paddleConfigured, PaddleBillingProvider } from './paddle.provider.js';
import { razorpayConfigured, RazorpayBillingProvider } from './razorpay.provider.js';
import { MockBillingProvider } from './mock-provider.js';
import { planSyncReport } from './plans.js';
import type { BillingCurrency } from '../services/entitlements/plan-catalog.js';

/**
 * Chooses which provider serves a checkout.
 *
 * The routing is not arbitrary. Razorpay is the default for INR because it
 * settles straight into an Indian bank account and supports UPI, which is how
 * most Indian businesses actually pay. Dodo Payments is the merchant of record
 * for USD, handling international sales tax and settling to India; Paddle stays
 * dormant as a fallback for existing subscriptions or when Dodo is unconfigured.
 *
 * A customer who already has a subscription is never routed to a different
 * provider, because the providers have no way to see each other's
 * subscriptions. That would strand a paying customer with a workspace stuck on
 * the free plan.
 */

const razorpay = new RazorpayBillingProvider();
const paddle = new PaddleBillingProvider();
const dodo = new DodoBillingProvider();
const mock = new MockBillingProvider();

export function billingProviders(): Record<Exclude<ProviderName, 'NONE'>, BillingProvider> {
  return { RAZORPAY: razorpay, PADDLE: paddle, DODO: dodo };
}

export function providerFor(name: Exclude<ProviderName, 'NONE'>): BillingProvider {
  const providers = billingProviders();
  const provider = providers[name];
  if (!provider) {
    throw new BillingProviderError(`No billing provider named ${name}.`, 'UNKNOWN_PROVIDER', 400);
  }
  return provider;
}

export function providerConfigured(name: Exclude<ProviderName, 'NONE'>): boolean {
  if (name === 'RAZORPAY') {
    return razorpayConfigured();
  }
  if (name === 'DODO') {
    return dodoConfigured();
  }
  return paddleConfigured();
}

/**
 * Whether a provider can actually be used right now.
 *
 * A configured provider is not necessarily a usable one, and the difference
 * matters: a provider with keys but no stored plans cannot take payment, so
 * `/api/capabilities` must not advertise USD while Dodo's expected USD plans
 * have not been synced into `billing_plan`.
 *
 * In `test_mode`, Dodo is also restricted to workspaces explicitly listed in
 * `DODO_TEST_WORKSPACE_IDS`, so `/api/capabilities` never lists USD for
 * anonymous visitors or non-listed workspaces.
 */
export async function providerReady(
  name: Exclude<ProviderName, 'NONE'>,
  organizationId?: string | null,
): Promise<boolean> {
  if (!providerConfigured(name)) {
    return false;
  }
  if (name === 'DODO') {
    if (!dodoAllowedForWorkspace(organizationId)) {
      return false;
    }
    const report = await planSyncReport('DODO', 'USD');
    return report.length > 0 && report.every((entry) => entry.status === 'ready');
  }
  return true;
}

export function providerForCurrency(currency: BillingCurrency): Exclude<ProviderName, 'NONE'> {
  if (currency === 'INR') {
    return 'RAZORPAY';
  }
  return dodoConfigured() ? 'DODO' : 'PADDLE';
}

/**
 * Resolves the provider for a new checkout, and refuses clearly when the chosen
 * one is not configured yet (or, in Dodo `test_mode`, when the workspace is not
 * listed in `DODO_TEST_WORKSPACE_IDS`).
 */
export function resolveProviderForCheckout(input: {
  currency: BillingCurrency;
  existingProvider?: Exclude<ProviderName, 'NONE'> | 'NONE' | null;
  organizationId?: string | null;
}): BillingProvider {
  const target =
    input.existingProvider && input.existingProvider !== 'NONE'
      ? input.existingProvider
      : providerForCurrency(input.currency);

  if (!providerConfigured(target)) {
    throw new BillingProviderError(
      target === 'RAZORPAY'
        ? 'Payments are not available yet. Razorpay has not been configured.'
        : target === 'DODO'
          ? 'Payments are not available yet. Dodo Payments has not been configured.'
          : 'Payments are not available yet. Paddle has not been configured.',
      'PROVIDER_NOT_CONFIGURED',
      503,
    );
  }

  if (target === 'DODO' && !dodoAllowedForWorkspace(input.organizationId)) {
    throw new BillingProviderError(
      'Payments in USD are not available for this workspace while Dodo Payments is in test mode.',
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

export { razorpay, paddle, dodo };
