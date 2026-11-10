# DMARC Harbor Billing

How money moves, which provider handles which customer, and what happens when a
payment fails.

## Which provider serves which customer

| | Razorpay | Paddle |
|---|---|---|
| Role | Payment processor | **Merchant of record** |
| Legal seller | You | Paddle |
| Invoices | Yours | Paddle's |
| Sales tax outside India | **Your problem** | Paddle collects and remits |
| Indian payment methods | UPI, netbanking, wallets | Cards |
| Settlement | INR to an Indian account | USD or INR, see below |
| Self service card update | Not available | Full billing portal |

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

Razorpay has no plan change endpoint, but it does support a scheduled change,
so an upgrade or downgrade is applied at the end of the current cycle and can
be reversed with `cancelScheduledChanges`. That is why a plan change never
produces a prorated charge.

Razorpay has **no self service billing portal**. The API returns `501` for
`/billing/portal` on Razorpay rather than pretending one exists; a card is
updated by starting a new subscription.

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
rather than by us. The trade off is settlement: Paddle pays in its supported
currencies, and receiving USD into an Indian bank account needs an FCRA or Wise
arrangement. That is a finance task, not a code task.

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

- **Proration on Razorpay.** A Razorpay plan change is scheduled for the end of
  the period, never charged mid cycle. If a customer needs to downgrade and start
  the cheaper plan immediately, that needs a credit of the unused time and is a
  separate piece of work. Paddle cannot schedule a price change, so there a
  change applies at once and Paddle prorates it.
- **Trials.** Mooring is the free tier and is the real trial. A time limited
  trial on Admiralty would hand over the custom domain and SSO for nothing, and
  neither can be evaluated in a fortnight anyway.
- **Usage based metering** beyond the active domain rule already in place.
- **Provider migration.** A customer cannot move from Razorpay to Paddle without
  a deliberate migration path, because the two cannot see each other.
