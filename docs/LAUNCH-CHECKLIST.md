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

- **Data export is for owners and admins** (12 November 2026, after session 16).
  An export holds everyone's data in the workspace (forensic reports, sessions
  and IP addresses, invitations, API keys, the audit trail), so it follows the
  same permission as erasure. A cut-down export per role was rejected: it would
  have to mirror every in-app permission, and any drift between the two would
  leak. An analyst or viewer asks an owner or admin. The right of access is the
  client's, and the agency exercises it.

Four questions this checklist once listed as open are settled. Recorded here so
they are not asked again, and because each one removes a sub-processor
obligation or a false option.

**The domain is `dmarcharbor.com`.** Bought and on Cloudflare; its mail (Resend
on `mail.`, Migadu on `reports.`, Email Routing for the role addresses) is in
use. `dmarcharbour.com` is the second domain, bought before launch: the hosting
zone for customers' delegated records, with its root redirecting to
`dmarcharbor.com` (see "Before deployment: what to buy and set up"). Both are named as ours on the Security page and in
the FAQ, so a customer can tell a lookalike from us. `app.dmarcharbor.com` and
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

**Data residency: one region, the EU (Frankfurt), no separate tiers**
(12 November 2026; replaces Singapore). App and API on AWS `eu-central-1`, Neon
Postgres in `aws-eu-central-1`, the logo bucket in `eu-central-1`. Chosen because
the dollar customers (UK, EU, US, Australia) ask where data is hosted in every
security review and "the EU" settles it; Indian law (DPDP Act) does not require
data to stay in India, and Singapore gave no legal advantage. Set
`DATA_RESIDENCY_REGION=European Union (Frankfurt)` in production. Set Neon's
history window to 7 days (the DPA promises it; the free plan keeps 6 hours).
Apply for the AWS Activate, Neon and Kiro startup programmes once the site is
live; none of them changes the region.

**The legal entity is Mohd Toshif, sole proprietor, trading as DMARC Harbor**
(12 November 2026), registered under Udyam with the unit name DMARC Harbor. The
address and phone on the legal and support pages are the Udyam ones, which is
what Razorpay and Paddle check against. When a company is registered, change the
constants in `apps/web/lib/legal-docs.ts` and the matching lines in
`apps/api/src/services/assistant/corpus.ts`, and re-verify both payment accounts.
Governing law is India (Terms, DPA section 11).

**Still open, and still blocking:** the hosting platform and its region details.

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
DATA_RESIDENCY_REGION=European Union (Frankfurt)
STAFF_API_KEY=...
```

`PORT` is the only one that should stay at its default if you are on a platform
that injects it.

Optional, for agencies with white label:

```
CLIENT_EMAIL_FROM_ADDRESS=reports@mail-relay.example
# Full-access Resend key, used only for agency sending domains (step 5b).
RESEND_DOMAINS_API_KEY=...
# Region agency sending domains are created in; matches our own.
RESEND_DOMAIN_REGION=eu-west-1
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
  wrong for production. Use the bare https origin: not `www.`, no trailing
  path. The server refuses to start on a value without its scheme, an `http`
  one, or one with a path; it logs a warning when `SITE_URL` is missing.
- Point `www.dmarcharbor.com` at the same deployment as `dmarcharbor.com`: a
  GET there is sent to `https://dmarcharbor.com` with a permanent (308)
  redirect, path and query kept. A redirect at the CDN does the same job and
  is fine too.
- `NEXT_PUBLIC_APP_HOST` is the hostname the app answers on, without scheme or
  port: `dmarcharbor.com`, the same host as `SITE_URL`, because the marketing
  pages and the app are served from one deployment. Requests on it skip the
  custom-domain branding lookup. It is inlined into the build, so set it
  before `next build`, not only at runtime; the build refuses a value with a
  scheme, port or path, and the server logs a warning when it differs from
  `SITE_URL`'s host.

