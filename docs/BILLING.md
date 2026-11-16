# DMARC Harbor Billing

How money moves, which provider handles which customer, what each plan change,
cancellation and refund does, and what happens when a payment fails.

## Decisions on record

Made in session 11 (November 2026), with the reason for each. Change one only
with its reason in view.

| Decision | Why |
|---|---|
| **INR on Razorpay, USD on Dodo Payments.** | Razorpay settles INR directly to an Indian bank (~2%) and supports UPI Autopay and eNACH. Dodo Payments is our merchant of record for USD, accepts Indian sole proprietors and settles to an Indian bank account (Paddle rejected the seller account; Paddle code stays dormant until removed). |
| **INR is on Razorpay Recurring Payments** (a mandate we charge ourselves each period), not Razorpay Subscriptions. Live from 12 November 2026; see "Razorpay Recurring Payments" below. | Razorpay Subscriptions cannot change plan or quantity on an Indian card or UPI subscription, and a cancel cannot be undone, so Fleet and plan changes cannot work on it. |
| **An INR upgrade applies at once; the difference is added to the next renewal**, never charged mid-period. A downgrade or an interval change waits for the period end. | RBI requires a pre-debit notice at least 24 hours before a card or UPI mandate debit, so an immediate charge would need the customer on a payment page again. |
| **Plan changes on Dodo Payments (and Paddle) apply at once and are prorated both ways** (`prorated_immediately`), after a preview and a confirmation. | Both providers support immediate proration and a plan-change preview endpoint. A customer sees the exact charge or credit before confirming. |
| **Moving to Mooring is a cancellation**, at the end of the paid period. | The customer keeps what they paid for. |
| **A period runs from the moment of payment to the same day and time next month (or year).** A plan bought on the 31st renews on the last day of shorter months and returns to the 31st (`addInterval` with the first payment's day as the anchor). | What Paddle does, and what a customer expects. Without the anchor, a 31 January start drifted to the 28th for good. |
| **An INR customer changes the saved card or UPI through support**, who send a payment link for the next renewal. | Razorpay has no self-service portal; a "change payment method" button that creates a ₹1 registration link is a later, small addition. |
| **A cancellation can be undone** until the period ends ("Keep plan"). | |
| **Refunds: 14 days from the first payment, once per customer, the first payment in full, then the subscription ends at once.** Issued by us, never self-serve. | The published guarantee. Ending the subscription stops a refunded customer keeping the plan. |
| **A failed payment never deletes data**: 7 days' grace after the paid period, then Mooring, and the provider subscription is cancelled. | Most cards recover on a retry; cancelling stops a customer paying twice. |
| **Fleet is billed on the count measured before each renewal (2 days before on Paddle; when the renewal is priced, 3 to 7 days before, on Razorpay), with no mid-month charge.** | A predictable bill; no proration arguments over a domain added on the 20th. |
| **Harbor at 80 domains moves to Fleet at $2 a domain (81 domains is $162), not to an add-on.** | Fleet carries 1,000 clients, 5,000 domains and unlimited members, so a $13 step for it is ordinary tier pricing. Kept deliberately. |
| **No GST is charged for now.** | Turnover is under the ₹20 lakh registration threshold. USD sales are exports (no GST) but count towards it. Register once close. |
| **Paddle tax is added on its page in the US and Canada, included elsewhere**; prices are shown before tax and the checkout box says so. | Paddle is the merchant of record and decides tax per country. |

## Which provider serves which customer

| | Razorpay | Dodo Payments | Paddle (dormant) |
|---|---|---|---|
| Role | Payment processor | **Merchant of record** | **Merchant of record** |
| Legal seller | You | Dodo Payments | Paddle |
| Invoices | Yours | Dodo Payments' | Paddle's |
| Sales tax outside India | **Your problem** | Dodo Payments collects and remits | Paddle collects and remits |
| Indian payment methods | UPI, netbanking, cards, eNACH | Cards, Apple Pay, Google Pay | Cards |
| Settlement | INR to your bank, about 2 working days after each payment | Payout to your Indian bank account | Monthly payout |
| Self service card update | Not available (a new mandate) | Full customer portal | Full billing portal |

**Routing rule:** INR checkouts go to Razorpay. USD checkouts go to Dodo Payments when Dodo is configured (`DODO_API_KEY`, `DODO_WEBHOOK_SECRET`, `DODO_ENVIRONMENT`), otherwise Paddle. `/api/capabilities` advertises USD for Dodo only when Dodo is configured AND every expected USD plan is stored in `billing_plan`.

A workspace with an existing subscription is never routed to a different
provider, because the providers cannot see each other's subscriptions. Moving a
provider would strand a paying customer on the free plan.

## Plans and prices

Prices live in `apps/api/src/services/entitlements/plan-catalog.ts` and are
held in **minor units** — cents for USD, paise for INR. Nothing in the billing
code handles a decimal amount, because a rounding error is a real charge.

| Plan | USD a month | INR a month | USD a year | INR a year |
|---|---|---|---|---|
| Mooring | $0 | ₹0 | $0 | ₹0 |
| Fairway | $39 | ₹3,299 | $390 | ₹32,990 |
| Harbor | $149 | ₹12,499 | $1,490 | ₹1,24,990 |
| Admiralty | $399 | ₹33,999 | $3,990 | ₹3,39,990 |

Fleet is billed monthly per active domain, in bands, and has no annual price.
Each band is its own provider plan (`billing_plan.band`), and the quantity sync
moves a subscription to the band its count falls in from the next period. The
count is Fleet's active domains: a domain counts if it sent a report in the last
30 days or was added in the last 14.

| Fleet band | USD per domain | INR per domain | Billed at least |
|---|---|---|---|
| Up to 200 | $2.00 | ₹169 | 75 |
| 201 to 500 | $1.25 | ₹106 | 320 |
| 501 to 2,000 | $1.00 | ₹85 | 625 |
| 2,001 to 5,000 | $0.75 | ₹64 | 2,667 |

Annual billing is ten months of price for twelve months of service. The figures
above match `apps/api/src/services/entitlements/plan-catalog.ts`, which is the
source of truth; change both together.

### Fleet, start to finish

- **Who it is for.** An account past Harbor's 80 domains or 20 clients, or past
  Admiralty's 300 domains or 75 clients. When Harbor or Admiralty refuses the
  next domain or client, the message and the billing page name Fleet.
- **The bill.** max(active domains, the band's minimum) × the band's price, for
  example 210 domains bill as 320 × $1.25 = $400. The band is the one the count
  falls in; each minimum makes the top of one band cost the same as the bottom
  of the next, so adding a domain never lowers the bill.
- **Checkout.** The first month is charged at the count measured at checkout
  (at least 75). On Paddle the checkout shows a quantity box; a count typed
  there is put back on the measured one after payment and the difference is
  charged or credited at once (`correctCheckoutQuantity`).
- **Growing.** Domains are added as on any plan, up to 5,000 domains and 1,000
  clients, with no plan change. A domain added mid-month is not charged until
  the next renewal.
- **Each renewal.** Two days before it, the count is measured and sent to the
  provider (`syncPerDomainQuantities`), changing band if the count crossed one.
  That count is the next month's bill; nothing is prorated.
- **Shrinking.** A domain stops counting 30 days after its last report (or 14
  days after it was added, whichever is later), so the bill falls at the first
  renewal after that.
- **Leaving Fleet.** To a flat plan only if the account fits its limits (a
  plan change is refused while over them); otherwise cancel, which keeps the
  paid month and then moves to Mooring.
- **No annual Fleet.** The count changes month to month.

## Plan changes, cancellation and what is kept

| | Paddle (USD) | Razorpay today (INR, Subscriptions) | Razorpay Recurring (INR, planned) |
|---|---|---|---|
| Upgrade | At once; the difference for the rest of the period is charged now | At the end of the paid period | At once; the prorated difference is added to the next charge |
| Downgrade | At once; unused time is credited to the next invoice | At the end of the paid period | At the end of the paid period |
| Fleet count | From the next period | From the next period | Computed at each charge |
| Cancel | At period end; "Keep plan" undoes it | At period end | At period end; undo until then |
| Card update | Paddle's portal | Not possible | A new mandate |

Every change is previewed and confirmed on the billing page. A downgrade or a
move to Fleet is refused while the account is over the target plan's limits,
and the page lists what to remove first.

**What a workspace keeps on a smaller plan** (a downgrade, a cancellation that
took effect, a refund, or dunning): every client, domain, report, alert rule
and audit entry. Nothing is deleted. Then:

- Over the new plan's limits, nothing is removed, but no new client, domain or
  member can be added until the count is under the limit. Reports for existing
  domains keep arriving and being stored.
- Features the plan does not include stop: alerts, the client portal, the API,
  PSA tickets and so on. Hosted DNS records keep being served but cannot be
  edited, and the owner is emailed the list with what to do about each.
- The uploaded logo is removed; a custom domain stops serving the agency's
  brand; members who sign in with SSO get 30 days to set a password.
- Paying again restores the plan and everything it carried.

Data is only deleted through Erasure, which the customer asks for.

## Provider plans live in the database

A tier in the catalog is not enough to charge a card. Each provider has its own
plan objects, and those identifiers are stored in the `billing_plan` table
rather than in configuration:

- a plan an operator created on the provider dashboard by hand is just as real
  as one created by code
- the mapping survives a deploy and can be read during support
- a **re-run of the sync reuses the existing mapping** rather than recreating
  it, because replacing a plan id would orphan any live subscription pointing
  at the old one

`GET /workspaces/{id}/billing/plan-sync?provider=RAZORPAY&currency=INR` reports
which plans still need creating.

### Price drift is refused, not tolerated

Checkout re-checks the stored provider price against the catalog on every
lookup, not only when the plan is saved. A price change in code that has not
been pushed to the provider fails loudly (`PLAN_PRICE_DRIFT`) instead of quietly
billing the old amount.

## Configuring Razorpay

```bash
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...   # separate from the API key secret
```

No Razorpay plans are created: Recurring Payments charges the catalog price in
`plan-catalog.ts`, so a price change needs no sync for INR.

Webhook URL `/api/webhooks/razorpay`. The events read are payment.captured,
payment.failed, order.paid, invoice.paid, invoice.expired and
token.confirmed/rejected/paused/cancelled/cancellation_initiated/authenticated.
Tick refund.processed and payment.dispute.* as well: they are recorded for
support, not acted on.

What the renewal job guarantees (audit, session 21):

- A renewal is claimed (`SCHEDULED` to `CHARGING`) before Razorpay is asked to
  charge it, and a charge whose answer never arrived is settled from the order's
  own payments, never charged again blind. A debit still unanswered after a week
  falls back to a payment link.
- A second payment for a period already paid, or for a checkout link that was
  closed because another was paid, is refunded in full automatically.
- A renewal link left unpaid past the period end makes the subscription past
  due, so the 7 day grace and the withdrawal follow as for a declined charge.
- An upgrade applies at once only when the saved mandate is confirmed and its
  limit covers the next renewal with the difference on it; otherwise it starts
  at the period end. Cancelling, or the mandate becoming unusable, while that
  difference is unpaid puts the plan back to the one the period was paid at.
- A scheduled downgrade is checked against the smaller plan's limits again at
  renewal and withdrawn (audited) if the workspace is over them.
- No plan change is accepted while a renewal is being debited.
Razorpay does not allow subscription.* and token.* on one webhook, and
subscription.* is no longer read. refund.* and payment.dispute.* are
acknowledged and not acted on (a refund is made from our own staff route).

Razorpay has **no self service billing portal**. "Invoices and payment method"
is not offered for INR; when a renewal waits on the customer, the billing page
offers its payment link instead, and paying it also sets up a new mandate.

## Razorpay Recurring Payments (INR)

Live from 12 November 2026, and tested end to end in test mode as an MSP owner
(session 11): card, UPI and eNACH checkout, renewals, upgrade, downgrade, Fleet,
a failed charge through dunning and recovery, cancel and undo, and a refund.

Razorpay holds no subscription. We hold the schedule, and charge a saved
mandate (a "token") each period.

- **Checkout** creates a registration link (`subscriptions.createRegistrationLink`,
  `type: link`) that takes the first payment and authorises the mandate in one
  step. The plan starts when the payment is captured (`payment.captured`,
  `order.paid` or `invoice.paid`, deduplicated by the order). The link is open
  for 2 days; the mandate lasts 10 years. A phone number is required (Razorpay
  refuses a recurring link without one). Starting a checkout closes any earlier
  unpaid one, and paying one closes the rest, so two can never both be paid.
- **The subscription key** is `rr_<first order id>`. A legacy `sub_…` row from
  Razorpay Subscriptions reads as gone and lapses at the end of its period.
- **Mandate maximum:** the larger of ₹1,00,000 or twice the charge; UPI's is
  ₹15,000.
- **Method, by RBI's ₹15,000 rule** (above it, a card or UPI debit needs the
  customer's approval each time):
  - up to ₹15,000 a charge: card (the default) or UPI Autopay;
  - above it: eNACH by default; a card is offered with a warning that the bank
    will ask the customer to approve each charge; UPI is refused
    (`METHOD_NOT_ALLOWED`).
  - eNACH carries the first payment as `first_payment_amount`, taken once the
    mandate is authorised.
- **Each renewal** is run by the hourly job `billing-recurring-renewals`
  (`runRecurringRenewals`):
  - 3 days before the period end, on a confirmed mandate that covers the
    amount: an order is created with Razorpay's pre-debit `notification`
    (card and UPI), the charge is recorded as `SCHEDULED`, and the owner gets
    our notice email with the amount, the date and, above ₹15,000 on a card or
    UPI, a line saying the bank will ask them to approve it.
  - At the period end, and no sooner than 36 hours 15 minutes after the bank
    received the notice, the token is charged (`CHARGING`). The result arrives
    by webhook; a charge with no answer after an hour is read from Razorpay by
    the job, and after three days falls back to a payment link.
  - 7 days before the period end, when the mandate is not confirmed (paused,
    cancelled, rejected) or is below the amount, or straight after a charge on
    it failed: a payment link for the renewal is emailed instead, open until
    the failed-payment grace ends. Razorpay does not retry a charge made with a
    pre-debit notice, so a failure always goes to a link. Paying the link
    renews the plan and replaces the mandate (the old one is cancelled).
- **A failed charge** makes the subscription `PAST_DUE` and dunning runs as on
  Paddle (warn, grace, withdraw). The billing page's dunning panel offers the
  payment link instead of a card portal.
- **Upgrade** (same interval, higher price): at once. The prorated difference
  for the rest of the period goes to `carryOverMinor` and is added to the next
  renewal; a renewal already announced at the old price is withdrawn and
  priced again. The carried amount is cleared only when the renewal carrying
  it is captured, and when the subscription ends.
- **Downgrade, or a change of interval:** at the period end, through
  `pendingPlan`. "Keep" clears it and re-prices an announced renewal.
- **Fleet:** each charge is billed for the active domains at that moment (at
  least the band's minimum) × the band's unit price. There is no quantity to
  push to Razorpay.
- **Cancel** sets the row's flag only, so it can be undone. At the period end
  the job ends the plan and cancels the mandate. `cancelImmediately` (refund,
  dunning withdrawal) does the same at once.
- **Ending a mandate** cancels it at Razorpay first (`PUT
  /customers/:id/tokens/:id/cancel`, which reaches NPCI or the bank), then
  deletes the token. Deleting alone leaves a UPI or eNACH mandate active at the
  bank, and Razorpay refuses it.
- **Refund** is of the first captured payment, through `payments.refund`.
- **Records:** every charge is a `billing_charge` row (kind FIRST or RENEWAL,
  channel TOKEN or LINK, status PENDING, SCHEDULED, CHARGING, CAPTURED, FAILED
  or EXPIRED), unique by order and by subscription, kind, period and attempt.
  A receipt is unique to one renewal attempt: Razorpay refuses a reused one.

## Configuring Dodo Payments

Dodo Payments (`https://dodopayments.com`) is the USD merchant of record. It
accepts Indian sole proprietors and settles payouts directly to an Indian bank
account.

```bash
DODO_API_KEY=...
DODO_WEBHOOK_SECRET=whsec_...
DODO_ENVIRONMENT=test_mode              # test_mode or live_mode (required when DODO_API_KEY is set)
DODO_TEST_WORKSPACE_IDS=ws_1,ws_2       # comma-separated workspace IDs allowed in test_mode
```

- **Explicit environment & test-mode safety on production**: `DODO_ENVIRONMENT`
  is set explicitly (`test_mode` -> `https://test.dodopayments.com`, `live_mode`
  -> `https://live.dodopayments.com`) rather than derived from `NODE_ENV`, so
  production can be verified end-to-end in `test_mode` before switching to
  `live_mode`. The API refuses to boot if `DODO_API_KEY` and
  `DODO_WEBHOOK_SECRET` are not set together or if `DODO_ENVIRONMENT` is omitted
  when `DODO_API_KEY` is set.
- **Test-mode workspace allowlist (`DODO_TEST_WORKSPACE_IDS`)**: When
  `DODO_ENVIRONMENT=test_mode`, Dodo accepts test cards, so USD checkout must
  never be offered to the public. In `test_mode`, `GET /api/capabilities`
  includes `USD` (`providers.dodo: true`) and `POST /api/workspaces/{id}/billing/checkout`
  permits USD checkout **only** when the workspace's `organizationId` is listed
  in `DODO_TEST_WORKSPACE_IDS` (comma-separated). Anonymous visitors and any
  workspace not in `DODO_TEST_WORKSPACE_IDS` see only `INR` in
  `/api/capabilities` and are refused at checkout with `503 PROVIDER_NOT_CONFIGURED`.
  When `DODO_ENVIRONMENT=live_mode`, `DODO_TEST_WORKSPACE_IDS` is ignored and
  USD is open to everyone.
- **Dashboard steps (in Test Mode first, then repeat in Live Mode)**:
  1. Toggle **Test Mode** in the Dodo Payments dashboard (`https://app.dodopayments.com`).
  2. Under **Business / Brand Settings**, set the business display name to
     `DMARC Harbor`, support email to `support@dmarcharbor.com`, and statement
     descriptor to `DMARCHARBOR`.
  3. Under **Developer → API Keys**, create a secret API key and set `DODO_API_KEY`
     plus `DODO_ENVIRONMENT=test_mode`.
  4. Under **Developer → Webhooks**, create a webhook endpoint pointing to
     `https://api.dmarcharbor.com/api/webhooks/dodo` and tick these events:
     - Subscription events: `subscription.active`, `subscription.renewed`,
       `subscription.plan_changed`, `subscription.updated`,
       `subscription.unpaused`, `subscription.past_due`, `subscription.on_hold`,
       `subscription.paused`, `subscription.failed`, `subscription.cancelled`,
       `subscription.expired`
     - Payment events: `payment.succeeded`, `payment.failed`
     - Refund & dispute events: `refund.succeeded`, `refund.failed`,
       `dispute.opened`, `dispute.expired`, `dispute.accepted`,
       `dispute.cancelled`, `dispute.challenged`, `dispute.won`, `dispute.lost`
  5. Copy the signing secret (`whsec_...`) from the webhook endpoint and set
     `DODO_WEBHOOK_SECRET`.
- **Plan sync**:
  Run the staff plan-sync endpoint once per environment (test mode, and again
  after switching to live mode):
  ```bash
  curl -X POST "https://api.dmarcharbor.com/api/billing/plan-sync?provider=DODO&currency=USD" \
    -H "Authorization: Bearer $STAFF_API_KEY"
  ```
  Each catalog plan entry (`expectedPlans('USD')`: Fairway, Harbor and Admiralty
  monthly and annual, plus Fleet bands 0 to 3 — 10 products total) is created in
  Dodo as a recurring SaaS product (`tax_category: 'saas'`, `currency: 'USD'`,
  `subscription_period_count: 20`, `subscription_period_interval: 'Year'`) and
  stored in `billing_plan` under provider `DODO`. Re-running the route is
  idempotent and reuses existing stored rows. Until all 10 USD plans are stored
  and ready, `providerReady('DODO')` is `false` and `GET /api/capabilities` will
  not advertise `USD`.
- **Checkout & attribution**:
  `createCheckout` creates a hosted Dodo Checkout Session (`POST /checkouts`)
  with `return_url` set to `<APP_URL>/billing?checkout=complete`, currency
  selection locked to USD, and `metadata` carrying `organizationId` plus a
  server-signed HMAC token (`dodoAttribution`). The browser redirects to Dodo's
  hosted checkout URL directly (no CSP changes or client SDK needed). On
  `subscription.active`, if the customer edited a Fleet quantity during
  checkout, `correctCheckoutQuantity` immediately restores the server-measured
  count with `proration_billing_mode: 'prorated_immediately'`.
- **Plan changes & Fleet quantity sync**:
  Plan changes call `subscriptions.changePlan` with
  `proration_billing_mode: 'prorated_immediately'` and
  `on_payment_failure: 'prevent_change'` after previewing via
  `subscriptions.previewChangePlan`. Pre-renewal Fleet quantity and band changes
  (`syncPerDomainQuantities`) call `subscriptions.changePlan` with
  `proration_billing_mode: 'do_not_bill'` so the current period is not repriced.
- **Customer portal**:
  `POST /api/workspaces/{id}/billing/portal` creates a Dodo Customer Portal
  session (`customers.customerPortal.create`) with `return_url` set to
  `<APP_URL>/billing`.
- **Refunds & reconciliation**:
  `issueRefund` finds the subscription's initial succeeded payment
  (`charge_type === 'new'` or earliest `created_at`), refunds it in full via
  `POST /refunds`, and cancels the subscription immediately (`status: 'cancelled'`).
  `runReconciliation` fetches live subscription state via
  `GET /subscriptions/{id}` and repairs any missed webhook.
- **Switching from test mode to live mode**:
  After verifying checkout, plan changes, portal, cancellation and refund in
  `test_mode`, switch the Dodo dashboard to **Live Mode**, create a live API key
  and live webhook endpoint (`https://api.dmarcharbor.com/api/webhooks/dodo`),
  delete the test `DODO` rows from `billing_plan` (or update them), set
  `DODO_API_KEY`, `DODO_WEBHOOK_SECRET` and `DODO_ENVIRONMENT=live_mode`, deploy,
  and run `POST /api/billing/plan-sync?provider=DODO&currency=USD`.

## Configuring Paddle (dormant)

Verified end to end against the Paddle sandbox in session 11: checkout, the
customer portal, upgrade and downgrade with proration, cancel and keep, Fleet
quantity and band moves, a real renewal, a failed renewal through dunning and
recovery, and a refund.

```bash
PADDLE_API_KEY=...
PADDLE_WEBHOOK_SECRET=...
NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=...   # apps/web; a test_ token opens the sandbox
```

- **Checkout** opens on our own `/pay?_ptxn=` page (Paddle.js). Set Paddle >
  Checkout > Default payment link to `https://<app host>/pay`. The CSP allows
  Paddle's hosts on that page only.
- **Webhook destination**: subscription.*, transaction.* and adjustment.*,
  pointed at `/api/webhooks/paddle`.
- **Quantity**: a flat plan's price accepts exactly 1, so the checkout shows no
  quantity stepper. A Fleet price must accept 1 to 5,000 for the monthly sync,
  so the checkout lets the customer edit the count; on `subscription.created`
  the count is put back on the measured one and the difference for the started
  period is billed or credited at once (`correctCheckoutQuantity`). A failed
  correction is audited and the next sync before renewal fixes the count.
- **Tax**: Paddle adds sales tax on top in the US and Canada and includes it in
  the price elsewhere. The checkout box on the billing page says so.
- **Plan changes** apply at once with `prorated_immediately`, after a preview
  (`POST /billing/plan/preview`) and a confirmation dialog.
- **Refunds** refund the subscription's first completed transaction in full and
  then cancel the subscription immediately.

Paddle is the merchant of record, so international sales tax is handled by them
rather than by us. Payouts are monthly by bank transfer, in USD to a bank
account that accepts international transfers (or a Wise USD account); set it up
in Paddle's payout settings. That is a finance task, not a code task.

## Refunds

The guarantee (`refundGuaranteeDays`, 14) is in `docs/REFUND-POLICY.md`: the
first payment, within 14 days, once per customer (every workspace the owner
owns is checked), no reason needed. Outside it, a refund is a goodwill decision.

What a refund does (`issueRefund`):

1. Refunds the first payment of the subscription in full, tax included (on
   Paddle, its first completed transaction).
2. Cancels the subscription at once, so the workspace moves to Mooring now,
   not at the end of the period. Everything is kept, as above.
3. Records the refund (`refund_record`, `REFUND_ISSUED` in the audit log). A
   refusal is recorded too, with its reason.

A prorated upgrade charge made later in the period is a separate payment and is
not part of the guarantee refund; refund it from the provider's dashboard if you
decide to.

**Who bears the cost.** The customer gets back everything they paid. Paddle
returns the tax and keeps its fee, so a refund costs us the fee: in the
sandbox, $42.46 paid ($39 + $3.46 tax) left our Paddle balance as $39.00, of
which we had earned $36.38, so $2.62 was ours. Inside 14 days the money is
normally still in the Paddle balance (paid out monthly); if it was already paid
out, the balance goes negative and the next payout covers it. Razorpay settles
to the bank in about 2 working days, so an INR refund is taken from the Razorpay
balance or held from the next settlements; Razorpay keeps its fee (about 2% +
GST on it) and charges nothing for a normal refund.

### Handling a refund request

There is no staff screen yet; the two staff routes take the `STAFF_API_KEY` as a
bearer token.

1. **Confirm who is asking.** Reply only to the email address of the account
   that owns the workspace (Settings shows the owner). A request from any other
   address is answered by asking the owner to write from their account address.
2. **Find the workspace** they mean, then check eligibility:
   `GET /api/workspaces/{id}/refund-eligibility`. It answers whether it is
   eligible and why, the first payment date, the last eligible day, the amount
   and whether this customer has had a guarantee refund before.
3. **Check it against the provider.** Paddle: Customers → the email → the
   transaction (date, amount, card). Razorpay: Payments → search by email. The
   date and amount should match what the eligibility check says, and the
   customer email should be the account owner's.
4. **Look for abuse** before a goodwill refund: the same name, card or company
   behind several accounts, or a chargeback already open (Paddle: the
   transaction shows it; Razorpay: Disputes). With a chargeback open, do not
   refund as well; answer the dispute.
5. **Refund**: `POST /api/workspaces/{id}/refund` with
   `{ "reason": "<what they said, and your decision>" }`, adding
   `"overrideWindow": true` only for a deliberate goodwill refund outside the
   14 days.
6. **Check it went through.** Paddle: the transaction shows the refund
   adjustment (a live refund can wait for Paddle's approval before it is
   final); Razorpay: the payment shows the refund. The workspace is on Mooring.
7. **Tell the customer** the amount and the timing (Razorpay 3 to 5 business
   days, Paddle 5 to 10) and that their data is kept.

Refund through our route, not from the provider's dashboard. A refund made in
the dashboard is not seen by the app: the subscription keeps running. If Paddle
refunds a customer directly, cancel the subscription in Paddle as well, and the
webhook moves the workspace to Mooring.

## The rule that matters most

**Nothing marks a workspace as paid because a request arrived.**

`POST /billing/checkout` only returns a hosted URL. The plan changes when a
signature verified webhook confirms money moved. A customer closing the tab, a
failed bank transfer and a bot replaying a request are all indistinguishable
from success if you trust the browser redirect.

## Webhooks

```
POST /api/webhooks/razorpay    x-razorpay-event, x-razorpay-signature
POST /api/webhooks/dodo        webhook-id, webhook-timestamp, webhook-signature
POST /api/webhooks/paddle      paddle-signature
```

The raw body is preserved by a `verify` hook on the JSON body parser and never
re-serialised, because all three providers sign the exact bytes they sent. This is
the usual cause of a webhook that "sometimes" verifies.

**Signature verification**
- Razorpay: HMAC of the raw body, checked by the SDK
- Dodo Payments: Standard Webhooks (`webhook-id`, `webhook-timestamp`,
  `webhook-signature`), HMAC-SHA256 over `<id>.<timestamp>.<raw body>` using the
  base64-decoded `whsec_` secret, compared in constant time with a five minute
  timestamp tolerance
- Paddle: `ts=<seconds>;h1=<hex>` where the HMAC covers `<timestamp>:<raw body>`,
  with a five minute tolerance so an old but valid signature cannot be replayed

**Idempotency** — both providers redeliver until acknowledged, often out of
order. Every event is deduplicated on the provider event id *inside the same
transaction* as the state change, so a redelivery hits a unique constraint and
exits early. Tested including a genuine concurrent double delivery.

**Atomicity** — the subscription row, the organisation's plan and the audit log
are written in one transaction. Entitlement resolution reads the organisation,
so a crash between those writes would mean paying for a plan you cannot use.

**Attribution** — the first event for a workspace is matched through the notes
attached at checkout, because no subscription row exists yet. Later events match
on the stored provider subscription id.

An unrecognised event is acknowledged with `200` and ignored, otherwise the
provider retries forever for something that will never change.

## Dunning and reconciliation

Two scheduled jobs, both in the alert scheduler on their own intervals.

**Dunning** (daily, `BILLING_DUNNING_INTERVAL_MINUTES`) — a failed payment
never destroys data:

1. Paid period still running → untouched
2. Period ended, inside the 7 day grace → `PAYMENT_FAILED` audit, the "Payment
   failed" email, access kept
3. Grace exhausted → downgraded to the free plan, **all clients, domains and
   reports kept**; the provider subscription is cancelled so it stops retrying,
   and the owner gets a "moved to Mooring" email. Choosing a plan again starts a
   new subscription and restores what the old plan carried.

Nothing is ever charged by dunning. Retrying a payment method is the provider's
job, since it is the only party that can safely do it. Cancelling at step 3 is
what keeps a customer from paying twice: without it, Paddle could still collect
the old subscription after the billing page had offered a new checkout.

Paddle opens the next period when it attempts a renewal, paid or not. A past
due subscription is therefore stored as paid through the start of that unpaid
period (`paddlePaidThrough`), otherwise the grace would only start a month
later.

**Reconciliation** (every 6 hours, `BILLING_RECONCILE_INTERVAL_MINUTES`) —
compares every subscription against the provider. This is the safety net for
webhooks that never arrive, because a provider retries a few times and then
gives up:

- a lost *upgrade* webhook would otherwise leave a customer who paid on the free
  plan, and nobody would know
- a lost *expiry* webhook would otherwise leave a customer on a paid plan
  indefinitely, costing money silently

## Self service

| Endpoint | Does |
|---|---|
| `GET /workspaces/{id}/billing` | Current plan, status, period end, price |
| `POST /workspaces/{id}/billing/checkout` | Start a subscription |
| `POST /workspaces/{id}/billing/plan/preview` | What a plan change would charge now and at the next invoice, before confirming |
| `PATCH /workspaces/{id}/billing/plan` | Change plan: at period end on Razorpay, at once with proration on Dodo Payments and Paddle |
| `POST /workspaces/{id}/billing/cancel` | Cancel, keeping the paid period |
| `POST /workspaces/{id}/billing/resume` | Undo a pending cancellation |
| `POST /workspaces/{id}/billing/portal` | Hosted portal (Dodo Payments and Paddle) |
| `GET /workspaces/{id}/billing/plan-sync` | Which plans need creating |
| `POST /billing/plan-sync` | Staff only: create missing provider plans and return the sync report |

Moving a plan to Mooring is treated as a **cancellation**, not a plan change,
so the customer keeps the period they paid for.

**A plan change is refused while the account is over the target plan's limits**
(`409 PLAN_CHANGE_OVER_QUOTA`): clients and active domains across every
workspace the account owns, team members in the workspace, and the workspaces
the account owns. Each exceeded limit is a row in `error.overage` with `quota`,
`used`, `limit` and `by`, and the refusal is recorded as
`BILLING_PLAN_CHANGE_REFUSED`. Checked before the provider is called, and for
every target, not only a smaller plan. A cancellation is never refused: the
workspace moves to Mooring at the end of the period with everything kept, and
further clients, domains and members are refused until it is within Mooring's
limits.

## Not built yet

- **Raising an INR mandate maximum in place.** A Fleet bill that grows past the
  mandate's maximum renews through a payment link, which registers a new,
  larger mandate; there is no separate "raise your maximum" step.
- **A staff screen for refunds.** Today they are two API calls with the staff key.
- **Refunds made outside the app** (Paddle's dashboard or Paddle's own buyer
  support, the Razorpay dashboard, a lost dispute) are recorded against the
  workspace's audit trail (`provider_refund_or_dispute`) and logged as an error
  from the `adjustment.*`, `refund.*` and `payment.dispute.*` webhooks, but the
  app does not end the subscription by itself: support decides.
- **Trials.** Mooring is the free tier and is the real trial. A time limited
  trial on Admiralty would hand over the custom domain and SSO for nothing, and
  neither can be evaluated in a fortnight anyway.
- **Usage based metering** beyond the active domain rule already in place.
- **Provider migration.** A customer cannot move from Razorpay to Paddle without
  a deliberate migration path, because the two cannot see each other.
