/**
 * Real Dodo Payments Test Mode API and Standard Webhooks fixtures.
 *
 * Captured against Dodo Payments Test Mode (`dodopayments@2.63.0`) via the
 * Dodo MCP server, with all business/brand identifiers, customer emails, names
 * and addresses replaced with synthetic test values.
 */

export function buildDodoProductFixture(overrides: {
  productId?: string;
  name?: string;
  description?: string;
  priceMinor?: number;
  interval?: 'Month' | 'Year';
  metadata?: Record<string, string>;
} = {}) {
  return {
    product_id: overrides.productId ?? 'pdt_fixture_fairway_monthly',
    business_id: 'bus_fixture_redacted',
    name: overrides.name ?? 'DMARC Harbor — Fairway (Monthly)',
    description: overrides.description ?? 'Up to 15 active domains across 5 clients.',
    image: null,
    created_at: '2026-11-16T20:08:09.988985Z',
    updated_at: '2026-11-16T20:08:09.988985Z',
    is_recurring: true,
    tax_category: 'saas' as const,
    price: {
      type: 'recurring_price' as const,
      price: overrides.priceMinor ?? 3900,
      currency: 'USD' as const,
      tax_inclusive: false,
      discount: 0,
      discount_bps: 0,
      purchasing_power_parity: false,
      payment_frequency_count: 1,
      payment_frequency_interval: overrides.interval ?? ('Month' as const),
      subscription_period_count: 20,
      subscription_period_interval: 'Year' as const,
      trial_period_days: 0,
      trial_amount: null,
      trial_apply_discounts: false,
      trial_type: 'none',
      trial_payment_method_optional: false,
      zero_amount_payment_method_optional: false,
    },
    license_key_enabled: false,
    license_key_activations_limit: null,
    license_key_duration: null,
    license_key_activation_message: null,
    addons: null,
    brand_id: 'brnd_fixture_redacted',
    digital_product_delivery: null,
    metadata: overrides.metadata ?? {
      tier: 'FAIRWAY',
      interval: 'monthly',
      band: '',
    },
    product_collection_id: null,
    credit_entitlements: [],
    entitlements: [],
    pricing_mode: null,
  };
}

export function buildDodoSubscriptionWebhookFixture(input: {
  type:
    | 'subscription.active'
    | 'subscription.renewed'
    | 'subscription.plan_changed'
    | 'subscription.updated'
    | 'subscription.unpaused'
    | 'subscription.past_due'
    | 'subscription.on_hold'
    | 'subscription.paused'
    | 'subscription.cancelled'
    | 'subscription.failed'
    | 'subscription.expired';
  subscriptionId: string;
  productId: string;
  status?: 'pending' | 'active' | 'on_hold' | 'paused' | 'cancelled' | 'failed' | 'expired' | 'past_due';
  quantity?: number;
  recurringPreTaxAmount?: number;
  paymentFrequencyInterval?: 'Month' | 'Year';
  nextBillingDate?: string;
  previousBillingDate?: string;
  cancelAtNextBillingDate?: boolean;
  cancelledAt?: string | null;
  pastDueEndsAt?: string | null;
  paymentId?: string | null;
  customerId?: string;
  customerEmail?: string;
  customerName?: string;
  metadata?: Record<string, string>;
  timestamp?: string;
}) {
  const nowIso = input.timestamp ?? '2026-11-16T20:12:09.916099Z';
  const nextIso = input.nextBillingDate ?? '2026-12-16T20:12:09.916099Z';
  const prevIso = input.previousBillingDate ?? '2026-11-16T20:12:09.916099Z';

  return {
    business_id: 'bus_fixture_redacted',
    type: input.type,
    timestamp: nowIso,
    data: {
      payload_type: 'Subscription' as const,
      subscription_id: input.subscriptionId,
      recurring_pre_tax_amount: input.recurringPreTaxAmount ?? 14900,
      tax_inclusive: false,
      currency: 'USD' as const,
      status: input.status ?? 'active',
      created_at: prevIso,
      expires_at: null,
      product_id: input.productId,
      quantity: input.quantity ?? 1,
      trial_period_days: 0,
      trial_amount: null,
      subscription_period_interval: 'Year' as const,
      payment_frequency_interval: input.paymentFrequencyInterval ?? ('Month' as const),
      subscription_period_count: 20,
      payment_frequency_count: 1,
      next_billing_date: nextIso,
      previous_billing_date: prevIso,
      customer: {
        customer_id: input.customerId ?? 'cus_fixture_redacted',
        name: input.customerName ?? 'Fixture MSP Owner',
        email: input.customerEmail ?? 'owner@fixture.example.com',
        phone_number: null,
        metadata: {},
      },
      tax_id: null,
      customer_business_name: null,
      metadata: input.metadata ?? {},
      discount_id: null,
      discount_cycles_remaining: null,
      discounts: null,
      cancelled_at: input.cancelledAt ?? null,
      paused_at: null,
      cancel_at_next_billing_date: input.cancelAtNextBillingDate ?? false,
      cancellation_feedback: null,
      cancellation_comment: null,
      cancelled_by: null,
      billing: {
        country: 'US' as const,
        state: 'DE',
        city: 'Wilmington',
        street: '100 Main St',
        zipcode: '19801',
      },
      on_demand: false,
      addons: [],
      meters: [],
      payment_method_id: 'pm_fixture_card_1',
      has_payment_method: true,
      custom_field_responses: null,
      credit_entitlement_cart: [],
      meter_credit_entitlement_cart: [],
      scheduled_change: null,
      brand_id: 'brnd_fixture_redacted',
      billing_mode: 'normal' as const,
      collection_method: null,
      payment_terms_days: null,
      past_due_ends_at: input.pastDueEndsAt ?? null,
      payment_id: input.paymentId ?? null,
    },
  };
}