Optional, for search consoles (each renders its ownership tag on our own host
only, never on an agency's domain):

```
GOOGLE_SITE_VERIFICATION=<content of the google-site-verification tag>
BING_SITE_VERIFICATION=<content of the msvalidate.01 tag>
```

Better still for Google: add a **Domain property** for `dmarcharbor.com` in
Search Console and verify it with the DNS TXT record it gives. That covers
every host and protocol and survives a redeploy, and then
`GOOGLE_SITE_VERIFICATION` can stay unset. Bing Webmaster Tools can import the
verified site from Search Console, so `BING_SITE_VERIFICATION` is only needed
if you add Bing on its own. A value pasted as the whole `<meta>` tag is reduced
to its token; anything that is not a token is ignored with a warning.

After the first deploy, check `https://dmarcharbor.com/robots.txt` (named
crawlers, a `Sitemap:` line on dmarcharbor.com), `/sitemap.xml` (the public
pages only, all on dmarcharbor.com) and `/.well-known/security.txt`, then
submit the sitemap in Google Search Console and Bing Webmaster Tools.

For AI assistants, also check `/llms.txt` (the index, with the plans from the
catalogue) and `/llms-full.txt` (the guide, the FAQ and the API reference).
Neither carries a line with an unsupplied fact: once the legal entity name and
the effective date are supplied (lib/legal-docs.ts), the passages that held
them appear in both files and in the FAQ's structured data with no code change.

The security contact is `security@dmarcharbor.com`: security.txt, the Security
Policy, the FAQ, the Acceptable Use and Complaint policies and the in-app
assistant all name it (`SECURITY_EMAIL` in `apps/web/lib/legal-docs.ts` and
`apps/api/src/services/assistant/corpus.ts`, and
`apps/api/src/routes/dpa.routes.ts`). **Create that mailbox or alias before
launch** and route it to someone who reads it; security.txt promises an answer
within 3 business days.

### 5. Transactional email

Before any customer-facing flow, because invites, password resets, domain
verification and billing mail all go through it and all silently no-op
otherwise.

- Create a Resend account, verify the sending domain on DNS.
- Sending region: `RESEND_DOMAIN_REGION` defaults to `eu-west-1` (Ireland) for
  agencies' own sending domains. `mail.dmarcharbor.com` was created in
  `ap-northeast-1` during testing; delete it in Resend and add it again in
  `eu-west-1`, then publish the new DKIM record, so our mail and the agencies'
  leave from one region.
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
- **Create `RESEND_API_KEY` as Sending access with Domain: All domains.** A
  sending key limited to our own domain cannot send from any agency's domain:
  in session 14 the agency's domain verified, and then every client email from
  it failed with "This API key is not authorized to send emails from
  notify.linkshift.in" and was retried, never sent.
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
TXT record is verified and the domain is live (see "Serving the domain" below).
For that host to work, it must reach the web app, and
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

**Serving the domain (built after session 14).** The agency publishes the
ownership TXT and a CNAME to `AGENCY_DOMAIN_CNAME_TARGET`, both shown on its
white label page. The domain is **live** once `https://<domain>/api/branding/host`
answers as that agency through us; the page shows each step, and links emailed
to clients stay on `APP_URL` until then. A 15-minute check takes every verified,
not-live domain one step on, and live stays live until the domain is changed or
removed. Set up one of two ways:

- **Automatic (recommended).** On the hosted DNS zone (Cloudflare for SaaS,
  the same zone and token as hosted MTA-STS; the token needs SSL and
  Certificates edit):
  - [ ] A proxied record for the web app, such as
        `portal-origin.dmarcharbor.com`, pointing at the AWS load balancer or
        CloudFront distribution. It must accept any `Host` and pass it on,
        because requests arrive with the agency's hostname.
  - [ ] A proxied CNAME for agencies to point at, such as
        `portals.dmarcharbor.com`, to that record.
  - [ ] `AGENCY_DOMAIN_ORIGIN=portal-origin.dmarcharbor.com` and
        `AGENCY_DOMAIN_CNAME_TARGET=portals.dmarcharbor.com` on the API. Each
        agency hostname is registered as a custom hostname with that origin
        (`custom_origin_server`), so the zone's fallback origin stays with
        MTA-STS. Cloudflare issues the certificate once the CNAME resolves.
  - [ ] The certificate is Cloudflare's, at the edge. The AWS side then needs
        only a certificate for `portal-origin.dmarcharbor.com` (ACM), with
        Cloudflare's SSL mode Full (strict).
- **Manual.** Set only `AGENCY_DOMAIN_CNAME_TARGET` (for example the load
  balancer's name). On verification the operator is emailed once per domain
  to add the hostname and an ACM certificate for it by hand; the domain goes
  live by itself after that.
- [ ] `OPERATOR_EMAIL`: required in production once `AGENCY_DOMAIN_CNAME_TARGET`
      is set. It also gets the email when Cloudflare refuses a hostname.
- Agency hostnames and hosted MTA-STS share one limit,
  `HOSTED_MTA_STS_HOSTNAME_LIMIT` (custom hostnames on the zone). At the limit
  the agency's page says the certificate is held up and the operator is told.
- Removing or changing a domain deletes its Cloudflare hostname first; if
  Cloudflare refuses, the change is refused and nothing is lost. Deleting or
  erasing a workspace removes it best effort and logs the id if it cannot.
- An agency whose own DNS is on Cloudflare must set the CNAME to DNS only
  (grey cloud); the page says so.

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

Everything below is explained in `docs/BILLING.md`, including the decisions
behind it.

**Razorpay (INR)**
- Complete KYC, MSME/Udyam registration.
- Recurring Payments enabled on the live account for cards, UPI Autopay and
  eMandate (enabled on test on 12 November 2026; confirm live separately). INR
  checkout uses it (`docs/BILLING.md`, "Razorpay Recurring Payments").
- Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (live).
- Webhook URL: `https://api.dmarcharbor.com/api/webhooks/razorpay`, with
  refund.processed and payment.dispute.* (recorded for support), and
  payment.captured, payment.failed, order.paid, invoice.paid, invoice.expired
  and token.* (subscription.* cannot be ticked beside token.*, and is not read).
- No plan sync is needed for INR: Recurring Payments charges catalog prices.
- The `billing-recurring-renewals` job runs hourly in the scheduler; the
  heartbeat alarms if it has not run for 6 hours.
- The registration-link page shows the business name from the Razorpay account
  settings; check it reads "DMARC Harbor" on live.

**Paddle (USD)**
- Site approval (the long pole), then the live API key, webhook secret and a
  `live_` client token (`NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` in the web app).
- Checkout > Default payment link: `https://dmarcharbor.com/pay` (already set
  in the sandbox; the domain must be approved on live).
- Notification destination `https://api.dmarcharbor.com/api/webhooks/paddle`,
  subscription.*, transaction.* and adjustment.*.
- Run the plan sync for USD: flat prices accept quantity 1 only, Fleet prices 1
  to 5,000.
- Payout settings: a bank account that accepts USD transfers, or Wise.
- Verified in the sandbox in session 11: checkout, portal, prorated upgrade and
  downgrade, cancel and keep, Fleet count and bands, renewal, failed renewal and
  dunning, recovery, refund.

**Before the first sale:** remove `STAFF_API_KEY`'s dev value and set a strong
one (refunds use it), and read "Handling a refund request" in `docs/BILLING.md`.

### 8. The report mailbox, last

Last because it is the only step that needs the domain, the DNS and a decision
you have not made yet.

- The report address needs a mailbox that holds mail while the API is down,
  read over IMAP with `REPORT_MAILBOX_HOST`, `REPORT_MAILBOX_USERNAME` and
  `REPORT_MAILBOX_PASSWORD` (`REPORT_MAILBOX_PORT`, default 993). Each report
  goes to the workspace holding the verified domain it names. Decided: Migadu
  (Micro plan) on `reports.dmarcharbor.com`, mailboxes
  `dmarc-reports@reports.dmarcharbor.com` and
  `dmarc-forensics@reports.dmarcharbor.com`. The early test route
  `dmarc-reports@dmarcharbor.com` → Gmail (Cloudflare Email Routing) is unused
  and is removed (12 November 2026), so no consumer Gmail holds report data.
- Point `REPORT_AGGREGATE_ADDRESS` and `REPORT_FORENSIC_ADDRESS` at it.
- Set `REPORT_ADDRESS_SUBADDRESSING=plus`. The guide and FAQ promise each
  client its own report address (`agg+<token>@reports.dmarcharbor.com`); with
  the default `off`, every client is shown the same shared address. Migadu
  delivers `+` addresses to the base mailbox, but send one test message to a
  `+something` address before turning it on, or reports bounce.
- Publish the MX record.
- Verify with `dig MX dmarcharbor.com`.
- Publish the external report authorisation record, or receivers such as
  Google drop reports for every customer domain: TXT
  `*._report._dmarc.reports.dmarcharbor.com` with the value `v=DMARC1`
  (RFC 7489 section 7.1). The switch kit already warns when it is missing.
- Decided in testing (session 7, 6 November 2026): Gmail refuses mail that
  Cloudflare Email Routing forwards to it ("421 4.7.28 unusual rate of
  unsolicited mail"), so every Google report to the Gmail test mailbox failed.
  The report mailbox moves to Migadu on `reports.dmarcharbor.com` now, not at
  launch.
- On Migadu, also add `dmarc-forensics@reports.dmarcharbor.com` as an alias of
  the report mailbox. It is `REPORT_FORENSIC_ADDRESS`, and the app already
  publishes it as `ruf=` (seen on `_dmarc.lab.dmarcharbor.com` in session 9).
  One mailbox is enough: the reader tells forensic reports from aggregate ones.
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

**Closed by the security audit (30 October 2026).** The lease stopped two
instances running a job at once but not each running it once per interval;
renewal charges were sent before they were claimed; the email claim let two
drainers send one message; webhook and PSA claims were stamped with the pass
start, so a slow pass looked stale to another instance; a lost lease went
unnoticed; and shutdown exited with jobs mid pass, leaving their leases held for
up to ten minutes. Each is fixed: renewals are claimed before the charge and
settled from the order's payments, the email claim includes its attempt count,
each delivery renews its claim before it is sent, a failed lease renewal is
logged, shutdown answers 503 on `/api/ready`, stops the timers and waits for
running jobs, domain re-verification runs on a due lease, and each mailbox is
polled once per interval across the fleet.

### 10. Data residency and sub-processors

Mostly done (12 November 2026). The region is the EU (Frankfurt), on AWS and
Neon; the Sub-processors page, the Trust Center list, the Privacy Policy
(section 9) and the DPA (sections 5.10 and 7) say so.

- [x] Name each sub-processor and its jurisdiction: Resend United States, AWS
      and Neon Frankfurt, Razorpay India.
- [x] Migadu's data-centre country: the EEA and Switzerland, on OVHcloud in
      France, Germany and the Netherlands (Migadu support, 12 November 2026).
      Filled on the Sub-processors page, the DPA and the Trust Center.
- [x] EU-only residency as a feature: no; everything is in the EU already.
- [ ] Set `DATA_RESIDENCY_REGION=European Union (Frankfurt)` in production, which
      replaces "Not confirmed yet" on the Trust Center and compliance packs.
- [ ] Fill `[EFFECTIVE DATE]` in `docs/PRIVACY-POLICY.md` on launch day.
- [ ] Optional: a lawyer's review of the DPA and Privacy Policy. Not required to
      launch; worth doing before signing an enterprise customer's own DPA.
- [ ] Decide whether an EU Art. 27 representative is needed. It applies only to
      a business outside the EU that serves EU customers regularly; revisit
      once EU customers sign up.

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
  identity provider. Done against Auth0 (OIDC and SAML) in session 14, which
  found and fixed the faults listed there on first contact; Entra and Okta are still worth
  one run each with the first customer that uses them.
- Smoke test IMAP against the real mailbox, as noted in step 8

**Frontend, your other agent**

- The whole app
- See the separate handoff prompt

**ConnectWise and Autotask, once the site is live.** Both are built to the
vendors' published APIs and covered by tests, but neither has been run against a
live account: neither vendor offers a self-serve trial. Until they have, they
are labelled **early access** on the PSA screen, on pricing, on the home page
map, in the FAQ, the guide, the API reference and the roadmap. HaloPSA was run
end to end in session 8 and found three bugs, so expect the same here.

- [ ] Register on the ConnectWise Developer Network
      (<https://register.developer.connectwise.com/>). It is free and gives the
      client ID the deployment needs as `PSA_CONNECTWISE_CLIENT_ID`; without it
      the option stays disabled. It asks for a live website and a company.
- [ ] Apply to ConnectWise Invent for a PSA sandbox to test against, or test
      on the first customer's own instance with them.
- [ ] Apply to Kaseya's technology partner programme for an Autotask sandbox
      (an API-only user and an integration code), or test on the first
      customer's own instance with them.
- [ ] Run session 8's PSA items 1 to 10 against each, fix what it finds, then
      remove the early-access labels (search the repo for "early access").

**Hosted BIMI with a real mark certificate, with the first customer who has
one.** Session 10 ran hosted BIMI end to end with a self-signed certificate:
the checks, the files, the record and release all work. What it could not show
is the logo in Gmail or Apple Mail, which needs a VMC or CMC (about $1,000 to
$1,500 a year from DigiCert or Entrust; a CMC needs no trademark). Yahoo and
Fastmail show a logo without one. Until a real certificate has been through it,
the FAQ calls this early access.

- [ ] When a customer (or we) has a VMC or CMC: upload it and the exact SVG the
      authority approved, check the panel reads "Mark certificate (VMC or CMC)",
      send a message from the domain to a Gmail and an iCloud address, and see
      the logo (Gmail can take a day or two to start).
- [ ] Fix what it finds, then remove "early access" from the BIMI answer in
      `docs/FAQ.md`.

---

## Before deployment: what to buy and set up

Decided in session 10 (9 November 2026). Hosted DMARC, managed SPF, hosted BIMI
and hosted MTA-STS publish customers' records in one Cloudflare zone, the
hosting zone. It is a domain of its own, not `dmarcharbor.com`: customers'
records then never share our own zone's record limit, an automation mistake
cannot touch our website or mail, a test deployment can use its own zone, and
a zone has only one Cloudflare for SaaS fallback origin. Customers point their
CNAMEs at this zone, so it must be chosen before the first customer: changing it
later means every customer edits their DNS again.

- [ ] **Buy `dmarcharbour.com`** (the hosting zone; also stops someone else
      using our British spelling). Add it to Cloudflare. Redirect its root and
      `www` (301, a Cloudflare redirect rule) to `https://dmarcharbor.com`, so a
      person who types it or finds it in a CNAME lands on us and does not take
      it for a lookalike. The hosting names under it (`bimi.`, `mta.`, the
      token records) are unaffected by the redirect.
- [ ] Set `HOSTED_DNS_ZONE=dmarcharbour.com`, its zone ID, and a token scoped
      to that zone with **Zone → DNS → Edit**, **Zone → SSL and Certificates →
      Edit** and **Zone → Zone → Read**.
- [ ] **Cloudflare for SaaS** on `dmarcharbour.com` (the card is on the
      account). Fallback origin: a proxied record that reaches the production
      **API**, for example `mta-origin.dmarcharbour.com`. Set
      `HOSTED_MTA_STS_CNAME_TARGET`, for example `mta.dmarcharbour.com`, a
      proxied CNAME to the fallback origin.
- [ ] `HOSTED_BIMI_ORIGIN`, for example `https://bimi.dmarcharbour.com`,
      proxied to the API. Never the web app's origin.
- [ ] On the hosting zone, set **Caching → Configuration → Browser Cache TTL**
      to **Respect Existing Headers**. The API sends `max-age=3600` for BIMI
      files; Cloudflare's default (4 hours) raised it to `max-age=14400`, so a
      released or replaced logo stayed in browsers for 4 hours instead of 1
      (seen in session 10).
- [ ] **Cloudflare Pro on `dmarcharbour.com`** (about $20–25 a month) when the
      80% email arrives: Free holds 200 records, Pro 3,500. No setting to
      change once the build below is done.
- [ ] Cloudflare for SaaS bills $0.10 a month per hosted MTA-STS domain past
      100. Nothing to do; the milestone emails say what it costs.
- [ ] Remove the session 10 test set-up from `dmarcharbor.com`: the tunnel
      hostnames, the fallback origin, the test custom hostname and the hosted
      records under `bimi.` and `_mta-sts.`. Delete the tunnel.

**To build before launch (agreed, not built yet):**

- [ ] Hosted MTA-STS limit raised to Cloudflare's 50,000, with an email to the
      operator at 100, 500, 1,000 and each 1,000 after, saying the monthly cost.
- [ ] The hosting zone's record limit read from its Cloudflare plan (200 Free,
      3,500 Pro, 3,500 Business), with an email to the operator at 80%.
- [ ] At a real limit, the customer sees a short message ("This could not be
      set up just now. We have been told and will fix it shortly; nothing else
      on your domain is affected.") and the operator gets an email at once.

**Built after session 14:**

- [x] **Agency custom domains that an agency can finish alone.** The white
      label page shows the CNAME target beside the ownership TXT, and the
      domain's steps (TXT, CNAME, certificate, live). Automatic mode registers
      a Cloudflare for SaaS custom hostname per agency domain with its own
      origin (`custom_origin_server`), so the fallback origin stays with
      MTA-STS; manual mode emails the operator. Client links wait until the
      domain is live. Setup is in step 5a. Tested in dev on
      `portal.linkshift.in` both ways.

Also before launch, listed elsewhere: Razorpay keys (step 7), ConnectWise and
Autotask registration, and a full-access Resend key (step 5b).

## After the test sessions, before launch

**Free public tools.** dmarcian and EasyDMARC are found through free tools
("SPF lookup", "DMARC generator"); our public site has only the home-page check
and `/verify` (session 17). Build in this order, each as its own public page in
the sitemap, from the scanner the home-page check already uses:

- [x] DMARC, SPF, DKIM and BIMI lookup pages, one page each
      (compare [dmarcian SPF survey](https://dmarcian.com/spf-survey/),
      [EasyDMARC DKIM lookup](https://easydmarc.com/tools/dkim-lookup)).
      Built: `/tools/dmarc`, `/tools/spf`, `/tools/dkim` (with an optional
      selector, now accepted by `POST /api/scan`), `/tools/bimi`, and the `/tools`
      index. In the sitemap, robots allowlist, llms.txt, header and footer, with
      WebApplication and BreadcrumbList JSON-LD on each page.
- [x] DMARC record generator, a few choices in, the record out
      ([dmarcian wizard](https://dmarcian.com/dmarc-record-wizard/)). Built:
      `/tools/dmarc-generator`, in the browser alone.
- [x] Offer our reporting address in the generator. Today the person types the
      `rua` address; offering ours needs the report address in `/api/meta` and a
      line saying it only collects once the domain is added to a workspace.
      Built: an unticked choice, from `reports.aggregateAddress` in `/api/meta`.
- [x] Aggregate report reader: paste an XML report, read it as a table, offer
      sign-up to keep receiving them ([dmarcian XML to human](https://dmarcian.com/xml-to-human-converter/))
- [x] Email header analyser ([dmarcian](https://dmarcian.com/email-header-analyzer/))
- [x] DMARC glossary ([dmarcian dictionary](https://dmarcian.com/dmarc-dictionary/))
- [x] Setup guides per email provider: Microsoft 365, Google Workspace and the
      common senders ([EasyDMARC knowledge base](https://support.easydmarc.com/))

**Webhook gaps (session 8).**

- [x] Rotate an endpoint's signing secret, with the old secret still accepted
      for a short overlap (both signatures sent), so a receiver can switch
      without missing events. Built: Rotate secret, with an overlap of 1 hour,
      1 day, 7 days or none; `x-dmarcharbor-signature` lists both values.
- [x] Limit an endpoint to chosen clients, so an MSP can point one client's
      events at that client's own system
      ([dmarcian Alert Central](https://dmarcian.com/alert-central-overview/)).
- [x] Manage webhook endpoints through the `/api/v1` API with an API key, not
      only from the settings page ([EasyDMARC API](https://developers.easydmarc.com/)).

**Slack and Teams gaps (session 7).** Today a workspace has one Slack and one
Teams destination (`SlackDestination`, `TeamsDestination`, one per
organization), and every alert goes to both.
Built since: up to 20 channels of each, routed by client and by kind (`/slack-destinations`, `/teams-destinations`).

- [x] Route alerts to more than one channel: by client (an MSP sends each
      client's alerts to that client's channel) and by kind (DNS changes to one
      channel, spoofing to another). EasyDMARC chooses a channel per
      notification category ([EasyDMARC Slack integration](https://support.easydmarc.com/knowledge-base/slack-integration));
      dmarcian routes by domain group ([Alert Central](https://dmarcian.com/alert-central-overview/)).
- [ ] Later, a Slack app installed with "Add to Slack" in place of pasting an
      incoming-webhook URL. Not needed for launch; PagerDuty and Opsgenie can
      take our signed webhooks today.

**Slack and Teams fixes (session 7).** Delivery itself works: a message sent
through `deliverSlackAlert` arrived in `#dmarc-alerts`, and the Teams card shows
correctly in the Workflows chat.

- [x] A "Send a test message" button on the Slack page, as Teams has, so an
      agency can check its setup without waiting for an alert.
- [x] The Teams test card names the real workspace (it says "Domain: test",
      "Workspace: test") and does not say "this channel", because a workflow
      can post to a chat or to the person privately.

**DNS publishing gaps (session 9).** Publishing works through Cloudflare only
(`services/dns-automation/cloudflare.client.ts`), and each domain is typed in.

- [ ] More DNS providers. EasyDMARC connects Cloudflare, GoDaddy, AWS Route 53,
      Azure DNS, Google Cloud DNS and OVHcloud
      ([EasyDMARC DNS integrations](https://easydmarc.com/blog/dns-provider-integrations/)).
      Start with GoDaddy and Route 53, the commonest after Cloudflare for small
      clients. Compare the cost of a broker such as Entri, which PowerDMARC
      uses for one-click publishing across many providers, with building each.
      Decided (November 2026): not before launch. Build directly (free APIs),
      GoDaddy and Route 53 first, when two customers ask or a deal depends on it.
      Hosted DMARC covers every provider meanwhile. Entri starts near $249 a month.
- [x] Import domains from a connected zone: list the zones the token can see
      and offer to add them, in place of typing each domain. Built: Import
      domains on each connection under Settings, DNS publishing. Clicked through
      locally with a mocked zone list only; check it against a real Cloudflare
      token in the final pass.

**Deferred re-tests.**

- [ ] Slack and Teams in the final pass: the "DMARC Harbor test" Slack app and
      the Teams workflow "Send webhook alerts from anyone" (posting to "Myself
      privately") are kept for it. Delete both when the programme ends.

- [ ] Real webhook events end to end: `report.received` once real reports
      arrive (session 4), and `alert.triggered` from a real alert. Session 8
      sent only test events; the real paths are covered by the CI integration
      tests (`webhook`, `dns-monitoring`).

- [ ] Ask's written answers. Decided (12 November 2026): launch in links mode,
      which session 17 passed, and leave `ANTHROPIC_API_KEY` unset. Set it only
      after one run with a real key: answers cite the FAQ and docs, refuse
      workspace data, say "I don't know" rather than guess, and the daily cap
      holds. Anthropic is already listed as a sub-processor "only when written
      answers are enabled".

- [ ] Logo upload (session 12): the S3 account in `apps/api/.env` is closed.
      With working keys, a logo uploads and shows on the portal, share page and
      Trust Center; with `LOGO_BUCKET` removed and the API restarted, the Logo
      panel says "Logo upload isn't available on this deployment".
- [ ] A quick final pass over every session tested only by Argon.

---

## Security audit (30 October 2026): what deployment still has to do

The code findings are fixed on `feat/redesign`, and the changes a screen or an
integration can notice are in `docs/API-CHANGELOG.md` (2026-12-20). These need
the deployment, an account or a decision, not code.

**Database and migrations**
- [ ] `DATABASE_URL` for the app: Neon's pooled (`-pooler`) URL with
      `?connection_limit=5&pool_timeout=20` (size it so instances × limit plus
      the migrate step stays under the compute's connection limit).
- [ ] Run `prisma migrate deploy` once per release, with the direct (non-pooled)
      URL, in a release step. The image still migrates on boot; with several
      instances booting at once they queue on Prisma's lock, so either keep one
      instance on the first boot of a release or move the step out of `CMD`.
- [ ] Neon point-in-time restore on, its retention written down, and one restore
      tried on a branch before launch.

**Several instances**
- [ ] Web: build once per release, set `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (the
      same on every instance, from the vault) and a `deploymentId`, so a server
      action posted to another instance during a rolling deploy still works.
- [ ] Load balancer idle timeout at most 60 seconds (the API keeps idle
      connections 65 seconds), and `/api/ready` as its health check: it answers
      503 while an instance drains.
- [ ] `TRUST_PROXY_HOPS` set to the real hop count of the path to the API, and
      the same count on every path (direct, through the web app's `/api` proxy,
      through Cloudflare for the hosted MTA-STS and BIMI hosts). A wrong count
      either shares one rate-limit bucket or lets `X-Forwarded-For` be forged.
- [ ] Clocks on NTP: leases and claims compare each instance's clock.
- [ ] Monitoring reads scheduler staleness from more than one instance, or
      accepts that `/api/ready` reports the jobs this instance ran.

**Secrets and accounts**
- [ ] `STAFF_API_KEY` and `REPORT_INGEST_SECRET` at least 32 random characters
      (production refuses shorter ones). `RAZORPAY_WEBHOOK_SECRET` is required
      whenever the Razorpay keys are set.
- [ ] Razorpay webhook: add refund.processed and payment.dispute.*; Paddle
      notifications already include adjustment.* (both are recorded for support).

**Logo storage (with session 12, S3)**
- [ ] Serve the bucket from its own registrable domain, not a subdomain of ours,
      with a response headers policy of `Content-Security-Policy: default-src
      'none'; style-src 'unsafe-inline'; sandbox` and `X-Content-Type-Options:
      nosniff`. Uploads are already refused for active SVG content and stored
      with `Content-Disposition: attachment`.
- [ ] Bucket policy: private, no public writes; presigned uploads are checked
      when confirmed, and an object that fails the check is deleted.

**Decisions, not bugs**
- [ ] Analysts hold `domain:update`, so they can publish DNS changes through a
      Cloudflare connection and start or release hosted records. Keep, or add a
      publish permission for owners and admins.
- [ ] Hosted DMARC, SPF, BIMI and MTA-STS keep serving after a downgrade (the
      panels say paused). Decide a grace period after which the release flows run.
- [ ] A staff member who is also a client contact can sign in on an agency's
      domain, and the agency controls that domain's DNS. Consider refusing
      sign-in on an agency domain for accounts with a seat in another workspace.
- [ ] Custom portal domains and sending domains are first come, first served
      before verification, and a verified custom domain is not re-checked later.

**Hardening after launch (not open vulnerabilities)**
- [ ] A fixed upper limit on a session's life. Sessions last 7 days and renew
      once a day while used, so a stolen session that keeps being used lasts
      until it is signed out, revoked or ended by a password reset.
- [ ] A cap on reset and verification emails per recipient. The limit is per
      client IP (20 auth requests a minute), so many addresses can still fill
      one inbox and cost us sending reputation.
- [ ] The session cookie with the `__Host-` prefix, so no sibling subdomain can
      set a cookie of the same name.
- [ ] Google and Microsoft tokens that Better Auth keeps in `account`, and
      outbound webhook endpoint URLs, encrypted at rest like the mailbox
      passwords, PSA credentials, Slack and Teams URLs and Cloudflare tokens
      already are.
- [ ] A written way to rotate `BETTER_AUTH_SECRET` (cookies and the Paddle
      checkout attribution) and the forensic keys.

## Backlog: decided, not now

**Per-client staff access** (a technician sees only some clients). Not built
before launch: it has to hold on every screen, export, email, webhook and API
route, small MSPs rarely need it, and separate workspaces, the viewer role and
the client portal cover most cases today.

- **Build it when** several customers ask for it, a deal is lost over it, or we
  sell to MSPs with more than about 25 staff.
- **Then:** Admiralty and Fleet only. Owners and admins see everything; an
  analyst or viewer can be limited to chosen clients; a new member sees all
  clients, as now. Clients only, not single domains.
- **How:** the check lives in the one layer that loads clients and domains, not
  on each screen, and one test calls every route as a limited member and fails
  on anything outside their clients.

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
      issued), live on the white label page, with a client signing in on it
      and a portal invitation linking to it (step 5a set up first)
- [ ] One real agency sending address added in Resend, its records verified,
      and a client email arriving from it with the agency's Reply-To. Done in
      session 14 on `notify.linkshift.in` (delivered to Gmail); repeat once on
      the production Resend account
- [x] Every job that contacts a customer claims its row, proven by concurrent tests
- [ ] Sub-processors named, residency question answered
