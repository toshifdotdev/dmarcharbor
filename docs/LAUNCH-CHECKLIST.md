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

## Decisions taken

Four questions this checklist once listed as open are settled. Recorded here so
they are not asked again, and because each one removes a sub-processor
obligation or a false option.

**The domain is `dmarcharbor.com`.** Chosen, not yet bought: it is the last
infrastructure purchase rather than the first, so the code is finished against
it and the DNS is a short task once it is owned. `app.dmarcharbor.com` and
`api.dmarcharbor.com` are the two subdomains, which is what the CI job already
assumes (`ci.yml`). WHOIS privacy on. Registrar is Spaceship.

**Report collection: Migadu plus Cloudflare.** Not Cloudflare alone.

The IMAP path and the inbound webhook both exist, so dropping Migadu and
pointing the Worker straight at the API was a real option. It was declined for
two reasons. Gmail publishes reports by sending mail and offers nothing else, so
a Worker-only deployment stops reporting for the largest population of
customers unless we own their MX. And the unauthenticated ingress would then be
the only thing keeping strangers out, where IMAP is gated by mailbox
credentials that already work today.

Migadu and Cloudflare stay two sub-processors because they do two jobs:
Cloudflare answers the DNS question and does not store, Migadu holds the
mailbox. Neither can do the other's.

**Data residency: one region, no EU-only tier.** The region is Singapore. See
the note in step 2 for why customer reach decided it rather than latency.

**Still open, and still blocking:** the legal entity name, the hosting platform,
the payment accounts, the transactional email domain, and the report mailbox.

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

Optional, for agencies with white label:

```
CLIENT_EMAIL_FROM_ADDRESS=reports@mail-relay.example
# Full-access Resend key, used only for agency sending domains (step 5b).
RESEND_DOMAINS_API_KEY=...
```