export function buildDodoPaymentWebhookFixture(input: {
  type: 'payment.succeeded' | 'payment.failed' | 'payment.processing' | 'payment.cancelled';
  paymentId: string;
  subscriptionId: string;
  totalAmount?: number;
  tax?: number;
  status?: string;
  chargeType?: 'new' | 'renewal' | 'plan_change' | 'on_demand';
  checkoutSessionId?: string | null;
  customerId?: string;
  customerEmail?: string;
  customerName?: string;
  metadata?: Record<string, string>;
  errorCode?: string | null;
  errorMessage?: string | null;
  timestamp?: string;
}) {
  const nowIso = input.timestamp ?? '2026-11-16T20:12:09.916099Z';
  const totalAmount = input.totalAmount ?? 16092;
  const tax = input.tax ?? 1192;

  return {
    business_id: 'bus_fixture_redacted',
    type: input.type,
    timestamp: nowIso,
    data: {
      payload_type: 'Payment' as const,
      payment_id: input.paymentId,
      business_id: 'bus_fixture_redacted',
      status: input.status ?? (input.type === 'payment.succeeded' ? 'succeeded' : 'failed'),
      total_amount: totalAmount,
      currency: 'USD' as const,
      payment_method: 'card',
      payment_method_type: 'visa',
      payment_method_id: 'pm_fixture_card_1',
      is_update_payment_method: false,
      created_at: nowIso,
      updated_at: nowIso,
      disputes: [],
      refunds: [],
      refund_status: null,
      customer: {
        customer_id: input.customerId ?? 'cus_fixture_redacted',
        name: input.customerName ?? 'Fixture MSP Owner',
        email: input.customerEmail ?? 'owner@fixture.example.com',
        phone_number: null,
        metadata: {},
      },
      subscription_id: input.subscriptionId,
      is_multi_subscription: false,
      subscription_ids: [input.subscriptionId],
      charge_type: input.chargeType ?? 'new',
      includes_usage: false,
      service_periods:
        input.type === 'payment.succeeded'
          ? [
              {
                subscription_id: input.subscriptionId,
                starts_at: nowIso,
                ends_at: '2026-12-16T20:12:09.916099Z',
                proration_factor: '1',
              },
            ]
          : [],
      product_cart: null,
      payment_link: 'https://test.checkout.dodopayments.com/session/cks_fixture_redacted',
      tax,
      metadata: input.metadata ?? {},
      error_message: input.errorMessage ?? null,
      error_code: input.errorCode ?? null,
      discount_id: null,
      discounts: null,
      settlement_amount: totalAmount,
      settlement_tax: tax,
      settlement_currency: 'USD' as const,
      billing: {
        country: 'US' as const,
        state: 'DE',
        city: 'Wilmington',
        street: '100 Main St',
        zipcode: '19801',
      },
      card_last_four: '4242',
      card_issuing_country: 'US' as const,
      card_type: 'credit',
      card_network: 'visa',
      card_exp_month: '12',
      card_exp_year: '2029',
      three_ds_status: null,
      three_ds_flow: null,
      three_ds_version: null,
      card_holder_name: 'Fixture MSP Owner',
      brand_id: 'brnd_fixture_redacted',
      digital_products_delivered: false,
      checkout_session_id: input.checkoutSessionId ?? null,
      invoice_id: 'inv_fixture_redacted',
      invoice_url: 'https://test.dodopayments.com/invoices/payments/pay_fixture_redacted',
      custom_field_responses: null,
      retry_attempt: 0,
      payment_provider: 'dodo' as const,
    },
  };
}

