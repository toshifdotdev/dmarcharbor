import { providerForCurrency, providerReady } from '../billing/registry.js';
import { billingCurrencies, type BillingCurrency } from '../services/entitlements/plan-catalog.js';
import { compliancePackFilename } from './trust/compliance-pack.service.js';

/**
 * What this deployment can actually do.
 *
 * The pricing page used to render every currency the catalog carries prices for,
 * which meant it advertised a $149 plan that the checkout would then refuse with
 * a 503 while Paddle was unconfigured. That is the same class of defect as the
 * payment redirect pointing at a route that did not exist: a public page making a
 * promise the API does not keep.
 *
 * Derived from the provider configuration rather than a flag, so it cannot drift.
 * Adding Paddle_API_KEY and PADDLE_WEBHOOK_SECRET is the whole of the change.
 *
 * Public and unauthenticated, because it is read by the marketing site before
 * anyone has an account. It therefore exposes configuration state and nothing
 * else: which processors exist, which currencies are buyable, and two
 * representative identifiers used as examples. No keys, no ids, no counts.
 */
export interface Capabilities {
  /** Currencies a customer can actually pay in right now. */
  currencies: BillingCurrency[];
  /** The currency a new workspace gets before it chooses. */
  defaultCurrency: BillingCurrency;
  providers: Record<'razorpay' | 'paddle', boolean>;
  /** Whether the currency can still be changed for a given workspace. */
  currencyLocked: boolean;
  compliancePack: { exampleReference: string; exampleFilename: string };
}

/**
 * A fixed illustrative reference for the marketing page.
 *
 * This used to call `compliancePackReference` with today's date, which handed every
 * anonymous caller of `GET /api/capabilities` a live reference in the exact
 * format the public verifier accepts, generated on the day they asked. Combined
 * with a 24 bit suffix that made enumeration of the day's references practical,
 * and the date component of the real ones was confirmed for free.
 *
 * The example is now a constant with a date and a suffix that cannot occur, so it
 * demonstrates the shape without narrowing anybody's search space. It still
 * answers 404 at the verifier, which is the correct behaviour for an example.
 */
export const illustrativePackReference = 'DMARC-00000000-EXAMPLE-CLIENT-DEMONSTRATIONONLY0000';

export async function capabilities(): Promise<Capabilities> {
  const razorpay = providerReady('RAZORPAY');
  const paddle = providerReady('PADDLE');

  const currencies = billingCurrencies.filter((currency) => providerReady(providerForCurrency(currency)));

  // Default is INR, which is the processor money can be taken with today. Flipping
  // this to USD is a one-line change once Paddle is live and its prices are synced.
  const defaultCurrency: BillingCurrency = currencies.includes('INR') ? 'INR' : (currencies[0] ?? 'INR');

  // Illustrative rather than real, so the marketing page can show what a filename
  // and a reference look like without a database read. A constant, not a freshly
  // minted one, so the public endpoint cannot be used to confirm the date format
  // or to narrow a search.
  const exampleDate = new Date('2026-01-01T00:00:00.000Z');
  const exampleReference = illustrativePackReference;

  return {
    currencies,
    defaultCurrency,
    providers: { razorpay, paddle },
    // Whether a specific workspace may still change currency is answered by
    // billingCurrencyPreference, which needs the subscription. This only reports
    // whether any paid subscription could exist at all, which is false until a
    // provider is configured.
    currencyLocked: false,
    compliancePack: {
      exampleReference,
      exampleFilename: compliancePackFilename(exampleReference, exampleDate),
    },
  };
}
