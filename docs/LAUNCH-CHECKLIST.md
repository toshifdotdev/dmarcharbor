# Launch sequence

Everything that has to happen, in the order it has to happen, and what blocks
what. Written down because the order is not obvious and getting it wrong wastes
real time: you cannot verify a payment webhook before the provider account
exists, and you cannot point a DMARC `rua` tag at a mailbox that is not yet
receiving.

Two lists, because they behave differently:

- **Strictly sequential.** Each step is impossible or meaningless until the one
  above it is done.
- **Can run in parallel.** Grouped by who is waiting on whom.

Tick boxes as you go. Nothing here is done because it was written down.

---

## Part 1 — Strictly sequential

### 1. Buy the domain

Everything downstream needs a hostname, so this is genuinely first.

- Choose the apex domain, not just a subdomain.
- Decide registrar. Any is fine; this is not a technical decision.
- **Set DNS to Cloudflare** as you go, so the nameservers are right before
  anything needs to resolve.
- Decide whether WHOIS privacy is on. It should be.

Nothing else can start, because every callback URL, OAuth redirect, SAML
endpoint and MX record needs a name that resolves.

### 2. Decide hosting, then create the database

- Pick a region. **This is the data residency answer** — see the note at the
  bottom, it is the decision everything else waits on.
- Provision PostgreSQL. Managed beats self hosted at this stage.
- Run the migrations against it:
  `npx prisma migrate deploy --schema apps/api/prisma/schema.prisma`
- Confirm `prisma migrate status` reports no pending migrations.

### 3. Generate secrets, and store them somewhere durable

Generate each with `openssl rand -base64 32` or equivalent. Store in a secrets
manager, never in the repo, never in a shell profile that gets committed.

| Variable | Why it matters if it is wrong |
|---|---|
| `BETTER_AUTH_SECRET` | Signs session cookies. Known value means anyone can forge a session. |
| `FORENSIC_PII_ENCRYPTION_KEY` | Encrypts forensic recipient data. Known value means the PII is readable. |
| `FORENSIC_PSEUDONYM_SECRET` | Derives stable pseudonyms. Known value means a sender can be correlated across reports. |
| `REPORT_INGEST_SECRET` | Authenticates inbound report delivery. |
| `STAFF_API_KEY` | Authorises plan changes and entitlement overrides. |

The first three have development defaults in the schema and the service refuses
to boot in production if they are still set to those defaults, so this step
fails loudly rather than silently. That guard is the reason to deploy *after*
this step, not before.

**`FORENSIC_PII_ENCRYPTION_KEY` cannot be rotated later without re-encrypting
existing forensic rows.** Choose it carefully and back it up somewhere you will
still have in three years.

### 4. Write the environment file

Only now. Steps 2 and 3 are inputs to it, and writing it earlier means writing
it twice with placeholders in between.

Required for a production boot:

```
NODE_ENV=production
DATABASE_URL=postgresql://...
BETTER_AUTH_URL=https://dmarcharbor.com
CORS_ORIGIN=https://app.dmarcharbor.com
BETTER_AUTH_SECRET=...
REPORT_INGEST_SECRET=...
FORENSIC_PII_ENCRYPTION_KEY=...
FORENSIC_PSEUDONYM_SECRET=...
EMAIL_PROVIDER=resend
RESEND_API_KEY=...
EMAIL_FROM=DMARC Harbor <alerts@dmarcharbor.com>
STAFF_API_KEY=...
```

`PORT` is the only one that should stay at its default if you are on a platform
that injects it.

### 5. Trans transactional email

Before any customer-facing flow, because invites, password resets, domain
verification and billing mail all go through it and all silently no-op
otherwise.

- Create a Resend account, verify the sending domain on DNS.
- Set `EMAIL_FROM` to a subdomain you can afford to have a DMARC record on.
- Send one real message from a scratch account and confirm it arrives.
- Add a DMARC record for the sending subdomain, starting at `p=none`.

### 6. Object storage for logos

- Create the bucket, **private**, in the same region as the database.
- CORS: allow `PUT` from the app origin only.
- IAM: a key scoped to `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on that
  one bucket. Not `s3:*`.
- CloudFront or equivalent in front of it, as a **separate origin**.
- Security headers on assets: `Content-Security-Policy: sandbox`,
  `X-Content-Type-Options: nosniff`, long cache.
- Lifecycle rule to delete objects unreferenced for 30 days.
- Then set `LOGO_BUCKET`, `ASSETS_ORIGIN`, `LOGO_CDN_ORIGIN`, and the AWS
  credentials.

SVG is served from this origin under a sandbox policy, which is the only reason
SVG uploads are safe here. Do not drop that header.

### 7. Payment providers

Only after the app can boot and email works, because a webhook that arrives
before the app is live is a webhook that is silently lost.

**Razorpay**
- Complete KYC, MSME/Udyam registration.
- Create the three products and plans, then run the plan sync so ids land in
  `billing_plan`.
- Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.
- Webhook URL: `https://api.dmarcharbor.com/api/billing/webhooks/razorpay`.
- **Verify the subscription end date bound in a sandbox.** This is the single
  riskiest unverified thing in the codebase. A value outside what the account
  permits means subscriptions are rejected, or silently end early.

