# DMARC Harbor Billing

How money moves, which provider handles which customer, what each plan change,
cancellation and refund does, and what happens when a payment fails.

## Decisions on record

Made in session 11 (November 2026), with the reason for each. Change one only
with its reason in view.

| Decision | Why |
|---|---|
| **INR on Razorpay, USD on Paddle.** | Paddle on INR costs about 5% + $0.50 a payment; Razorpay about 2%. Stripe is invite-only for Indian businesses. |
| **INR moves from Razorpay Subscriptions to Razorpay Recurring Payments** (a mandate we charge ourselves each period). Waiting on Razorpay to enable it; see "Razorpay Recurring Payments" below. | Razorpay Subscriptions cannot change plan or quantity on an Indian card or UPI subscription, and a cancel cannot be undone, so Fleet and plan changes cannot work on it. |
| **Plan changes on Paddle apply at once and are prorated both ways** (`prorated_immediately`), after a preview and a confirmation. | Paddle cannot schedule a price change. A customer sees the exact charge or credit before confirming. |
| **Moving to Mooring is a cancellation**, at the end of the paid period. | The customer keeps what they paid for. |
| **A cancellation can be undone** until the period ends ("Keep plan"). | |
| **Refunds: 14 days from the first payment, once per customer, the first payment in full, then the subscription ends at once.** Issued by us, never self-serve. | The published guarantee. Ending the subscription stops a refunded customer keeping the plan. |
| **A failed payment never deletes data**: 7 days' grace after the paid period, then Mooring, and the provider subscription is cancelled. | Most cards recover on a retry; cancelling stops a customer paying twice. |
| **Fleet is billed on the count measured 2 days before each renewal, with no mid-month charge.** | A predictable bill; no proration arguments over a domain added on the 20th. |
| **Harbor at 80 domains moves to Fleet at $2 a domain (81 domains is $162), not to an add-on.** | Fleet carries 1,000 clients, 5,000 domains and unlimited members, so a $13 step for it is ordinary tier pricing. Kept deliberately. |
| **No GST is charged for now.** | Turnover is under the ₹20 lakh registration threshold. USD sales are exports (no GST) but count towards it. Register once close. |
| **Paddle tax is added on its page in the US and Canada, included elsewhere**; prices are shown before tax and the checkout box says so. | Paddle is the merchant of record and decides tax per country. |

## Which provider serves which customer

| | Razorpay | Paddle |
|---|---|---|
| Role | Payment processor | **Merchant of record** |
| Legal seller | You | Paddle |
| Invoices | Yours | Paddle's |
| Sales tax outside India | **Your problem** | Paddle collects and remits |
| Indian payment methods | UPI, netbanking, cards, eNACH | Cards |
| Fee | About 2% (+18% GST on the fee) | 5% + $0.50 |
| Settlement | INR to your bank, about 2 working days after each payment | Monthly payout: created on the 1st, sent by the 15th |
| Self service card update | Not available (a new mandate) | Full billing portal |

**Routing rule:** INR checkouts go to Razorpay, everything else goes to Paddle.

A workspace with an existing subscription is never routed to a different
provider, because the two cannot see each other's subscriptions. Moving a
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

Then create the plans:

```ts
await new RazorpayBillingProvider().syncPlans('INR');
```

Webhook URL `/api/webhooks/razorpay`, with subscription.*, payment.failed,
refund.* and payment.dispute.created/lost ticked. Recurring Payments also needs
payment.captured, order.paid, invoice.paid, invoice.expired and token.*.

**Today the code uses Razorpay Subscriptions.** Razorpay has no plan change
endpoint, but it does support a scheduled change, so an upgrade or downgrade is
applied at the end of the current cycle. Tested in session 11: checkout of a
Fairway subscription works, but on an Indian card or UPI subscription Razorpay
refuses any change except offers ("Only offers can be updated for subscriptions
when payment mode is domestic card"), and a cancellation cannot be undone. That
is why INR is moving to Recurring Payments.

Razorpay has **no self service billing portal**. The billing page links to the
subscription's own Razorpay page; a card is changed by a new mandate.

## Razorpay Recurring Payments (INR, planned)

Waiting on Razorpay to enable the feature on the account (ticket raised,
November 2026). Until then `POST /v1/payments/create/recurring` answers 400
"The requested URL was not found on the server". A card mandate registration
and its first payment already work in test mode (session 11). The build list is
in `docs/TESTING-PLAN.md` under "Razorpay Recurring Payments".

How it will work:

- **Checkout** creates a registration link (`subscription_registration`,
  `frequency: as_presented`) that takes the first payment and authorises a
  mandate up to a maximum. The plan starts when Razorpay confirms the payment.
- **Mandate maximum:** the larger of ₹1,00,000 or twice the current charge.
- **Method, by RBI's ₹15,000 rule** (above it, a card or UPI charge needs the
  customer's approval each time):
  - up to ₹15,000 a charge: card or UPI Autopay;
  - above it: eNACH (netbanking or debit card) by default; a card is offered
    with a warning that the bank will ask the customer to approve each charge;
    UPI is not offered.
  - eNACH cannot debit on the day it is registered, so the first payment is
    taken separately and the plan starts at once.
- **Each renewal** our job creates an order and charges the saved token. A
  pre-debit email goes 3 days ahead with the amount.
- **Upgrade:** at once; the prorated difference is added to the next charge.
  **Downgrade:** at the end of the paid period.
- **Fleet:** the amount is computed at each charge (count × band, at least the
  band's minimum). If it would exceed the mandate maximum, the owner is asked to
  raise it 7 days ahead; if they do not, the charge fails and dunning applies.
- **Cancel** stops future charges; it can be undone until the period ends.
- **Refund** goes through Razorpay's refund API on the first payment.

## Configuring Paddle

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
POST /api/webhooks/paddle      paddle-signature
```

The raw body is preserved by a `verify` hook on the JSON body parser and never
re-serialised, because both providers sign the exact bytes they sent. This is
the usual cause of a webhook that "sometimes" verifies.

**Signature verification**
- Razorpay: HMAC of the raw body, checked by the SDK
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
| `PATCH /workspaces/{id}/billing/plan` | Change plan: at period end on Razorpay, at once with proration on Paddle |
| `POST /workspaces/{id}/billing/cancel` | Cancel, keeping the paid period |
| `POST /workspaces/{id}/billing/resume` | Undo a pending cancellation |
| `POST /workspaces/{id}/billing/portal` | Hosted portal (Paddle only) |
| `GET /workspaces/{id}/billing/plan-sync` | Which plans need creating |

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

- **Razorpay Recurring Payments** (above), which brings an immediate INR
  upgrade with the difference on the next charge. Until it ships, an INR change
  is scheduled for the end of the period.
- **A staff screen for refunds.** Today they are two API calls with the staff key.
- **Refunds made outside the app** (Paddle's dashboard or Paddle's own buyer
  support) are not read from the `adjustment.*` webhooks, so the app does not
  end the subscription by itself.
- **Trials.** Mooring is the free tier and is the real trial. A time limited
  trial on Admiralty would hand over the custom domain and SSO for nothing, and
  neither can be evaluated in a fortnight anyway.
- **Usage based metering** beyond the active domain rule already in place.
- **Provider migration.** A customer cannot move from Razorpay to Paddle without
  a deliberate migration path, because the two cannot see each other.