Client facing email from a white-labelled workspace (portal invitations,
approval requests, monthly reports, digests, and a password reset or email
verification started on an agency's own domain) is sent as
`"<agency workspace name>" <CLIENT_EMAIL_FROM_ADDRESS>`. Unset, the address part
of `EMAIL_FROM` is used with the agency's name in front. See step 5 for the DNS
it needs.

Required for the web app (`apps/web`, see `apps/web/.env.example`):

```
API_BASE_URL=https://<the API's internal address>
SITE_URL=https://dmarcharbor.com
NEXT_PUBLIC_APP_HOST=dmarcharbor.com
```

- `API_BASE_URL` is read at build time and the build fails without it.
- `SITE_URL` is the one public origin, read at runtime. Every canonical URL,
  og:url, sitemap entry, robots.txt sitemap line, security.txt and JSON-LD
  `@id` is built on it, whichever host served the page. Only its hostname is
  indexable: `www.`, `app.`, a raw IP or any other host serving the same pages
  answers `X-Robots-Tag: noindex`, a robots.txt that disallows everything and
  an empty sitemap. Unset, every host canonicalises to itself and only the
  app-local hosts below count as ours, which is right for development and
  wrong for production.
- `NEXT_PUBLIC_APP_HOST` is the hostname the app answers on, without scheme or
  port (for example `dmarcharbor.com`, or `app.dmarcharbor.com` if that is where
  the app is served). Requests on it skip the custom-domain branding lookup.
  It is inlined into the build, so set it before `next build`, not only at
  runtime. A host that is neither this nor an agency's verified domain is
  looked up on every cache expiry; with `SITE_URL` set that costs time but does
  not change what is indexed.

Optional, for search consoles (each renders its ownership tag on our own host
only, never on an agency's domain):

```
GOOGLE_SITE_VERIFICATION=<content of the google-site-verification tag>
BING_SITE_VERIFICATION=<content of the msvalidate.01 tag>
```

After the first deploy, check `https://dmarcharbor.com/robots.txt` (named
crawlers, a `Sitemap:` line on dmarcharbor.com), `/sitemap.xml` (the public
pages only, all on dmarcharbor.com) and `/.well-known/security.txt`, then
submit the sitemap in Google Search Console and Bing Webmaster Tools.

For AI assistants, also check `/llms.txt` (the index, with the plans from the
catalogue) and `/llms-full.txt` (the guide, the FAQ and the API reference).
Neither carries a line with an unsupplied fact: once the legal entity name,
the effective date and a security contact are supplied (lib/legal-docs.ts,
docs/SECURITY.md), the passages that held them appear in both files and in the
FAQ's structured data with no code change. security.txt names
support@dmarcharbor.com until a dedicated security address exists; change it in
`apps/web/lib/crawl-policy.ts` and `apps/api/src/routes/dpa.routes.ts`
together.

### 5. Transactional email

Before any customer-facing flow, because invites, password resets, domain
verification and billing mail all go through it and all silently no-op
otherwise.

- Create a Resend account, verify the sending domain on DNS.
- Set `EMAIL_FROM` to a subdomain you can afford to have a DMARC record on.
- Send one real message from a scratch account and confirm it arrives.
- Add a DMARC record for the sending subdomain, starting at `p=none`.
- If `CLIENT_EMAIL_FROM_ADDRESS` is set, its domain needs the same treatment:
  verify it in Resend, publish the SPF include and the DKIM records Resend gives
  for it, and give it a DMARC record. Without them, receivers fail every agency's
  client mail on DMARC. Pick a neutral domain that names neither us nor any one
  agency, since all agencies send from it. A message has a Reply-To only when
  the agency has set a support email in its white label settings; otherwise a
  reply goes to this address, so route it somewhere a person reads, or say in
  its auto-reply that it is not monitored.

### 5b. Agency sending domains (Admiralty)

An Admiralty agency can send its client mail from its own address, for example
`reports@mail.youragency.example`, instead of the shared one. The API adds the
domain to our Resend account with sending only, the agency publishes the records
Resend returns, and the mail switches over once Resend reports the domain
verified. Until then, and if it later stops being verified, client mail keeps
coming from the shared address with the agency's name.

- **Set `RESEND_DOMAINS_API_KEY`** to a full-access Resend key. It is used only
  to add, check and remove agency sending domains, so `RESEND_API_KEY` can stay a
  sending-only key. Unset, `RESEND_API_KEY` is used for the domain calls and must
  then have full access, or every agency claim fails with Resend's permission
  error (502 `SENDING_DOMAIN_PROVIDER_ERROR`).
- **Check the Resend plan's domain allowance** covers every Admiralty agency
  with a sending domain, plus our own domains. Pro includes 10 domains and
  Scale 1,000, and a 100-domain add-on exists. A claim over the allowance fails
  with Resend's message in the 502.
- **What the agency publishes**, on a subdomain such as
  `mail.youragency.example` rather than its main domain, so its existing mail
  setup is untouched:
  - the DKIM TXT record at `resend._domainkey.mail.youragency.example`;
  - the SPF MX record and SPF TXT record at `send.mail.youragency.example`
    (Resend's bounce domain).
  No receiving MX is asked for. The agency's own DMARC record on
  `youragency.example` covers the subdomain by alignment, so nothing else is
  needed for the mail to pass DMARC as the agency.
- Our own domains are refused as sending domains (the domains of `EMAIL_FROM`,
  `CLIENT_EMAIL_FROM_ADDRESS` and the report addresses, and the hosts of
  `APP_URL`, `BETTER_AUTH_URL`, `CORS_ORIGIN` and hosted DNS), as are their
  subdomains and parents.

### 5a. Agency custom domains

An Admiralty agency serves its clients on its own domain once its ownership
TXT record is verified. For that host to work, it must reach the web app, and
the web app must keep proxying `/api/*` here with `x-forwarded-host` set to the
host the browser asked for (Next.js rewrites do this). The API then trusts that
exact origin for sign-in, sign-out, password reset and email verification
(`apps/api/src/auth/agency-origin.ts`). Nothing to add to `CORS_ORIGIN` per
agency.

- Do not put a proxy in front of the API that sets or rewrites
  `x-forwarded-host` for direct requests. The rule depends on it arriving only
  from the web app's proxy.
- The web app needs a TLS certificate for each agency hostname. Production
  refuses an `http://` agency origin; plain http is accepted outside production
  only, for the local verify harness.
- A verified domain's DNS is the agency's to point. The ownership record proves
  control of DNS, not that the host serves our app, so emailed reset and
  verification links go to an agency domain only for that agency's client
  contacts who hold no seat in any workspace. The agency's own team gets links
  on our address.

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
- Create the products and plans, then run the plan sync so ids land in
  `billing_plan`: three paid flat tiers on two intervals, and one monthly Fleet
  plan per price band. Re-run it after any price change (Fairway moved to
  $39 / ₹3,299); a stored price that differs from the catalog is refused at
  checkout.
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

### 9. Autoscaling hardening — done

Every scheduler starts on boot, so an autoscaled deployment runs each one once
per instance. Node is single threaded, which is why an in-process flag was enough
to stop one process overlapping itself, and also why the flag could not stop the
other processes: a flag cannot see them.

Two layers now cover this, and both are needed.

**A job lease** (`apps/api/src/scheduler/job-lease.service.ts`) decides which
instance runs a job. One conditional upsert, so it is safe on a pooled
connection, and it expires on its own, so an instance killed mid job releases it
without needing a reaper.

A Postgres advisory lock was considered and rejected: it is session scoped, so
with a pooled connection the statement that takes the lock and the statement that
releases it land on different sessions and the lock is leaked rather than
released, after which the job silently stops running on that instance. The
transaction scoped variant releases correctly but only at the end of its
transaction, which would mean holding a database transaction open across DNS
lookups, IMAP logins and outbound HTTP.

**A row claim on every job that contacts a customer.** A lease stops the
stampede; it cannot cover a crash between deciding to send and actually sending.
Each of these takes the row with a conditional update and requires `count === 1`:

- Webhook deliveries — `IN_FLIGHT` with a lease, reclaimed when the claim is stale
- Scheduled client digests — writes the send time before sending, not after
- Erasure — new `EXECUTING` state, with a sweep for claims a killed instance left
- Alert first trigger — moves `lastTriggeredAt` off the value it read
- Alert reminders and owner rollups — a lost unique key race is now benign instead
  of aborting every remaining rule in the tick
- Dunning — a new `dunningStage`, so the warning and the withdrawal each happen
  exactly once
- Domain re-verification — claims before the DNS lookup
- IMAP polling — claims before connecting, so the fleet does not burst logins at
  one customer mail host

Billing reconciliation and the idempotency purge were already safe: the first
uses a deterministic event identifier and the second is naturally idempotent.

Dunning also had a bug that had nothing to do with autoscaling. Withdrawing a
plan left the status on `PAST_DUE` and never advanced the period end, so the row
kept matching the recovery query, the grace check stayed passed, and the customer
was warned and emailed again on every daily run, indefinitely, on a single
instance.

`ALERT_SCHEDULER_DISABLED` remains an emergency kill switch. It is not a leader
election and must not be used as one.

Proven by `apps/api/tests/scheduler-scaling.integration.test.ts`, which fires two
runs at the same rows with `Promise.all` for each job. Every one of those tests
would have passed against the old code when the runs were sequential, which is
the point: only genuinely concurrent execution exposes a read-then-write.

**Still worth doing before scaling out for real:** raise
`testTimeout` in `apps/api/vitest.integration.config.ts` above 20 seconds.
Several tests make real DNS and HTTP calls, so the suite is timing sensitive
under load and has produced spurious failures on a busy machine.

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

Done; nothing to do before launch. The guard is in place:

- `changePlan()` checks the target plan's limits against current usage before it
  calls the provider: clients and active domains across every workspace the
  account owns, team members in the workspace, and the workspaces the account
  owns. Twelve clients on Harbor cannot move to Fairway, which allows five.
- A move over any limit is refused with `409 PLAN_CHANGE_OVER_QUOTA`, each
  exceeded limit listed in `overage`, and recorded as
  `BILLING_PLAN_CHANGE_REFUSED`.
- `GET /workspaces/{id}/entitlements` carries `used` and `limit` for clients,
  active domains and members, so the billing screen shows them.
- `pendingPlan` on the subscription shows a scheduled change before it happens.

By design, a cancellation and a failed payment whose grace has run out move the
workspace to Mooring without this check. Everything is kept, and new clients,
domains and members are refused until the workspace is within Mooring's limits.

### 12. Collecting reports from rua=https endpoints

Before the first customer on Google Workspace, Microsoft 365 or Yahoo asks why
they have no data.

**The parser used to be wrong here, and being wrong was destructive.** It kept
only the `mailto:` targets out of the `rua` tag and discarded the rest, so

```
rua=https://reports.example.com/v1/x    parsed to the same thing as no rua
```

The scanner then reported *Aggregate reporting is not configured* and
recommended *Add a rua=mailto: reporting address*. A customer believing that
repoints a DNS record that was already correct, to fix a problem we invented.
Every major report organisation publishes over HTTPS by default, so this was the
common case. It is fixed: `hasAggregateReporting` counts either transport and
`canCollectAggregateReports` counts only mailto, and the scanner now says the
reports are going somewhere we cannot read and to leave the record alone.

**Fixing the parser removed the false alarm and left the real gap.** Those
domains now get an accurate answer and no data. That is the correct trade, and
it is still the largest gap in the product.

- The credentials are **not in DNS**. A report organisation issues a URL plus a
  username and password from its admin console, so there is nothing to
  discover. Someone has to paste them in, which makes this a settings screen and
  not a scan.
- Store the password encrypted, return it masked, never log it. Same handling
  as the IMAP mailbox password.
- Only `https`. The target comes from DNS, so fetching it over `http` means
  trusting XML that anyone on the path can rewrite.
- **A `rua=https` endpoint serves reports for many domains.** Unlike IMAP, where
  a fetch is attributed to one configured mailbox, one of these URLs returns
  every report its owner publishes. It must therefore be filtered to domains we
  have verified ownership of before ingest, or it becomes a way to read other
  customers' failure data by pointing a domain at a shared endpoint. The filter
  already exists in `ingestDmarcReport`; the poller must go through it, not
  around it.
- Reuse the job lease. Several workspaces pointing at the same report
  organisation must not burst the same endpoint on boot.
- Expect gzip and `application/gzip`, and reports larger than any single message
  we have handled.
- Until this ships, the UI must keep saying *we are not collecting these yet* and
  must never say reports will be delivered for a web-only `rua`.

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
- [ ] One real agency custom domain served over https (its TLS certificate
      issued), with a client signing in on it
- [ ] One real agency sending address added in Resend, its records verified,
      and a client email arriving from it with the agency's Reply-To. So far
      this has only run against a fake provider
- [x] Every job that contacts a customer claims its row, proven by concurrent tests
- [ ] Sub-processors named, residency question answered