export function buildDodoRefundWebhookFixture(input: {
  type: 'refund.succeeded' | 'refund.failed';
  refundId: string;
  paymentId: string;
  amountMinor?: number;
  isPartial?: boolean;
  customerId?: string;
  customerEmail?: string;
  customerName?: string;
  metadata?: Record<string, string>;
  reason?: string | null;
  timestamp?: string;
}) {
  const nowIso = input.timestamp ?? '2026-11-16T20:15:00.000Z';
  return {
    business_id: 'bus_fixture_redacted',
    type: input.type,
    timestamp: nowIso,
    data: {
      payload_type: 'Refund' as const,
      refund_id: input.refundId,
      business_id: 'bus_fixture_redacted',
      brand_id: 'brnd_fixture_redacted',
      payment_id: input.paymentId,
      amount: input.amountMinor ?? 16092,
      currency: 'USD' as const,
      status: input.type === 'refund.succeeded' ? ('succeeded' as const) : ('failed' as const),
      is_partial: input.isPartial ?? false,
      created_at: nowIso,
      customer: {
        customer_id: input.customerId ?? 'cus_fixture_redacted',
        name: input.customerName ?? 'Fixture MSP Owner',
        email: input.customerEmail ?? 'owner@fixture.example.com',
        phone_number: null,
        metadata: {},
      },
      metadata: input.metadata ?? {},
      network_reference: null,
      network_reference_type: null,
      network_reference_updated_at: null,
      reason: input.reason ?? 'Customer requested refund within 14-day guarantee',
    },
  };
}

/**
 * Real Dodo Dispute webhook payload (`Dispute` in `dodopayments/resources/disputes`).
 *
 * Per Dodo's schema and docs, Dispute webhook payloads do NOT carry a `customer`
 * or `subscription_id` field — only `dispute_id`, `payment_id`, `amount` (string),
 * `currency`, `dispute_stage`, and `dispute_status`.
 */
export function buildDodoDisputeWebhookFixture(input: {
  type:
    | 'dispute.opened'
    | 'dispute.expired'
    | 'dispute.accepted'
    | 'dispute.cancelled'
    | 'dispute.challenged'
    | 'dispute.won'
    | 'dispute.lost';
  disputeId: string;
  paymentId: string;
  amount?: string;
  disputeStage?: 'pre_dispute' | 'dispute' | 'pre_arbitration';
  disputeStatus?:
    | 'dispute_opened'
    | 'dispute_expired'
    | 'dispute_accepted'
    | 'dispute_cancelled'
    | 'dispute_challenged'
    | 'dispute_won'
    | 'dispute_lost';
  timestamp?: string;
}) {
  const nowIso = input.timestamp ?? '2026-11-16T20:20:00.000Z';
  return {
    business_id: 'bus_fixture_redacted',
    type: input.type,
    timestamp: nowIso,
    data: {
      payload_type: 'Dispute' as const,
      dispute_id: input.disputeId,
      business_id: 'bus_fixture_redacted',
      payment_id: input.paymentId,
      amount: input.amount ?? '16092',
      currency: 'USD',
      created_at: nowIso,
      dispute_stage: input.disputeStage ?? 'dispute',
      dispute_status: input.disputeStatus ?? 'dispute_opened',
      is_resolved_by_rdr: false,
      remarks: null,
    },
  };
}