**Paddle**
- Requires site approval, so **start this early** — it is the long pole.
- Create the product and prices, set a webhook destination.
- Set `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`.
- **Confirm the plan change applies at cycle end.** The code asks for that and
  the provider appears to apply it immediately; this is unverified and would
  mean an upgrade is free until renewal.

**Payout** is separate and unresolved: a Paddle account cannot pay an Indian
bank account directly. You need an FCRA-registered entity or Wise, and this
affects whether INR customers can pay at all.

### 8. The report mailbox, last

Last because it is the only step that needs the domain, the DNS and a decision
you have not made yet.

- Buy the Migadu Micro mailbox, about $19/year. There is no free tier worth
  using for this.
- Create one shared mailbox, for example `agg@reports.dmarcharbor.com`.
- Point `REPORT_AGGREGATE_ADDRESS` and `REPORT_FORENSIC_ADDRESS` at it.
- Publish the MX record.
- Verify with `dig MX dmarcharbor.com`.
- Then, and only then, can a customer be told to put that address in their
  `rua` tag.

**Until the domain exists, the inbox can be coded but cannot be smoke tested.**
The polling path has never run against a real mail server. Test it against this
mailbox before trusting it.

### 9. Autoscaling hardening

Before a second instance exists, not after. Retrofitting claims into a live
product with customers on it is much harder than adding them now.

Every scheduler currently starts on every instance, and only the *webhook*
delivery is claimed atomically. Still duplicated across N instances:

- Report digests — customers get the same weekly email N times
- Erasure execution — GDPR completion mail N times, and a `delete` that throws
  on the loser
- Alert first trigger — duplicate events, mail and webhooks
- Alert escalation — a unique-constraint race that aborts the whole tick
- Dunning — duplicate payment failure mail
- Domain re-verification — duplicate verification mail, N× the DNS load
- IMAP polling — N× logins to the customer's mail host

The fix is the same in every case: claim the row with a conditional update keyed
on the observed state, require `count === 1`, and give it a lease so a crashed
instance's work is reclaimed. It is roughly a day.

`ALERT_SCHEDULER_DISABLED` remains an emergency kill switch. It is not a leader
election and must not be used as one.

### 10. Data residency and sub-processors

Revisit after the frontend, as agreed. The blocker is step 2: the region is the
answer, and the Trust Center and compliance pack both publish a placeholder
string that is honest but not usable by a procurement team.

- Name each sub-processor and its jurisdiction. Outstanding: object storage,
  the report mailbox, the transactional email provider, the payment processors.
- Decide whether EU-only residency is offered as a feature. Probably not at
  this scale.
- Replace the placeholder in the compliance pack and the Trust Center.

A non-EU sub-processor is not automatically unlawful. Standard Contractual
Clauses plus a signed DPA make a transfer lawful. The gap is paperwork and
naming, not code.

### 11. Downgrade over-quota

Before the first downgrade is requested by a real customer.

There is no guard. Twelve clients on Harbor, downgraded to Fairway which allows
five: all twelve stay, fully working, and the API reports the limit with no
usage, so the mismatch is invisible until the next creation fails with a
misleading message.

- Preflight the target plan's limits against current usage in `changePlan()`.
- Refuse with the overage listed, or require explicit acknowledgement.
- Surface `used` and `limit` in the entitlement payload so the UI can show it.
- Add a `pendingPlan` column so a scheduled change is visible before it happens.

---

## Part 2 — Can run in parallel

**Your accounts, your calendar, nothing depends on the app**

- Paddle site approval — start this now, it is the longest lead time
- Razorpay MSME/Udyam registration
- Decide the payment payout route
- Professional review of the privacy policy, DPA and terms
- Get a real TLS certificate budget and any SOC 2 scoping decision

**Needs the app running locally, not deployed**

- Smoke test SSO against a real Okta or Entra tenant. Never run against a live
  identity provider. Expect to fix things on first contact; the library paths
  are tested but the flows are not.
- Smoke test IMAP against the real mailbox, as noted in step 8

**Frontend, your other agent**

- The whole app
- See the separate handoff prompt

---

## Definition of done

- [ ] Every step in Part 1 ticked
- [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:integration`
      all green
- [ ] `npx prisma migrate status` clean against production
- [ ] One real signup, one real domain verified, one real report ingested
- [ ] One real payment, and the plan actually moved
- [ ] One real invite email, arriving
- [ ] One real logo uploaded and served from the asset origin
- [ ] One real Trust Center page
- [ ] One real compliance pack issued and verified by its digest
- [ ] Two instances running, with no duplicated email and no duplicated webhook
- [ ] Sub-processors named, residency question answered
