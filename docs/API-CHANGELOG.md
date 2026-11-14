# DMARC Harbor API — Changelog

The full `/api/v1` reference, with every endpoint, error and webhook, is [docs/API.md](API.md), published at `/docs/api`. Where this changelog and the reference disagree, the reference describes the current code.

The `/api/v1` surface is a contract with customers' own software, not with our
interface. Changes here are additive within `v1`. A removal, a rename, a type
change, or a change in the meaning of an existing field will be released as
`v2` alongside `v1`, and `v1` will keep working for as long as customers depend
on it.

The browser routes under `/api` are **not** versioned and change whenever the
product changes. Integrations must not use them.

---

## Authentication

Every `/api/v1` request needs a bearer token:

```
Authorization: Bearer dmh_xxxxxxxx_secret
```

The **workspace comes from the key**, not from the path. A key therefore cannot
be pointed at another workspace by mistake.

Keys are created and revoked by the **workspace owner only**, because a key acts
on the whole workspace with the authority of its scopes.

Keys are stored as a SHA-256 hash. The full key is shown once at creation and
can never be retrieved again. A database read cannot recover a usable key.

| Scope | Allows |
|---|---|
| `read` | Read endpoints only. **Cannot create or modify anything.** |
| `write` | Read and write |

**Use a read-scoped key for anything that only reports.** A dashboard or a
reporting job has no reason to be able to create clients.

---

## v1 — 2026-09-27

### Added

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/clients` | Every client with its domains and verification state |
| `POST` | `/api/v1/clients` | Create one client, optionally with domains |
| `POST` | `/api/v1/clients/bulk` | Import many clients in one call |
| `GET` | `/api/v1/domains` | Every domain in the workspace |
| `POST` | `/api/v1/domains` | Add one domain to a client |
| `POST` | `/api/v1/domains/bulk` | Add many domains to one client |
| `POST` | `/api/v1/domains/{domainId}/verify` | Check DNS ownership now |

### Management, session authenticated

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/workspaces/{id}/api-keys` | Key metadata, never the key |
| `POST` | `/api/workspaces/{id}/api-keys` | Issue a key, shown once |
| `DELETE` | `/api/workspaces/{id}/api-keys/{keyId}` | Revoke immediately |

### Idempotency

Send `Idempotency-Key` on any write:

```
Idempotency-Key: onboarding-acme-2026-09-27
```

A retried request **replays the original response** and sets
`Idempotency-Replayed: true` instead of creating duplicates. Records expire
after 24 hours.

**This matters for automation.** If your request times out and you retry, without
a key you get two clients. With a key you get one.

### Bulk response shape

Bulk endpoints always return per-item results, never a single pass or fail:

```json
{
  "created": 38,
  "failed": 1,
  "planBlocked": 11,
  "clients": [ { "index": 0, "clientId": "...", "name": "Example Client", "slug": "acme",
                 "domains": [ { "domainId": "...", "name": "example.com",
                                 "verificationHost": "_dmarc-harbor-verification.example.com",
                                 "verificationValue": "dmarc-harbor-verification=<uuid>" } ] } ],
  "failures": [ { "index": 12, "name": "Duff Co", "reason": "A client with the slug \"duff-co\" already exists." } ],
  "planLimitRejections": [ { "index": 20, "name": "Zeta Ltd",
                            "reason": "Fairway includes 20 active domains and only 3 remain." } ],
  "limits": { "maxClients": 200, "maxDomains": 500 }
}
```

`failed` means the row was wrong. `planBlocked` means the row was fine but the
plan has no room. **Both tell you exactly what to fix, and neither stops the rest
of the batch.**

### Rate limits

`API_RATE_LIMIT_PER_MINUTE` requests per minute per key (300 by default), with a
standard `429` and `Retry-After` header. Separately, an unauthenticated budget of
300 requests per minute per client address runs before the key is checked, so an
attacker with no key cannot drive key lookups; the per-key budget is the one that
matters to an integration. Both answer with `RateLimit` and `RateLimit-Policy`
headers.

### Domain verification

A domain is verified by publishing a TXT record and then asking us to check it:

| Field | Value |
|---|---|
| Type | `TXT` |
| Host | `_dmarc-harbor-verification.<domain>` |
| Value | `dmarc-harbor-verification=<token>` |

`POST /api/v1/domains/{domainId}/verify` returns the host, the expected value,
whether it was found, and the current state. **We never modify your DNS.** You
publish, we read.

---

## Webhooks

Polling works and is supported. Webhooks remove the need to ask.

### Direction

This is the opposite direction to the API above.

| | The API | Webhooks |
|---|---|---|
| Who sends | **Your software** | **DMARC Harbor** |
| Who receives | DMARC Harbor | **Your software** |
| Who starts | You, on your schedule | We, when something happens |

You register an endpoint URL with us once. After that **we** POST to it. Your
software only ever receives.

### Registering

```
POST /api/workspaces/{id}/webhooks
{
  "name": "HaloPSA production",
  "url": "https://halopsa.example.com/hooks/dmarc",
  "events": ["domain.verified", "alert.triggered"]
}
```

The response includes a **signing secret, shown once**. Store it in your secret
manager. Copy it into your PSA so it can verify our signatures.

The URL must be **public https**. Local, loopback and private addresses are
refused.

Webhooks are available from **Fairway** and above. A workspace that downgrades
keeps its endpoints and can still list them, pause them and delete them; new
events stop being queued until the plan grants webhooks again. Listing the
delivery log and setting only `active: false` remain available on every plan.

### Events

| Event | Fires when | Opt in |
|---|---|---|
| `domain.verified` | DNS ownership proof confirmed, on the transition only | Default on |
| `alert.triggered` | An alert rule crossed its threshold | Default on |
| `report.received` | A DMARC report arrived | **Opt in** |
| `entitlement.exceeded` | A plan limit was hit | **Opt in** |
| `dns.changed` | A scheduled or manual scan recorded one or more DNS changes | **Opt in** |
| `policy.changed` | A scan changed the DMARC policy tags | **Opt in** |
| `forensic.received` | A forensic report was stored for the first time | **Opt in** |
| `tlsrpt.received` | A TLS-RPT report was stored for the first time | **Opt in** |

`report.received`, `dns.changed`, `policy.changed`, `forensic.received` and
`tlsrpt.received` are
opt in because they can be high volume. Subscribing to events you will ignore
trains people to ignore the endpoint, so they are left off by default.

### The payload is a pointer, not the data

```json
{
  "id": "evt_a1b2c3",
  "type": "domain.verified",
  "createdAt": "2026-09-27T14:32:00.000Z",
  "data": { "domainId": "d1", "domainName": "example.com", "clientId": "c1",
            "verifiedAt": "2026-09-27T14:32:00.000Z" }
}
```

**No report contents are included.** For `report.received` the payload carries
identifiers and a timestamp only.

This is deliberate. A high volume feed with report bodies would be slow, would
fail more often, and would duplicate what the read API already serves. Fetch
detail from the API when you actually need it.

### Verifying the signature

Every delivery carries a signature over the timestamp and the body.

```
X-DMARC-Harbor-Signature: sha256=<hex>
X-DMARC-Harbor-Event: domain.verified
X-DMARC-Harbor-Delivery: <delivery id>
X-DMARC-Harbor-Attempt: 1
```

Recompute it with the shared secret:

```javascript
const expected = 'sha256=' + crypto
  .createHmac('sha256', secret)
  .update(`${timestamp}.${rawBody}`)
  .digest('hex');

if (expected !== receivedSignature) { /* ignore, this did not come from us */ }
```

**Use the raw request body**, not a re-serialised object, or the hash will not
match. Reject deliveries older than five minutes to stop replays.

### Retries

| Attempt | Delay |
|---|---|
| 1 | immediate |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 30 minutes |
| 5 | 2 hours, then given up |

(Corrected 2026-12-02: an earlier version of this table listed a sixth attempt
after 12 hours. The service has always made five attempts. See
[API.md](API.md#retries-suspension-and-the-delivery-log) for the full rules.)

Respond `2xx` to acknowledge. Anything else, or no response within 10 seconds,
is treated as a failure. After 20 consecutive failures an endpoint is suspended
for 24 hours rather than retried forever.

### Delivery log and replay

`GET /api/workspaces/{id}/webhook-deliveries` lists every attempt with its
response code and last error, so a failing integration is diagnosable without
waiting for a customer complaint. `POST .../webhook-deliveries/{id}/replay`
requeues a failed delivery with a fresh signature.

---

## 2026-12-21 — Agency domains: who signs in there, and claims that lapse

Browser routes only; nothing on `/api/v1` changes.

- **Sign-in on an agency's own domain** is refused with 403
  `AGENCY_DOMAIN_SIGN_IN_REFUSED` for an account that holds a seat in another
  workspace or a live portal grant from another agency. The same account signs
  in on our own address as before. The agency's own team and its own client
  contacts are unaffected.
- **A custom domain or sending domain never verified within 14 days** no longer
  holds the name: `PUT .../branding/custom-domain` and the sending-address
  route take it from the other workspace instead of answering 409
  `CUSTOM_DOMAIN_TAKEN` or `SENDING_DOMAIN_TAKEN`. The workspace that loses it
  gets a `BRANDING_UPDATED` audit row naming the released domain.
- **A verified custom domain is re-checked daily.** After its ownership TXT is
  missing on three days in a row it is unverified (`CUSTOM_DOMAIN_UNVERIFIED`
  in the audit trail): `GET /api/branding/host` answers
  `customDomainVerified: false` and links go back to our address until Verify
  succeeds again.

## 2026-12-20 — Security audit: isolation, request forgery and billing

Mostly browser routes under `/api`. On `/api/v1`, only the domain-name rule below
and the report caps change anything an integration can see.

### Changes an integration might notice

- **Cross-site requests are refused.** A state-changing request that carries the
  session cookie and an `Origin` header must come from the web app or a verified
  agency domain; anything else answers 403 `ORIGIN_REFUSED`. `/api/auth/*`,
  `/api/v1/*`, the payment webhooks, the report ingest and the SAML consumer are
  exempt (each has its own credential). Form-encoded bodies are parsed for the
  SAML consumer only.
- **The two-step and DPA requirements hold on every spelling of a path.** The
  workspace id is decoded and matched without regard to case, and checked again
  on the route's own parameter, so `/api/Workspaces/{id}` or a percent-encoded id
  answers 403 `MFA_REQUIRED` like the plain path. Better Auth's
  `/api/auth/organization/*` endpoints (invite, role change, removal) are held to
  the same requirement.
- **There is no `portal` member role.** Invitations, role changes and added
  members accept owner (by transfer only), admin, analyst and viewer; client
  contacts are portal grants. The owner cannot be removed.
- **Single sign-on admits an address only at an email domain the workspace has
  verified** as a client domain (or a parent of one): 403
  `SSO_DOMAIN_NOT_VERIFIED` otherwise. `GET /api/workspaces/{id}/sso-connections`
  adds `unverifiedEmailDomains`.
- **A social sign-up whose provider does not vouch for the address is refused**
  (`unable_to_create_user`); the account can be created with email and a
  password.
- **A domain name held by another workspace and never verified is released after
  14 days** to the next workspace that adds it (`POST .../domains`, bulk imports
  and `POST /api/v1/domains`). The losing workspace gets a `DOMAIN_DELETED` audit
  row. The refusal before then says so.
- **A verified domain whose proof name answers NXDOMAIN is demoted** to `FAILED`,
  as a missing record already was.
- **Billing:** `PATCH .../billing/currency` needs `billing: update` (the owner);
  `GET .../billing/plan-sync` needs the staff key; checkout answers 409
  `PAYMENT_DUE` while a renewal waits on payment; a plan change answers 409
  `RENEWAL_IN_PROGRESS` while a rupee renewal is being debited; `PATCH .../psa`
  with `enabled: true` needs the PSA feature, as connecting does.
- **`GET /api/branding/host` for an unverified host** answers
  `{ branded: false, customDomainVerified: false }` and nothing that names the
  agency. A custom domain that is one of ours, an `mta-sts.` host or a name with
  an underscore label is refused with 400 `CUSTOM_DOMAIN_RESERVED`.
- **Reports:** a report with more than 50,000 records is refused, a field longer
  than 1,024 characters is cut to that length, and a record or forensic report
  whose source IP is not an IP address is refused. One email may decompress to 64 MB in total; a ZIP whose entries
  overlap is refused; at most 10 files are read from one ZIP. Mailbox polls read
  at most 500 messages, each up to 15 MB.
- **Logos:** an SVG with script, event handlers, embedded documents or links
  elsewhere is refused (400 `LOGO_SVG_UNSAFE`); an image over 4,096 pixels on a
  side is refused (`LOGO_TOO_LARGE`); a presigned upload is checked the same way
  when it is confirmed.

### Additive changes

- `GET /api/ready` answers 503 `{ status: "draining" }` once the instance is
  shutting down.
- Refunds and disputes made at the provider (`adjustment.*`, `refund.*`,
  `payment.dispute.*`) are recorded in the workspace's audit trail as
  `provider_refund_or_dispute`. The plan is not changed by them.
- Notifications of a workspace the person has left are no longer listed.

## 2026-12-19 — Rupee billing on Razorpay Recurring Payments

Rupee subscriptions move from Razorpay Subscriptions to Recurring Payments: we
charge a saved card, UPI Autopay or eNACH mandate each period. An upgrade now
applies at once, with the difference added to the next renewal; a downgrade
still waits for the period end. `/api/v1` is unchanged.

Browser routes:

- `POST /api/workspaces/{id}/billing/checkout` accepts `contact.phone`
  (required for INR; Razorpay refuses a recurring link without it) and
  `method`: `card`, `upi` or `emandate`. Omitted, the default for the amount:
  card up to ₹15,000, eNACH above it. UPI above ₹15,000 answers 400
  `METHOD_NOT_ALLOWED`; a missing phone answers 400 `PHONE_REQUIRED`. Starting
  a checkout closes any earlier unpaid one.
- `GET /api/workspaces/{id}/billing` gains, for a Razorpay subscription:
  `mandate` (`method`, `methodLabel`, `status`, `maxLabel`, `carryOverLabel`),
  `nextCharge` (`amountLabel`, `chargeOn`, `plan`, `needsApproval`) once a
  renewal is announced, and `paymentDue` (`amountLabel`, `payUrl`, `payBy`,
  `plan`) when a renewal waits on a payment link. All three are `null` on
  Paddle and the free plan.
- `POST /api/workspaces/{id}/billing/plan/preview` for an INR upgrade answers
  `effectiveAt: "immediate"`, `chargeNowMinor: 0`, and a `nextAmountMinor`
  that includes the carried difference.
- `POST /api/workspaces/{id}/billing/portal` for INR returns the open renewal
  link, or 409 `NO_PAYMENT_DUE` when nothing is waiting.
- `POST /api/workspaces/{id}/billing/plan` with the current plan and interval
  ("Keep") clears a scheduled change instead of scheduling the same plan.
- `POST /api/webhooks/razorpay` reads payment.captured, payment.failed,
  order.paid, invoice.paid, invoice.expired and token.*. subscription.* is no
  longer read.

## 2026-12-18 — Exports for owners and admins, scoped erasures, mailbox checked on save

Browser routes under `/api` only; `/api/v1` is unchanged. Found in sessions 4,
9, 13 and 16.

### Changes an integration might notice

- **Every `/api/workspaces/{id}/exports` route needs `organization: read`**
  (owners and admins), as erasure does. They were on `report: read`, so a
  viewer could download the workspace export with its forensic reports,
  every member's sessions and IP addresses, invitations, API keys and the
  audit trail. An analyst or viewer now gets 403, and `/settings/export` says
  who can request one.
- **A client or domain export no longer carries the agency's people.** Users,
  memberships and sessions are in the workspace export only, like invitations
  and API keys. A client export's `auditLog` holds that client's rows.
- **Erasing a client or a domain stays in its scope.** It used to clear
  `actorUserId`, `ipAddress` and `requestId` on every audit row in the
  workspace and the subscription's provider ids. It now scrubs personal data
  (addresses, names, recipients) from the rows about that client or domain
  only; `anonymised.subscriptions` is 0.
- **Erasing the whole workspace is refused while a Paddle or Razorpay
  subscription can bill**: `POST …/erasures` with `scope: ORGANIZATION` and
  `POST …/erasures/{id}/execute` answer 409 `SUBSCRIPTION_STILL_ACTIVE`, as
  `DELETE /api/workspaces/{id}` already did. A request made before the
  subscription started waits in `PENDING` until it ends. Clients and domains
  can be erased at any time.
- **`PUT …/report-inbox` signs in to the mailbox before saving.** A refused
  login answers 400 `INBOX_AUTH_FAILED`, a host that does not resolve 400
  `INBOX_HOST_UNRESOLVED`, an unreachable server 502 `INBOX_UNREACHABLE`, a
  mailbox with no INBOX 400 `INBOX_NO_FOLDER`, and nothing is stored. INBOX is
  opened read-only, so the check changes nothing in the mailbox. The same two codes replace the 500 "could not be reached"
  on `POST …/report-inbox/poll`.
- **`GET /api/workspaces/{id}/members` answers 403 to a non-member**, with the
  message every other workspace route gives. It answered 500.
- **Plan-limit messages use the singular for a limit of one**: "Mooring
  includes 1 client", not "1 clients".

### Additive changes

- **`GET /api/reports/share/{token}` carries `senders`**: every sender's
  totals over all the mail (`senderKey`, `senderDomain`, `totalMessages`,
  `dmarcFailedMessages`, `service`, `confidence`), empty when the share
  excludes sources. `sources` still lists at most ten addresses; the share
  page draws its route from `senders`, so a service sending from more than
  ten addresses is no longer drawn short.
- **Forensic reports in the standard form are accepted.** The ingest path
  recognised only `application/feedback-report`; it now also takes
  `message/feedback-report` (RFC 5965) and `Feedback-Type: auth-failure`
  (RFC 6591). Before, a receiver's standard failure report was treated as an
  aggregate report with no attachment and dropped.

---

## 2026-12-17 — Agency custom domains go live before client links use them

Browser routes under `/api` only; `/api/v1` is unchanged. Found in session 14:
the agency was never told where to point its domain, and nothing issued its
certificate.

### Changes an integration might notice

- **`clientOrigin` waits for live.** `GET /api/workspaces/{id}/branding`
  answers `clientOrigin` on the custom domain once the plan includes it, its
  TXT record is verified **and it is live**: `https://<domain>/api/branding/host`
  has answered as this agency through us. Until then it is `APP_URL`, and so is
  every client link built on it (portal invitations, approval requests, monthly
  reports, share links, Trust Centers, prospect reports, compliance pack
  verify links). Live stays live until the domain is changed or removed.
- **`GET /api/branding/host` reads the first `x-forwarded-host`** before
  `Host`, as the portal routes do. Through the web app's `/api` proxy, `Host`
  is ours, so this answered 404 on every agency domain.

### Additive changes

- **`customDomainHosting` on branding.** `GET /api/workspaces/{id}/branding`
  answers how far the domain is from serving: `{ mode, cnameTarget, cnameState,
  hostnameStatus, sslStatus, sslError, setupError, live, liveAt, checkedAt,
  requestedAt }`. `mode` is `automatic` (the certificate is requested from
  Cloudflare for SaaS), `manual` (the operator is asked to add the hostname) or
  `unavailable` (this deployment has no CNAME target). `cnameState` is `found`,
  `missing`, `elsewhere` or null when not read yet.
- **`cnameTarget` and `hosting` on `PUT …/branding/custom-domain`**, the name
  the agency points its hostname at and the same object as above.
- **`hosting` on `POST …/branding/custom-domain/verify`.** Once the TXT record
  is verified, every call also takes the domain one step on: it requests the
  certificate (or tells the operator), reads the CNAME and the certificate's
  state, and checks whether the domain is live. A 15-minute pass
  does the same for every verified domain that is not live yet.
- **`customDomainLive`** on the resolved branding (`GET …/branding/resolved`,
  the portal branding and `GET /api/branding/host`).
- **`CUSTOM_DOMAIN_LIVE`** audit action, with `{ customDomain, mode }`.
- **`CUSTOM_DOMAIN_HOSTNAME_STUCK`** (502, or 503 when the deployment cannot
  reach Cloudflare) from `PUT …/branding/custom-domain` when the domain holds a
  Cloudflare certificate that could not be removed. Nothing is changed; try
  again. A domain another workspace holds is refused with 409
  `CUSTOM_DOMAIN_TAKEN` before anything is released.

---

## 2026-12-16 — Readiness counts part days

Found in session 5.

- **`daysObserved`** on policy readiness (`/policy-readiness`, `/onboarding`,
  the portfolio report) counts a part day as a day. A report period from
  8 October 00:00 to 6 November 23:59:59 is 30 days; it read 29, so no domain
  reached the 30 the rule asks for.
- Blocker sentences count in words ("1 alert is still open", "1 day"), and a
  failing source that named no domain is named by its address instead of
  `<ip>|unknown`.

---

## 2026-12-15 — The first real report: pct, subdomain senders, Resend

Found on Google's first report for our own domain (session 4).

- **`policyFraction`** is now read from `<pct>`, the element receivers send
  (RFC 7489), as well as `<fraction>`. Before, it was null for every real
  report. Reports already stored keep null.
- **`unattributedMessages`** on `GET /api/workspaces/{id}/domain-signals` no
  longer counts mail whose sender authenticated as a name under the domain
  (`mail.example.com` for `example.com`). The domain page's verdict follows.
- **Sender names.** A passing DKIM signature with Resend's default `resend`
  selector under the domain names Resend; a service is named rather than the
  platform it sends through (Resend over Amazon SES). This changes `service`
  and `evidence` on sender and source rows (`/api/v1/domains/{domain}/senders`
  included) for such mail, from Amazon SES to Resend.
- **`topSendingDomain`** on a source breaks a tie towards the domain's own
  passing signature, then DKIM, then name order, instead of database order.

---

## 2026-12-14 — Alert and summary wording in plain words

Found reading real posts in Slack and Teams (session 19). No field changes;
text changes only.

- **`summary`** on new alert events (`GET /api/v1/alerts`, the
  `alert.triggered` webhook) gives the window in hours or days: "in the last 24
  hours", not "in the last 1440 minutes". Existing events keep their text.
- **Alert email, Slack and Teams body:** the metric in words ("failing
  messages", not `FAILURE_COUNT`), "Fires at: more than 50 messages" instead of
  "Threshold: GREATER_THAN 50", "Measured over: the last 24 hours". The first
  notice is "This is the first notice." and the reminders after it are
  "Reminder 1 of 2" and "Reminder 2 of 2" (they read "2 of 3" and "3 of 3",
  counting the first notice as a reminder). PSA reminder notes match.
- **DNS change and expiry summaries:** "DNS changed on 1 domain" or "on 2
  domains", not "domain(s)". A summary about several domains names "2
  domains" as its domain, and its Teams button opens Alerts rather than the
  first domain.

---

## 2026-12-14 — Chat channel audit rows say what changed

Browser routes under `/api` only; `/api/v1` is unchanged. Found in session 19.

- **`detail.change`** on `SLACK_DESTINATION_*` and `TEAMS_DESTINATION_*` rows
  written by `/slack-destinations` and `/teams-destinations`: `added`, or any
  of `address`, `name`, `routing`, `turned on`, `turned off`, or `saved,
  nothing changed`. Before, adding a channel, renaming it, rerouting it and
  giving it a new address all wrote the same row.
- **`detail.clients`** names the routed clients (or `every client`), and
  **`detail.kinds`** is `every kind` when the channel takes all of them.
  `detail.clientIds` stays.
- The Teams legacy-address refusal now names the template as Teams shows it
  today: "Send webhook alerts to a channel".

---

## 2026-12-13 — A DNS lookup that timed out is no longer read as a missing record

Found while testing the free tools against real domains: a large TXT answer
(pfizer.com, cisco.com, oracle.com) could time out, and the scanner then said
the domain's SPF or DMARC record was missing.

- **TXT lookups get two tries of 4 seconds** instead of one of 2.5.
- **A failed lookup is reported as not read.** `dmarc.status` or `spf.status`
  is `error` (an existing value) with the reason in `error`, and the finding is
  `dmarc_lookup_failed` or `spf_lookup_failed` (warning, new codes) instead of
  `dmarc_missing` or `spf_missing`. `POST /api/scan` (the public checker) shows
  this.
- **A domain scan with such a lookup is `FAILED`.** `POST /api/v1/domains/{domain}/scans`
  answers 202 with `status` `FAILED` and the reason in `error`, as for any scan
  that could not finish: it records no DNS changes and leaves the domain as the
  previous scan left it. Before, the timeout read as a removal and was caught
  only by the removal re-check.
- **A domain whose only DKIM key is revoked** gets the title "No working DKIM
  key found" on `dkim_missing`; the code is unchanged.

---

## 2026-12-12 — PSA fixes from a live HaloPSA, and acknowledged alerts that resolve

Found by running PSA ticketing against a real HaloPSA trial. Browser routes
under `/api`, except the alert behaviour, which `/api/v1` sees as well.

**Alerts.** An acknowledged alert now resolves when its rule is back within the
threshold, the same as one nobody acknowledged. Before, only unacknowledged
alerts were ever resolved, so an alert someone acknowledged stayed open for
good and its PSA ticket was never closed. `GET /api/v1/alerts` shows it with
`state: "resolved"` and a `resolvedAt`. After an acknowledged alert resolves,
the same problem coming back raises a new alert at once, instead of waiting
out the acknowledgement window.

**HaloPSA.**

- The resource server is accepted as Halo's API page shows it,
  `https://<instance>/api`; the `/api` is dropped before it is stored.
- The application needs `read:customers` as well as `read:tickets` and
  `edit:tickets`: the connection test and the company search read Halo's
  clients. The setup steps and the 403 message now say so.
- A 403 from Halo drops the cached access token, so adding a missing permission
  in Halo works on the next try instead of up to an hour later.
- The status pickers leave out Halo's sales-order and item statuses. Halo sends
  no closed flag, so statuses whose name closes a ticket (Closed, Resolved,
  Completed, Cancelled) are offered first as the closed status and are not
  offered as the open status.

**PSA screen.**

- `GET /api/workspaces/{id}/psa/jobs` gives each job `about: { clientName,
  domainName }`, read from the job that opened the ticket, and Recent activity
  shows it.
- Connecting records a successful call, so the line no longer reads "Connected"
  beside "No successful call yet".
- A connection paused because Halo refused the credentials gives Halo's own
  sentence once, followed by "Nothing is sent until the credentials are
  replaced; waiting tickets are kept."
- Reminder notes no longer say "nobody has acknowledged this alert" twice.

---

## 2026-12-11 — Webhook suspension: a flag, a notice, and a resume that clears it

**`/api/v1` addition.** Each endpoint in `GET /api/v1/webhooks` (and every
response that returns an endpoint) carries two new fields. `suspended` is
`true` when the endpoint stopped itself after 20 failed attempts in a row, as
opposed to being paused. `probeAt` is when a suspended endpoint gets its one
trial delivery if nobody resumes it first; it is `null` otherwise.

**Changed behaviour.** Resuming a suspended endpoint (`PATCH` with
`{"active": true}`, or Resume in Settings, Webhooks) now sets its failure count
back to zero and sends its held deliveries on the next pass. Before, the count
stayed at the threshold, so one more failure suspended it again at once, and
the held deliveries waited for Send again one by one.

**New notice.** When an endpoint is suspended, owners and admins get an in-app
notification of kind `WEBHOOK` naming the endpoint, the host and the last
answer it gave. Until now a suspension was recorded only in the audit trail.

A refused `http://` endpoint URL now says why in plain words: "The endpoint
must use https: every delivery is signed, and over plain http anyone on the way
can read or change it."

---

## 2026-12-08 — Bulk size cap, domains in another client, and a scoped deletion preview

### Changes an integration might notice

- **The bulk size cap is a 400, not a 402.** `POST /api/v1/clients/bulk` with
  more than 200 rows, and `POST /api/v1/domains/bulk` (and the browser route
  `POST /api/workspaces/{id}/clients/{clientId}/domains/bulk`) with more than
  500, answer 400 `INVALID_REQUEST` with `limit` and `requested`. They answered
  402 `PLAN_LIMIT_REACHED`, which reads as a plan refusal; the cap is the same on
  every plan. Split the request.

### Browser routes only

- **A domain under another client of the same workspace.** `POST
  /api/workspaces/{id}/clients/{clientId}/domains` answers 409 `CONFLICT` naming
  that client, with `client` in the error, instead of saying another workspace
  monitors it. Move the domain instead.
- **`alreadyAdded`** on the 200 that re-adding a name the client already holds
  returns.
- **`GET /api/workspaces/{id}/deletion-preview`** counts the scope asked about:
  `?clientId=` one client and `?domainId=` (new) one domain. With `clientId` it
  returned the whole workspace's totals. A client or domain outside the
  workspace is a 404.
- **`ownershipRecord`** (`host`, `type`, `value`) in the onboarding state while
  the domain is not verified, so the setup page shows it before the first check.
- **Ownership checks read the domain's own nameservers first**, so a check made
  before the record was published no longer keeps failing on a resolver's
  cached "not found" after it is.

---

## 2026-12-07 — One owner per workspace, ownership transfer, and a membership audit trail

Browser routes under `/api` only; `/api/v1` is unchanged.

### Changes an integration or a screen might notice

- **The owner role cannot be given.** `POST /api/auth/organization/update-member-role`
  answers 403 `OWNERSHIP_TRANSFER_REQUIRED` when the new role is owner or the member
  is the owner, and `POST /api/auth/organization/invite-member` answers the same for
  an invitation as owner. A migration made any second owner an admin, keeping the
  earliest.
- **`POST /api/auth/revoke-session`, `/revoke-sessions` and `/revoke-other-sessions`
  return 404.** They revoked sessions with no audit entry. Use
  `DELETE /api/me/sessions/{sessionId}`, `POST /api/me/sessions/revoke-others` and
  `POST /api/me/sessions/revoke-all`.
- **Resending an expired invitation** (`invite-member` with `resend: true`) creates a
  new invitation, as before, and now marks the expired one `canceled`.
- **The team-size refusal names the members it counted:** "...and this workspace
  has 4 members and 1 open invitation."

### Additive changes

- **`POST /api/workspaces/{id}/ownership/transfer`**, owner only, body
  `{ "newOwnerMemberId", "password" }` or `{ "newOwnerMemberId", "code" }`. The member
  becomes owner and the caller admin, in one transaction; both are emailed. Refused
  with 402 `NEW_OWNER_LIMIT_REACHED` (`quota` `workspace`, `client`, `activeDomain` or
  `member`, with `limit` and `wouldHave`; `member` counts members plus open invitations
  and also carries `members` and `pending`) when the new owner's account has no room, 409
  `SUBSCRIPTION_STILL_ACTIVE` while the workspace carries a billed subscription, 409
  `EMAIL_NOT_VERIFIED`, 401 `CONFIRMATION_FAILED`, and 429 after ten attempts in 15
  minutes.
- **New audit actions:** `MEMBER_INVITED`, `INVITATION_RESENT`, `INVITATION_CANCELED`,
  `INVITATION_ACCEPTED`, `INVITATION_REJECTED`, `MEMBER_ROLE_CHANGED` (detail has
  `role` and `previousRole`), `MEMBER_REMOVED`, `MEMBER_LEFT`, `OWNERSHIP_TRANSFERRED`,
  `SLACK_DESTINATION_PAUSED` and `_RESUMED`, `TEAMS_DESTINATION_PAUSED` and
  `_RESUMED`, `FORENSIC_COLLECTION_ENABLED` and `_DISABLED`, `CLIENT_CREATED` and
  `DOMAIN_CREATED` (the web app's single-item routes), `DOMAIN_VERIFIED` (detail
  `checkedBy`: `app`, `api` or `background`) and `BILLING_CURRENCY_SET` (detail
  `from` and `to`).
- **`GET /api/workspaces/{id}/ownership/transfer/preview?newOwnerMemberId=`**,
  owner only, read-only: `currentPlan`, `plan` (the new owner's, which the
  workspace follows afterwards) and `refusal`, the refusal a transfer would meet
  or null. `SUBSCRIPTION_STILL_ACTIVE` now says what to do and carries
  `billingUrl` and `supportUrl`.

---

## 2026-12-06 — Slack, Teams and digest gates, workspaces in the downgrade check, and quota refusals that name the upgrade

Plan limits now hold on the browser routes that skipped them, and every quota
refusal carries the counts and the plan to move to. On `/api/v1` the two single
creates gain fields on their 402, which is additive.

### Changes an integration or a screen might notice

- **Slack and Teams need `alerts.email` (Fairway and up).**
  `PUT /api/workspaces/{id}/slack-destination`, `PUT …/teams-destination`,
  `POST …/teams-destination/test`, and a `PATCH` on either destination that
  sends anything other than `{ "enabled": false }` alone answer
  `402 FEATURE_NOT_IN_PLAN` on Mooring. Reading, pausing with
  `{ "enabled": false }` and `DELETE` work on every plan, so a channel kept
  after a downgrade can be stopped and removed. Before this a free workspace
  could save a channel that never received an alert, and send a real Teams test.
  A refused test does not count toward the five a minute.
- **Editing a digest needs `digests` (Harbor and up).**
  `PATCH /api/workspaces/{id}/report-digests/{digestId}` answers
  `402 FEATURE_NOT_IN_PLAN` below Harbor unless the body is
  `{ "enabled": false }` alone, which pauses a kept digest on any plan.
  `DELETE` works on every plan; sending was already gated. The 2026-11-28 entry
  said editing still worked after a downgrade; it no longer does.
- **Downgrades count workspaces.** `PATCH /api/workspaces/{id}/billing/plan` is
  also refused with `409 PLAN_CHANGE_OVER_QUOTA` while the account owns more
  workspaces than the target plan allows. A row in `error.overage` can have
  `quota: "workspace"`, and the message names each unit ("in use now: 3
  workspaces").
- **An invitation over the team size answers 402.**
  `POST /api/auth/organization/invite-member` answers `402` with
  `code: "PLAN_LIMIT_REACHED"` (it was `403` with only a message). The body is
  flat, not under `error`, and adds `quota` (`member`), `label`, `used` (members
  plus open invitations), `members`, `pending`, `limit`, `plan`, `planLabel`,
  `upgradeTo` and `upgradeToLabel`. Accepting an invitation into a full
  workspace is still `403`.
- **Removed prospect reports still count.** The monthly allowance counts every
  report created this calendar month (UTC), including revoked and removed ones,
  so deleting a report no longer frees a scan.
- **One active-domain window on every plan.** `activeDomainWindowDays` in
  `GET /api/plans` and in a workspace's entitlements is `30` on every plan (it
  was 30, 365, 1,095, 3,650 and 30). A domain counts toward the active-domain
  limit for its first 14 days and while it has sent a report in the last 30.
  This only ever frees places: a domain parked for more than a month no longer
  takes one on Fairway, Harbor or Admiralty.

### Additive changes

- **`POST /api/v1/clients` and `POST /api/v1/domains`** at the plan limit answer
  `402 PLAN_LIMIT_REACHED` with `quota`, `label`, `used`, `requested`, `limit`,
  `plan`, `planLabel`, `upgradeTo` and `upgradeToLabel`, the same as the app's
  routes, where they had only `code` and `message`. They now also send the
  `entitlement.exceeded` webhook. A create refused for any other reason is
  `409 CONFLICT`, as before.
- **`planLimitRejections` rows** from `POST /api/v1/clients/bulk`,
  `POST /api/v1/domains/bulk` and the app's domain import gain `quota`
  (`client` or `activeDomain`), and each `reason` ends with the plan that raises
  that limit ("Upgrade to Admiralty for 300 active domains, or remove one.") or
  "Contact us to add more."
- **`POST /api/workspaces`** at the allowance still answers
  `402 WORKSPACE_LIMIT_REACHED` and adds `quota` (`workspace`), `plan`,
  `planLabel`, `upgradeTo` and `upgradeToLabel` beside `used` and `limit`. The
  message names the plans ("Fairway includes 2 workspaces and you already have
  2. Remove one, or upgrade to Harbor for 3 workspaces.").
- **`402 PROSPECT_LIMIT_REACHED`** adds `plan`, `planLabel`, `upgradeTo` and
  `upgradeToLabel` beside `used`, `limit` and `resetsAt`, and the message says
  that a removed report still counts and names the upgrade.

In every one of these, `upgradeTo` is the next plan that raises the limit that
was hit. It is `null` where none does (Admiralty and Fleet for clients and
domains), and the message then says to contact us.

---

## 2026-12-05 — Support contact, the agency's own sending domain, and the portal on the agency's domain

Three white-label additions on the browser routes under `/api`; `/api/v1` is
unchanged. Every change is additive.

### Support contact and Reply-To (Harbor and up)

- **`supportEmail` and `supportUrl` on `PATCH /api/workspaces/{id}/branding`.**
  Optional; `null` or `""` clears either. `supportEmail` must be one plain
  address (no display name, quotes, angle brackets, commas or line breaks;
  domain lowercased; at most 254 characters). `supportUrl` must be an https
  address with no username or password, at most 500 characters. A bad value is
  `400 INVALID_REQUEST` with a sentence saying what is wrong. Gated on
  `branding.whitelabel` like the rest of the request, and recorded as
  `BRANDING_UPDATED` with the changed fields.
- **`supportEmail`, `supportUrl` on the resolved branding** (`GET
  /api/portal/branding`, `GET /api/branding/host`, `GET
  /api/workspaces/{id}/branding/resolved`, and the branding inside `GET
  /api/portal`). Both are `null` when the plan does not include white label.
  They are the contact the agency publishes to its clients, so they are meant to
  reach those endpoints.
- **`brandSupportEmail`, `brandSupportUrl` on `GET /api/workspaces/{id}/branding`**,
  the stored values.
- **Client mail carries the contact.** For a white-labelled workspace, the
  portal invitation, approval requests, scheduled monthly reports, digests, and a
  password reset or verification started on the agency's domain now set
  `Reply-To` to the support email when there is one, and end with one line:
  "Questions? Contact Wistholm IT at help@wistholm.example or
  https://wistholm.example/help." (whichever parts exist; the reset and
  verification messages name the email only). Mail to the agency's own staff
  never carries either. With no support email there is still no Reply-To; it
  is never guessed from a staff address.

### The agency's own sending domain (Admiralty)

- **`PUT /api/workspaces/{id}/branding/sending-domain`**, body `{ "address":
  "reports@mail.youragency.example" }` or `{ "address": null }`. Answers
  `{ sendingAddress, status, records, verified, notice }`, where `records` is
  the list to publish, each `{ record, type, name, value, priority, status }`
  (`record` is `SPF` or `DKIM`; `priority` is set for the MX record and `null`
  otherwise). The domain is added to our email provider with sending only, so
  no receiving MX is asked for. The same domain with a new local part keeps its
  verification; a new domain replaces the old one. Setting needs
  `branding.customDomain` (`402` otherwise); removing works on any plan. Errors:
  `400 INVALID_REQUEST` (not one plain address, or a domain this service sends
  from or serves, a subdomain of one or a parent of one), `409
  SENDING_DOMAIN_TAKEN`, `502 SENDING_DOMAIN_PROVIDER_ERROR` with the
  provider's reason in the message.
- **`POST /api/workspaces/{id}/branding/sending-domain/verify`** asks the
  provider to check the records and answers `{ sendingAddress, status, records,
  verified }`. The first time the provider reports the domain verified,
  `SENDING_DOMAIN_VERIFIED` is recorded. A domain the provider no longer reports
  verified is marked unverified. Needs `branding.customDomain`.
- **`GET /api/workspaces/{id}/branding`** adds `sendingAddress` (stored, verified
  or not, or `null`), `sendingDomainStatus`, `sendingDomainRecords` (`[]` when
  none), `sendingDomainVerifiedAt` and `sendingDomainCheckedAt`. The provider's id
  for the domain is never returned.
- **`sendingAddress` on the resolved branding**: the agency's own address, only
  while the plan includes `branding.customDomain` and the provider has verified
  the domain; `null` otherwise. Client mail is then sent as `"<workspace name>"
  <sendingAddress>`. Without it, or after a downgrade, client mail uses the
  shared address as before; nothing is deleted.
- **A refused sender falls back.** If the provider refuses a message because its
  From domain is not verified, it is sent once more from the shared address with
  the same display name (and, when the message had one, an idempotency key
  suffixed `:shared-from`). Any other provider error behaves as before.
- **`AuditAction` gains `SENDING_DOMAIN_VERIFIED`.**
- **Workspace deletion** (the erasure request and the delete route) also removes
  the sending domain from the provider, best effort.

### The portal on an agency's own domain

On an agency's verified custom domain, every `/api/portal*` route is scoped to
that agency. The host is read from `x-harbor-portal-host` (set by the web
server on its server-side portal calls) or else the first `x-forwarded-host`
(set by its `/api` proxy), without the port. There:

- a contact whom several agencies serve gets this agency's portal directly, with
  no `400 CHOOSE_WORKSPACE`;
- `?organizationId=` naming another workspace is `403 FORBIDDEN` "This report is
  not available at this address.";
- a contact with no grant from this agency is `403 FORBIDDEN` "This account has
  not been given access to a client report from <agency>.", which never names
  another agency.

On any other host the portal answers as before.

---

## 2026-12-04 — Client links and sign-in on an agency's own domain

An Admiralty agency whose custom domain is verified now has its clients sent
there, and its clients can sign in there. Everything below is on the browser
routes under `/api`; `/api/v1` is unchanged.

### Additive changes

- **`pageUrl` on report shares.** `POST /api/workspaces/{id}/report-shares`
  answers `pageUrl`, the absolute page to send the client:
  `{clientOrigin}/share/{token}`. Every item of `GET
  /api/workspaces/{id}/report-shares` carries it too. `url` is unchanged: the
  relative API path `/api/reports/share/{token}` that returns the report as JSON.
- **`clientOrigin` on branding.** `GET /api/workspaces/{id}/branding` answers
  `clientOrigin`, the origin every link the workspace's clients receive is
  built on: `https://` and the custom domain once the plan includes it and its
  record is verified, and `APP_URL` otherwise. No trailing slash.

### Links that moved to the agency's domain

When the workspace has a verified custom domain its plan includes, these are on
that domain instead of `APP_URL`. For every other workspace they are unchanged.

- The Trust Center link from `POST
  /api/workspaces/{id}/clients/{clientId}/trust-center` (`url`).
- Prospect report links (`url` on `GET` and `POST
  /api/workspaces/{id}/prospect-reports`).
- The link in the portal invitation email, the approval request email and the
  scheduled monthly report email (download and verify links). The compliance
  pack and monthly report PDFs already named the agency's domain and are
  unchanged.

`trustCenter` in the public `GET /api/compliance-packs/verify` answer is now the
relative path `/trust` instead of an absolute `APP_URL` address, so an auditor
who opened the verifier on an agency's domain is not pointed at ours.

### Client email from the agency

For a workspace whose plan includes white label, client facing email (the
portal invitation, approval requests, scheduled monthly reports and digests)
is sent as `"<workspace name>" <CLIENT_EMAIL_FROM_ADDRESS>`, falling back to the
address part of `EMAIL_FROM`. There is no Reply-To (from 2026-12-05, the
agency's published support email when it sets one). Digests from such a
workspace are tagged `[<workspace name>]` in the subject and no longer name
DMARC Harbor. The portal invitation now says how to sign in: with the invited
address, choosing Create an account the first time.

### Sign-in, reset and verification on the agency's domain

`/api/auth/*` reached through the agency's verified domain (the web app's
proxy, which sends the browser's `Origin` and an `x-forwarded-host` naming the
same host) no longer answers 403 `INVALID_ORIGIN`, and accepts a
`callbackURL` or `redirectTo` on that domain. The same `Origin` sent to the API
without the matching `x-forwarded-host`, an unverified domain and a domain the
plan no longer includes are still refused. Production accepts https only.

A password reset or email verification started there, for one of that
agency's client contacts who holds no seat in any workspace, is emailed in the
agency's name with the link on the agency's domain. For anyone else, the
agency's own team included, the link stays on our API host and its
`callbackURL` is moved to `APP_URL`. The "someone tried to sign up" email no
longer names the product.

---

## 2026-12-03 — Fixes to /api/v1 responses

Every item that was listed under Known issues in [API.md](API.md#known-issues)
is fixed, and that section now says there are none. Two more fixes, to the DNS
change rows and to paused webhooks, were found while doing it.

### Changes an integration might notice

These change a status code, an error code or a body that an integration may
branch on. Check any code that handled the old answer.

- **A `clientId` outside the workspace answers 404, not 402.** `POST
  /api/v1/domains` and `POST /api/v1/domains/bulk` answered 402
  `FEATURE_NOT_IN_PLAN` with "That client is not in this workspace." They now
  answer 404 `NOT_FOUND` with the same message, exactly as a client id that
  does not exist anywhere. The browser route that adds domains to a client in
  bulk made the same mistake and is fixed too.
- **An oversized body answers 413 `PAYLOAD_TOO_LARGE`, not `INTERNAL`.** The
  message now states the limit ("The request body is larger than the 10 KB
  this endpoint accepts. ..."). `PAYLOAD_TOO_LARGE` is added to the error codes
  in the reference and in the OpenAPI document. A 415 (a character set or
  content encoding the service cannot read) answers `INVALID_REQUEST` where it
  answered `INTERNAL`.
- **The scan limit's 429 is JSON.** `POST /api/v1/domains/{domain}/scans`
  answered a spent scan budget with plain text ("Too many requests, please try
  again later."). It now answers `{ "error": { "code": "RATE_LIMITED",
  "message": "Too many scans from this network. Wait a minute and try again."
  } }`, like every other limit. The headers, including `Retry-After`, are
  unchanged. The report ingest limit had the same plain-text body and is fixed
  too.
- **A client import no longer fails whole because of one taken domain.** In
  `POST /api/v1/clients` and `POST /api/v1/clients/bulk`, a domain another
  workspace already monitors made the request fail with 500 and nothing in it
  was created. Now the client is created with its other domains and the taken
  domain is listed in a new `domainConflicts` array on that client's entry:
  `{ "index", "name", "reason" }`, where `index` is the domain's position in the
  row's `domains` list. The answer never says which workspace holds it. A
  single create therefore answers 201 where it answered 500, and a bulk row that
  would have taken the whole request down is now created. A domain listed twice
  in one row is added once, where it also used to answer 500.
- **Pausing a webhook endpoint holds the deliveries already queued.** Pausing
  stopped new events being queued and nothing else, so events queued before the
  pause, and their retries, were still sent. Now nothing is sent to a paused
  endpoint. Its queued deliveries are held, keeping the attempts they had made,
  and are sent on the next pass after it is resumed. Send again on a paused
  endpoint's delivery is refused with 409 `CONFLICT` and says to resume first.
  A paused endpoint is no longer probed as if it were suspended, and its failed
  deliveries are not requeued until it is resumed.

### Additive changes

New values in fields that were already there, and new fields. Nothing is
removed or renamed.

- **`mxRecords` is filled.** `GET /api/v1/domains/{domain}` answered
  `mxRecords: []` for every domain. It now lists the mail server host names the
  latest completed scan found, as strings, lowest MX preference first,
  lowercased and without a trailing dot. It is `[]` when there are none, for a
  null MX, and before the first completed scan.
- **A new scan's `changeCount` is real.** The answer to `POST
  /api/v1/domains/{domain}/scans` always had `changeCount: 0`. It is now the
  number of DNS changes that scan recorded, the same number the scan list shows.
- **DNS change rows name their domain.** Rows from `GET /api/v1/dns-changes`
  and the answer to `POST /api/v1/dns-changes/{changeId}/acknowledge` carry
  `domain: { id, name, slug }`, the same shape as an alert row. The `dns.changed`
  webhook already carried `domainId` and `domainName`, and is unchanged.
- **`domainConflicts` on created clients.** Always present on each entry of
  `clients` in a bulk answer and on a single create's answer, empty when every
  domain was added.

### Corrected

- The PSA ticket worker's retry schedule was described as backing off over 1,
  5, 30, 120 and 720 minutes. It makes five attempts and waits 1, 5, 30 and 120
  minutes between them; the 720 is never reached. The 2026-11-11 PSA ticketing
  entry below is corrected.

---

## 2026-12-02 — Moving domains, renames, bulk actions, the assistant and evidence pack 2.0

**`/api/v1` addition.** `POST /api/v1/domains/{domainId}/move` moves a domain,
with its reports, scans, alerts, digests, sender reviews and hosted records, to
another client in the key's workspace. Write scope; honours `Idempotency-Key`.
Share links follow the domain; pending approval requests put to the previous
client's contacts are withdrawn. The DMARC record in DNS is not changed, so the
answer's `reportAddress.next` is the address to publish. A domain in the middle
of a provider switch answers 409 `CONFLICT`. Moving a domain to the client it is
already under answers 200 with `moved: false`. Additive; nothing else in `v1`
changes. See [API.md](API.md).

**Browser routes** (session authenticated, not versioned):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/workspaces/{id}/clients/export` | The client book as CSV, one row per domain |
| `POST` | `/api/workspaces/{id}/clients/{clientId}/rename` | Rename a client or change its slug (409 on a slug in use) |
| `GET` | `/api/workspaces/{id}/domains/{domainId}/move-preview?clientId=` | What a move would carry and change, and what blocks it |
| `POST` | `/api/workspaces/{id}/domains/{domainId}/move` | Move a domain to another client |
| `POST` | `/api/workspaces/{id}/rename` | Rename the workspace (the slug and id stay) |
| `POST` | `/api/workspaces/{id}/alerts/acknowledge` | Acknowledge up to 100 alerts, answered per alert |
| `POST` | `/api/workspaces/{id}/report-shares/revoke` | Revoke up to 100 share links, answered per link |
| `GET` | `/api/workspaces/{id}/assistant` | Starter questions, and whether written answers are on |
| `POST` | `/api/workspaces/{id}/assistant/ask` | Ask a question about the product |

New audit actions: `CLIENT_UPDATED`, `DOMAIN_MOVED`, `WORKSPACE_UPDATED`. The
bulk routes write one row per item with `bulk: true`, the same action as the
single route.

**Assistant.** A new entitlement, `assistant.docs`, is included on Harbor,
Admiralty and Fleet and listed by `GET /api/plans`. The assistant answers only
from the product's own documentation and never reads workspace data. A lower
plan gets 402 `FEATURE_NOT_IN_PLAN` from both assistant routes. Questions are
limited per person per minute and per workspace per day (429 `RATE_LIMITED`).

**Trust Center and compliance pack.** `GET /api/trust/{slug}` gains optional,
additive fields: `evidence` (per-domain authentication posture, policy history,
coverage, senders and open findings), `monitoring`, `evidencePacks`,
`retentionDetail`, `connectedServices`, `noTracking`, `contact`,
`provider.branded`, `provider.logoUrl`, `provider.primaryColor` (both null
unless the workspace's brand is verified) and a `region` on each sub-processor. Existing fields keep
their meaning. Compliance packs issued from today carry `documentVersion`
`2.0`; earlier packs keep their version and still verify. The residency region
is read from `DATA_RESIDENCY_REGION`, and both documents say "Not confirmed
yet" when it is unset.

**Correction.** The webhook retry table above listed a sixth attempt; it has
always been five.

---

## 2026-12-01 — SPF sources in use

`GET /api/workspaces/{id}/domains/{domainId}/spf-usage` (domain read, rate
limited like a scan) says which sources of a domain's SPF record carried mail.
It needs the new `dns.spfUsage` entitlement, which `GET /api/plans` lists on
Fairway, Harbor, Admiralty and Fleet. On Mooring the route answers 402
`FEATURE_NOT_IN_PLAN` with `requiredIn: "FAIRWAY"`, before any DNS is read. Each source (include, a, mx, ip4, ip6) is resolved to the
networks it authorises. The sending addresses in the domain's aggregate reports
from the last 90 days (by report period) are then matched against those
networks.

- `origin` is `managed` for a domain on managed SPF, which is read from its
  managed sources and their last resolved networks with no DNS lookups. It is
  `published` for any other domain, read from the record published now.
- Each source has a `status`:
  - `used`.
  - `unused`.
  - `insufficient_data`: reports cover fewer than 14 days of the window, so
    nothing is called unused yet.
  - `unresolved`: the source uses `exists`, `ptr` or a macro, or a lookup
    failed, so its networks cannot be known in advance.
- Each source also has `messages`, `spfPassMessages`, `matchedIps`,
  `networkCount` and `lookups`. For a published record, `lookups` is what
  removing the source frees.
- `lookupCount` is the cost of the whole published record, and null for a
  managed one.
- `uncovered` counts mail from addresses that no source covers.
- `problem` gives the reason when there is nothing to analyse: no SPF record,
  more than one, or a record that cannot be read.

Matching is by address only, whatever SPF said for each message. A service that
sends with its own bounce domain therefore still counts as used. This errs
toward "used", because removing a source that was still needed would make real
mail fail.

The web app's Reporting and setup tab has a "Check SPF sources" button that
runs the check on demand.

---

## 2026-12-01 — Subdomains seen sending

Each domain now lists the names below it that receivers reported as the From
domain and that the workspace does not monitor: a marketing platform on
`news.example.com` nobody listed, an old app server, or someone trying a name
that looks internal. It is read from the domain's stored aggregate reports
(`header_from`), with no DNS lookups, and is on every plan.

- `GET /api/workspaces/{id}/domains/{domainId}/subdomains` (domain read).
  Looks back 90 days by report period, returns at most 100 names, busiest
  first, each with `messages`, `dmarcPassMessages`, `dmarcPassPercent`,
  `sourceCount`, `firstSeenAt`, `lastSeenAt` and `dismissed`. Names are
  lowercased and folded across spellings (case, a trailing dot). The domain
  itself, other organisations and names already in the workspace are left
  out.
- `PUT /api/workspaces/{id}/domains/{domainId}/subdomains/dismissal` (domain
  update), body `{ name, dismissed }`. `true` hides a name from the list and
  `false` lists it again. The name must be below the domain (400) and must
  have appeared in its reports (404 `SUBDOMAIN_NOT_FOUND`). Idempotent, and
  audited as `SUBDOMAIN_DISMISSED` or `SUBDOMAIN_RESTORED` only when something
  changed.

To monitor a subdomain, add it to the client with the existing
`POST /clients/{clientId}/domains`. It counts toward the plan's domain limit
like any other domain. The web app's domain page has a Subdomains tab with
both actions. Dismissals are included in the data export as
`subdomainDismissals`.

A report whose own policy domain is the subdomain (because it publishes its
own DMARC record) is stored only once that subdomain is a verified domain, so
until then the subdomain shows here only through the parent's reports.

---

## 2026-12-01 — Monthly usage export per client

One row per client for a complete UTC calendar month, for billing the agency's
own clients: `domains`, `verifiedDomains`, `activeDomains`, `reports`,
`messages`, `dmarcPassMessages`, `dmarcPassPercent`, `forensicReports` and
`alertsOpened`, plus `totals`. Reports are counted in the month their reporting
period begins, the same rule as the monthly client report. A domain is active
for the month if it received a report for it or was added in it. `month` is
`YYYY-MM`, one of the last 12 complete months, and defaults to the last one.
A new entitlement, `reports.usageExport`, gates it, on Harbor and above.

**`/api/v1` gains 1 route; existing routes are unchanged.**

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/usage?month=YYYY-MM` | read | Per-client usage for a month (`reports.usageExport`) |

Browser route:

- `GET /api/workspaces/{id}/usage?month=YYYY-MM&format=csv|json` returns the
  file as an attachment. It needs billing read, so a client portal contact
  cannot use it. Cells a spreadsheet would run as a formula are prefixed with a
  quote. Each download is recorded in the audit trail as `EXPORT_DOWNLOADED`
  with target type `usage_export`.

Errors: 400 `INVALID_PERIOD`, `PERIOD_NOT_COMPLETE` or `PERIOD_TOO_OLD`, and
402 `FEATURE_NOT_IN_PLAN` below Harbor.

## 2026-11-30 — Pricing, team sizes, branding split and Fleet bands

**Prices.** Fairway is $39 / ₹3,299 a month and $390 / ₹32,990 a year. Other
flat plans are unchanged. Run the plan sync for both providers and currencies
before taking payment: the catalog check refuses a stored price that differs.

**Team size.** Mooring 2, Fairway 5, Harbor 25, Admiralty and Fleet unlimited.
`maxMembers` is `null` where there is no limit, in `GET /api/plans`,
`GET /api/workspaces/{id}/entitlements` (including `usage.member.limit`) and
`GET /api/v1/me` (`limits.maxMembers`). Treat `null` as no limit.

**Branding.** A new entitlement, `branding.customDomain`, gates the custom
domain (`PUT …/branding/custom-domain` and `POST …/branding/custom-domain/verify`),
on Admiralty only.
`branding.whitelabel` (logo and colours) and `branding.logoUpload` now start at
Harbor and are on Fleet. Removing a kept custom domain
(`customDomain: null`) works on every plan. `GET /api/branding/host` answers 404
for a domain whose workspace no longer has `branding.customDomain`. The resolved
branding gains `customDomainLicensed`.

**Fleet.** Priced in volume bands. `GET /api/plans` gains `bands` on Fleet
(`upTo`, `minimumQuantity`, `unitMinor` per currency); `prices` and
`minimumQuantity` stay the first band's.

| Active domains | USD | INR | Billed at least |
|---|---|---|---|
| Up to 200 | $2.00 | ₹169 | 75 |
| 201 to 500 | $1.25 | ₹106 | 320 |
| 501 to 2,000 | $1.00 | ₹85 | 625 |
| 2,001 to 5,000 | $0.75 | ₹64 | 2,667 |

Each band is its own provider plan (`billing_plan.band`). The quantity sync
moves a subscription to the band its new count falls in, together with the new
count, from the next period. `perDomainQuote` in `GET …/billing` gains `band`.

**Refunds.** The money-back guarantee is 14 days from the first payment, once
per customer: a guarantee refund on any workspace the owner owns makes the rest
ineligible. `GET …/refund-eligibility` reflects both.

`/api/v1` is unchanged except `limits.maxMembers` can be `null`.

## 2026-11-29 — What a downgrade keeps, stops and lets you remove

**Workspace deletion.** `POST /api/auth/organization/delete` now returns 404.
It deleted a workspace at once, skipping the seven-day erasure grace period,
the confirmation email and the audit record. Use
`POST /api/workspaces/{id}/erasures`.

**Single sign-on.** On a plan without `auth.sso`:

- Nobody new joins through a connection, by provisioning or by invitation.
  The sign-in answers 403 `SSO_NOT_IN_PLAN`.
- Existing members keep signing in for 30 days from the downgrade, then get
  the same 403 and sign in with a password. Forgot password creates one for an
  account that never had one.
- `GET /api/workspaces/{id}/sso-connections` lists kept connections with
  `paused: true` and `signInUntil`. It still answers 402 when there are none.
  `DELETE …/sso-connections/{connectionId}` works on every plan. Creating and
  changing a connection still need the plan.

**Report mailbox.** `GET /api/workspaces/{id}/report-inbox` returns a mailbox
kept from a previous plan with `paused: true`, and still answers 402 when there
is none. `DELETE` works on every plan, so the stored password can always be
removed. Changing and polling still need the plan.

**Public pages.** A Trust Center (`GET /api/trust/{slug}`) and a share link
(`GET /api/reports/share/{token}`) answer 404, the same as a withdrawn one,
while the plan lacks `trust.center` or `sharing.links`. They work again after
an upgrade. A Trust Center page already in a CDN cache can be served for up to
an hour.

**Hosted records.** Unchanged: they keep being served after a downgrade and
only edits are refused. The owners and admins now get one email listing the
hosted records and SSO connections the new plan no longer covers.

**Bulk imports.** `POST /api/v1/clients/bulk`, `/api/v1/domains/bulk`,
`/api/v1/clients`, `/api/v1/domains`, the browser bulk domain import and the
switch kit count and insert under the workspace lock. Two imports sent together
can no longer exceed the plan; rows past the limit are in `planBlocked`, as
before.

`/api/v1` response shapes are unchanged.

## 2026-11-28 — Plan limits enforced where they apply

**Team size.** Each plan's member limit (Mooring 1, Fairway 3, Harbor 10,
Admiralty 25, Fleet 25) is now checked. Before this, the organization plugin's
default of 100 applied on every plan.

- `POST /api/auth/organization/invite-member` returns
  `403 { code: "PLAN_LIMIT_REACHED", message }` when members plus open
  invitations already fill the plan. Open invitations count, because each one
  becomes a member when it is accepted.
- `POST /api/auth/organization/accept-invitation` returns 403 when the
  workspace has no free seat, for example after a downgrade.
- SSO sign-in that would provision a new member returns 403 `SSO_MEMBER_LIMIT`
  when the plan is full. A person who is already a member is not affected.

**Workspace creation.** `POST /api/auth/organization/create` now returns 404.
Create workspaces with `POST /api/workspaces`, which checks the plan's
workspace allowance and records the Terms and DPA acceptance. The plugin route
did neither.

**Client allowance.** `POST /api/workspaces/{id}/clients` counts and inserts
under the workspace lock, as domain creation already did. Two requests sent
together can no longer both take the last free client slot. The second gets
`402 PLAN_LIMIT_REACHED`.

**After a downgrade.** Rows made on a higher plan are kept, so nothing has to
be set up again after an upgrade, but the features the lower plan lacks stop
running:

- Alert rules are not evaluated without `alerts.email`, and spoofing rules
  (`NEW_UNAUTHENTICATED_SOURCE`) not without `alerts.spoofing`. No email,
  Slack, Teams or PSA ticket is sent. Open alerts stay listed and are not
  chased by the owner rollup.
- Scheduled digests are not sent without `digests`.
  `POST /api/workspaces/{id}/report-digests/{digestId}/send` and
  `POST /api/workspaces/{id}/report-digests/run` return
  `402 FEATURE_NOT_IN_PLAN`. Listing, editing and deleting a digest still work.
- The agency's own report mailbox is not polled without `reports.inbox`. The
  stored settings are kept.

**Wording.** The `alerts.email` label is now "Alerts by email, Slack and
Teams", `portal.client` is "The client portal and client approvals", and
`reports.compliancePack` is "The compliance pack and monthly client reports".
These are the features each key already gated. The Fairway and Harbor
descriptors in `GET /api/plans` now describe what those plans include.

`/api/v1` is unchanged.

## 2026-11-27 — Client-approved enforcement

An agency can ask a client to approve a stricter DMARC policy for one of their
domains, and the client answers in the portal. The request says in plain words
what happens to fake mail, what the risk is to the client's own mail, and the
evidence the agency is relying on. The decision is recorded under the client
contact's own account.

A request must tighten the policy along the rollout ladder (none, quarantine on
trial, quarantine, reject on trial, reject). The domain must be verified,
publish a DMARC record and have at least one active portal contact. Readiness
is checked for the step asked for. If there are open points, the agency can
still send the request, and the client sees those points before deciding. The
record, the evidence and the open points are frozen in the request. A new
request replaces an open one, every active contact of the client is emailed
under the agency's brand, and the request expires after 14 days. The first
answer stands.

On approval, a record hosted by DMARC Harbor changes at once. Readiness is
overridden only for the points the client was shown. A record that is already
stricter is never loosened. If the change cannot go through (a provider
failure, a concurrent edit, or evidence that turned after a request sent with
no open points), the approval stands, the reason is shown, and the agency can
retry. Any other record is handed back to the agency with the exact value to
publish, and it shows as published once a scan reads it. The agency is told by
in-app notice (kind `POLICY_APPROVAL`) and email. Proposing needs the client
portal (Harbor and up). Reading and withdrawing work on every plan.

Browser routes:

- `GET /api/workspaces/{id}/domains/{domainId}/policy-proposals` returns
  `{ proposals, contacts, applyVia }`.
- `POST` to the same path takes `policy` (`quarantine` or `reject`),
  `testing`, an optional `note` (600) and `acceptBlockers`. It returns
  `201 { proposal }`. It returns 409 with `DOMAIN_NOT_VERIFIED`,
  `NO_PORTAL_CONTACTS`, `NO_DMARC_RECORD` or `NOT_STRICTER`, or with
  `POLICY_NOT_READY` and `blockers`.
- `POST /api/workspaces/{id}/policy-proposals/{proposalId}/withdraw` and
  `.../retry`.
- `GET /api/portal/policy-proposals` and
  `GET /api/portal/domains/{domainId}/policy-proposals` (client contact).
- `POST /api/portal/policy-proposals/{proposalId}/approve` and `.../decline`,
  which takes an optional `reason` (600). Both return 409
  `PROPOSAL_NOT_PENDING` or `PROPOSAL_EXPIRED`.

Policy readiness gains `blockersByLevel` (`quarantine`, `reject`), the open
points for each level separately. This also fixes the hosted DMARC policy
change: a jump from none straight to reject used to pass without a warning
when only quarantine was ready, because it was checked against the next step
the evidence supported. It is now checked against reject.

`/api/v1`: `GET /api/v1/domains/{domain}/policy-readiness` gains
`blockersByLevel`. The change is additive and nothing else changes.

## 2026-11-26 — Prospect risk reports

A workspace can check a domain it does not manage yet, such as a company it is
pitching, and send that company a link to a plain-language risk report under
the workspace's own name. The page explains whether the domain can be
impersonated by email, whether anyone is told when that happens, and whether
mail is signed and encrypted, with an example of what a fake invoice from that
domain would look like.

The scan runs **once**, when the report is created, and the result is stored.
Opening the link never scans again, so a shared link cannot be used to probe
anyone's DNS. Creating a report needs the `prospects.reports` feature (Fairway
and above) and counts against a monthly allowance: Fairway 10, Harbor 50,
Admiralty and Fleet 200, per calendar month in UTC. Deleting old reports does
not return allowance. A scan that fails is neither saved nor counted.

The public page shows the workspace name on every plan; the logo and colours
appear only with white label. It is `noindex`, never cached, and counts views.

Browser routes:

- `GET /api/workspaces/{id}/prospect-reports` — `{ reports, usage }`. Every
  plan, so a downgraded workspace can still see and withdraw its links.
- `POST /api/workspaces/{id}/prospect-reports` — `domain`, optional
  `prospectName` (120), `note` (600), `contactEmail`, `expiresInDays` (1–90,
  default 30). `201 { report }`; `402 PROSPECT_LIMIT_REACHED` with `used`,
  `limit`, `resetsAt`; `502 SCAN_FAILED`.
- `POST /api/workspaces/{id}/prospect-reports/{reportId}/revoke` — `204`.
- `DELETE /api/workspaces/{id}/prospect-reports/{reportId}` — `204`; only once
  revoked or expired, otherwise `409 PROSPECT_REPORT_STILL_ACTIVE`.
- `GET /api/prospect-reports/{token}` — no session. The same `404` for a link
  that never existed, was revoked or has expired.

`/api/v1`: unchanged.

## 2026-11-25 — Domain-expiry alerts

Each verified domain's registration expiry is read over RDAP about once a day,
from the registry that IANA's bootstrap list names for its TLD (no third-party
WHOIS service). A subdomain such as `mail.acme.com` carries the registration of
`acme.com`, which is the thing that lapses. Only public registry data is kept:
the date, the registrar's name and the registry status.

Owners and admins are warned at 30, 14, 7 and 1 days before expiry, and once on
the day it lapses, by in-app notification (kind `DOMAIN_EXPIRY`), email, Slack
and Teams. One message per workspace per pass lists every domain. 7 days and
less is critical. A renewal shows up as a new expiry date at the next daily
lookup and starts the ladder again. Warnings follow the same plan rule and
email preferences as DNS-change alerts; the date itself is shown on every plan.

A failed lookup keeps the last good date. Several ccTLD registries publish no
expiry over RDAP; those domains say so instead of showing a date.

**Operator setup:** `DOMAIN_EXPIRY_ENABLED` (default `true`) and
`DOMAIN_EXPIRY_BATCH_SIZE` (default 100 lookups per hourly pass).

Browser routes:

- `GET /api/workspaces/{id}/domains/{domainId}/registration` — `{ registration }`
  with `registrableDomain`, `status` (`ok`, `no_expiry`, `unsupported`,
  `not_found`, `error`), `expiresAt`, `daysLeft`, `registrar`, `checkedAt`,
  `lastError`; `null` before the first lookup. Every plan; domain read.

`/api/v1`: `GET /api/v1/domains/{domain}` gains `registration`
(`registrableDomain`, `status`, `expiresAt`, `registrar`, `checkedAt`, or
`null`). Additive; nothing else changes.

## 2026-11-25 — Webhook delivery connects only to the address it checked

Each delivery resolves the endpoint's hostname, refuses it if any answer is a
private, loopback or link-local address (including 169.254.169.254), and opens
the connection to exactly the address it checked. Before this, the check ran
first and the HTTP client then resolved the name again on its own, so a
hostname that changed its answer between the two could be steered at an
internal address. The monthly report logo fetch had the same gap and is fixed
the same way.

What a receiver sees is unchanged: the same headers, the same signed body byte
for byte, and the same retries. Three behaviours worth knowing:

- Redirects are still not followed. A 3xx is recorded as the delivery's
  response code with "Redirects are not followed; register the final URL."
- A stored `http://` endpoint is refused at delivery in production
  (registration has always required https).
- A receiver's response body is read up to 64 KB and the rest discarded; a
  large body no longer matters to whether the delivery counts as delivered.

`/api/v1` is unchanged.

## 2026-11-18 — Microsoft Teams alerts and API v1 additions

**Teams is a second chat destination, independent of Slack.** A workspace can
have Slack, Teams, both or neither, and one of them failing does not stop the
other. The same events post there: an alert when it opens and on each reminder,
and one summary per workspace for a pass of critical DNS changes.

Microsoft retired the Office 365 connector's "Incoming Webhook" in May 2026, so
addresses on `outlook.office.com`, `outlook.office365.com` and
`*.webhook.office.com` no longer work. Only Workflows addresses are accepted:

| Accepted | Path must start with |
|---|---|
| `https://<name>.logic.azure.com/...` | `/workflows/` |
| `https://<name>.environment.api.powerplatform.com/...` | `/powerautomate/` |

The host suffix is compared on a label boundary, so a lookalike such as
`evillogic.azure.com.attacker.net` is refused. A retired connector address gets
its own message saying what happened and how to create the new one.

The address is a credential: it is stored encrypted, returned masked to the host
and four characters of the path, never logged, and never exported.

Browser routes, all under `/api/workspaces/{id}/teams-destination`:

- `GET` — the destination, masked, or null.
- `PUT` — connect or replace. Validated before anything is stored.
- `PATCH` — `{ enabled }` to pause and resume, keeping the address.
- `DELETE` — remove it. The flow stays in Teams until it is deleted there.
- `POST /test` — one fixed test message, five a minute per workspace. A
  Workflows setup fails silently, so this is how an MSP finds out before an
  incident rather than during one.

Slack and Teams configuration are now both in the audit trail
(`SLACK_DESTINATION_CONFIGURED`, `SLACK_DESTINATION_REMOVED`,
`TEAMS_DESTINATION_CONFIGURED`, `TEAMS_DESTINATION_REMOVED`), with the channel
label and the host only — never the address.

**`/api/v1` gains 12 routes; existing routes are unchanged.**

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/me` | read | Workspace, plan, feature flags, limits and this key |
| `GET` | `/api/v1/domains/{domain}` | read | One domain, with its last scan, SPF, MX and DKIM selectors |
| `GET` | `/api/v1/domains/{domain}/scans` | read | Scan history, paged |
| `POST` | `/api/v1/domains/{domain}/scans` | write | Run a scan now; 202 with the scan id |
| `GET` | `/api/v1/domains/{domain}/reports` | read | Report headers with message and pass/fail counts |
| `GET` | `/api/v1/domains/{domain}/senders` | read | Sending services, counts and review state |
| `GET` | `/api/v1/domains/{domain}/policy-readiness` | read | What blocks a stricter policy |
| `GET` | `/api/v1/domains/{domain}/tls-reports/summary` | read | TLS-RPT summary (`reports.tlsrpt`) |
| `GET` | `/api/v1/alerts` | read | Alerts, with `?state=open` and `?domain=` (`alerts.email`) |
| `POST` | `/api/v1/alerts/{alertId}/acknowledge` | write | Acknowledge as the key (`alerts.email`) |
| `GET` | `/api/v1/dns-changes` | read | DNS changes, with `?severity=`, `?acknowledged=` and `?domain=` |
| `POST` | `/api/v1/dns-changes/{changeId}/acknowledge` | write | Acknowledge as the key |

`{domain}` accepts the id or the slug. Every one of these resolves the resource
inside the key's workspace, so another workspace's domain, alert or change is
the same 404 as one that does not exist.

**Acknowledgements made through a key are attributed to the key.** The audit row
carries `apiKeyId` and no user, and the PSA ticket gets a note saying the change
was acknowledged through the API rather than naming a member who did not do it.

**Idempotency now covers every write.** `Idempotency-Key` applies to
`POST /clients`, `POST /domains`, `POST /domains/{id}/verify` and every new
write route, with the same rules as the bulk imports: a replay returns the
original response with `Idempotency-Replayed: true`, and reusing a key with a
different body is `409 IDEMPOTENCY_KEY_REUSED`. A refusal is never stored, so a
caller who fixes the problem and retries with the same key gets a fresh answer.

**Rate limit wording corrected.** The per-key budget is
`API_RATE_LIMIT_PER_MINUTE` (300 by default), not a fixed 300. The 300 is the
separate per-address limiter that runs before the key is checked. Both send
`RateLimit` and `RateLimit-Policy` headers.

---

## 2026-11-11 — PSA ticketing

A workspace can connect one PSA — HaloPSA, ConnectWise PSA or Autotask — and
map each client to a company in it. DMARC Harbor then files tickets where the
technician already works:

| Event | What happens in the PSA |
|---|---|
| An alert opens | A ticket is created under the mapped company |
| The reminder ladder fires (level 2+) | An internal note is added |
| The alert is acknowledged | An internal note naming who did it |
| The alert resolves | An internal note, and the ticket closes when `closeOnResolve` is on |
| Critical DNS changes for a domain | One ticket per domain per notification pass |
| A DNS change is acknowledged | An internal note; the ticket closes when every change on it is acknowledged |

Tickets are never created under a default company. An unmapped client produces a
skipped job that the job log shows, because a ticket filed under the wrong
customer tells the wrong people to act.

**Operator setup.** ConnectWise needs one deployment-wide value:
`PSA_CONNECTWISE_CLIENT_ID`, obtained free from developer.connectwise.com and
sent as the `clientId` header on every call. Without it the ConnectWise option
is not offered and the API answers 503 `PSA_PROVIDER_UNAVAILABLE`.

Browser routes, all under `/api/workspaces/{id}/psa`:

- `GET /psa` — provider, status, credential hint, settings, health, ticket
  counts and the clients whose alerts were skipped as unmapped.
- `PUT /psa` (`integrations.psa`, rate limited) — connect or replace. The
  credentials are tested before anything is stored. Replacing them for the same
  PSA keeps mappings, links and queued jobs; pointing at a different PSA (another
  vendor, Halo server or tenant, ConnectWise site or company, or Autotask
  database) clears all three, because their ids belong to the old one.
- `PATCH /psa` — settings with `expectedVersion` (`integrations.psa`, 402
  otherwise), or `{ enabled }` to pause and resume. Pause and resume are never
  gated.
- `DELETE /psa` — removes the connection, mappings, queued jobs and links.
  Tickets already in the PSA stay there.
- `POST /psa/test`, `GET /psa/options`, `GET /psa/companies?search=` — rate
  limited per workspace.
- `GET /psa/mappings`, `PUT|DELETE /psa/mappings/{clientId}`.
- `GET /psa/jobs`, `POST /psa/jobs/{jobId}/retry`.

Every ticket title ends with `[DH-<ref>]`. Before a retry of a create, the
worker searches the PSA for an open ticket carrying that marker, so a lost
response cannot produce a duplicate. A job is tried five times in all, waiting
1, 5, 30 and 120 minutes between attempts, then given up. When the PSA answers
429, its `Retry-After` sets the wait instead (a minute without one, at most an
hour). A 401 or 403 pauses the connection at once because retrying cannot fix
bad credentials. Twenty consecutive failures also pause it, with an audit row
and an in-app notification to owners and admins.

(Corrected 2026-12-03: this paragraph said retries back off over 1, 5, 30, 120
and 720 minutes. With five attempts the 720 minute wait is never reached; the
worker has always waited only the first four.)

`integrations.psa` starts at Harbor. On a downgrade no new tickets are opened,
but notes and closes for tickets that already exist keep flowing, so the
customer's queue is never left with orphans. The connection, mappings, ticket
links and the last 90 days of jobs are in the data export; credentials never
are. `/api/v1` is unchanged.

## 2026-11-04 — Hosted MTA-STS

A domain can now have its MTA-STS policy (RFC 8461) served by DMARC Harbor. The
customer publishes two CNAMEs once:

| Record | Type | Value |
|---|---|---|
| `mta-sts.<domain>` | CNAME | `HOSTED_MTA_STS_CNAME_TARGET` (one shared target) |
| `_mta-sts.<domain>` | CNAME | `<token>._mta-sts.<HOSTED_DNS_ZONE>` |

The certificate for `mta-sts.<domain>` is issued and renewed by Cloudflare for
SaaS on the hosted zone; DMARC Harbor never handles a certificate file. The TXT
we publish is `v=STSv1; id=<id>` and the id changes on every policy change, so a
sender re-fetches.

**Operator setup, not automated.** On the hosted zone: enable Cloudflare for
SaaS, create a proxied fallback origin record that reaches **this API** (not the
web app — the policy is served by the API at the host root), and create the
proxied CNAME `HOSTED_MTA_STS_CNAME_TARGET` pointing at that fallback origin.
The existing `HOSTED_DNS_CLOUDFLARE_TOKEN` now also needs
**Zone → SSL and Certificates → Edit** on that zone, in addition to DNS Edit.
`HOSTED_MTA_STS_HOSTNAME_LIMIT` (default 100) caps how many custom hostnames
this deployment will hold, because Cloudflare for SaaS includes 100 and charges
per hostname after that.

Browser routes:

- `GET /api/workspaces/{id}/domains/{domainId}/hosted-mta-sts` — availability,
  the two CNAMEs, the policy served, the published id, per-name CNAME state,
  certificate state, uncovered MX hosts, readiness blockers and the last 20
  changes.
- `POST …/hosted-mta-sts` (`dns.hostedMtaSts`) — start hosting. An existing
  valid policy is imported unchanged; otherwise the policy starts at `testing`
  with `max_age` 86400 and the domain's current MX hosts. A failed MX lookup
  refuses rather than guessing.
- `PUT …/hosted-mta-sts` (`dns.hostedMtaSts`) — publish a new policy. Moving to
  `enforce` is checked against MX coverage, 14 days of testing, the presence of
  TLS reports and a failure share of at most 1%; blockers answer 409
  `POLICY_NOT_READY` unless `override: true`. Moving back to `testing` is always
  allowed.
- `POST …/hosted-mta-sts/check` — read both CNAMEs and Cloudflare's status. A
  failed lookup changes nothing.
- `POST …/hosted-mta-sts/release` — publish `mode: none` with a new id and keep
  serving it until the longest previously served `max_age` could have expired.

The policy is served at `GET /.well-known/mta-sts.txt` on the API host root,
identified by the `Host` header, with `Cache-Control: no-store` and no cookies.

`dns.hostedMtaSts` starts at Harbor. On a downgrade the policy keeps being
served and refreshed; edits answer 402, and reading, checking and releasing stay
available. The TXT counts toward `HOSTED_DNS_RECORD_LIMIT`, and the custom
hostname toward `HOSTED_MTA_STS_HOSTNAME_LIMIT`. Four new audit actions carry
mode, MX list, `max_age` and the policy id, never a secret. Export includes the
rows and their changes. `/api/v1` is unchanged.

## 2026-11-03 — Hosted BIMI

A domain can now have its BIMI record published by DMARC Harbor. The customer
publishes one CNAME — `default._bimi.<domain>` → `<token>.bimi.<zone>` — uploads
the logo SVG and, for Gmail and Apple Mail, the PEM certificate their certificate
authority issued, and never touches DNS again. Replacing either is an upload.

The TXT we publish is `v=BIMI1; l=<logo URL>; a=<certificate URL or empty>` at
`<token>.bimi.<zone>`. Nothing is published until a logo exists, so a new record
stays `PENDING` with no record at all rather than pointing at a URL that 404s.
`a=` is published empty when there is no certificate and when it has expired.

Browser routes, all requiring `domain:read` or `domain:update` as noted:

- `GET /api/workspaces/{id}/domains/{domainId}/hosted-bimi` — availability, the
  CNAME, the value, the logo and certificate, the DMARC qualification from the
  latest completed scan, delegation state and the last 20 changes.
- `POST …/hosted-bimi` (`dns.hostedBimi`) — start hosting. Verified domain and a
  free slot in the hosted zone required.
- `PUT …/hosted-bimi/logo` (`dns.hostedBimi`) — the SVG as the raw body,
  `image/svg+xml`. Every check the scanner applies is applied here, so an upload
  can never be accepted by the API and rejected by the next scan. Bytes are
  stored exactly as received.
- `PUT …/hosted-bimi/certificate` (`dns.hostedBimi`) — a PEM chain as the raw
  body. A private key is refused and never stored.
- `DELETE …/hosted-bimi/certificate` (`dns.hostedBimi`) — publish `a=` empty.
- `POST …/hosted-bimi/check` — read the CNAME. A failed lookup changes nothing.
- `POST …/hosted-bimi/release` — `{ "removeNow": true }` releases immediately,
  because removing BIMI affects the logo and never mail delivery.

The files are served from `HOSTED_BIMI_ORIGIN`, a separate origin from `APP_URL`,
at `GET /bimi/{token}/{sha12}.svg` and `.pem`. That route is public, reads no
session, sets no cookie, answers the same 404 for every reason, supports HEAD and
is limited to 120 requests a minute per client address. Retired files keep being
served for seven days so cached mailbox lookups still resolve, then a six-hourly
pass purges them.

`dns.hostedBimi` starts at Harbor. On a downgrade the record and its files keep
being served; uploads and removals answer 402, and reading, checking and
releasing stay available. Five new audit actions carry SHA-256 prefixes and
certificate expiry, never bytes. Export includes the rows (token, status, logo
hash, certificate expiry and issuer) and never the bytes. `/api/v1` is unchanged.

## 2026-10-27 — TLS-RPT reports

Verified domains now receive and store daily TLS-RPT reports (RFC 8460) from
the same signed inbound mailbox and IMAP poll as DMARC aggregate mail. Reports
are accepted on every plan; reading them is a Fairway feature
(`reports.tlsrpt`). The published address is the client's existing report
address, or `REPORT_TLSRPT_ADDRESS` when an operator configures a separate
mailbox.

Browser routes:

- `GET /api/workspaces/{id}/domains/{domainId}/tls-reports` returns a newest-first
  page of reports with per-policy summaries.
- `GET …/tls-reports/summary?days=30` returns report and session totals, the
  failure share, breakdowns by result type, receiving MX and policy type, and
  the `record` state with the suggested `_smtp._tls` record.
- `GET /api/workspaces/{id}/tls-reports/{reportId}` returns the full report with
  policies and failure details.

Every report carries the reporting organisation and contact. TLS reports are
not authenticated: RFC 8460 asks reporters to DKIM-sign their mail, but this
intake cannot verify that today, just as the aggregate intake cannot. Reports
are bounded to 5 MB decompressed, 100 policies and 1,000 failure details per
policy; session counts are capped at 10^12.

A new opt-in `tlsrpt.received` webhook carries a pointer only (`reportId`,
`domainId`, `domainName`, `organizationName`, successful and failed session
counts, `receivedAt`). Data export includes TLS reports and a
`tls_report_failures` CSV section, and the inventory and erasure certificate
count the three new tables. `/api/v1` is unchanged.

## 2026-10-26 — Managed SPF

A Harbor workspace can replace a domain's SPF record once with
`v=spf1 redirect=<token>.spf.<zone>` and let DMARC Harbor flatten the sending
services into address ranges in its own zone. Sources whose trees cannot be
flattened safely stay as includes, the lookup count stays under the receiver
limit, and every source is re-resolved every six hours so a provider changing
its ranges does not break mail.

Browser routes:

- `GET /api/workspaces/{id}/domains/{domainId}/managed-spf` returns
  availability, the apex redirect, sources, the last flatten outcome per
  source, the published parts, lookup count, delegate state, the last 20
  changes and capacity. `paused` is true when the plan no longer grants
  `dns.managedSpf`.
- `POST …/managed-spf` imports the apex SPF record, refuses unusable sources on
  the first flatten, publishes the parts and returns the apex redirect.
- `POST …/managed-spf/preview` runs the same flatten and chain without saving
  and returns the lookup count, part count and range counts.
- `PUT …/managed-spf` changes the source list and `-all`/`~all` with
  `expectedVersion`; a provider failure rolls sources and parts back. An
  existing source that fails keeps its last good addresses and records
  `failingSince`; a new failing source refuses the save.
- `POST …/managed-spf/check` re-reads the apex TXT. An error never changes the
  delegation or releases. Release needs exactly one SPF record that no longer
  references DMARC Harbor.
- `POST …/managed-spf/release` stops managing; it is allowed on every plan and
  returns the unflattened record with its real lookup count and over-limit flag.

Capacity now counts hosted DMARC rows plus every published SPF part through
the shared `usedHostedRecords()`. An SPF refresh that would need more parts
than are free keeps the last published parts and sets `capacityBlocked`.
Deletion previews list the unflattened SPF record next to hosted DMARC, data
export includes `hostedSpfRecords`, and scan results keep their existing SPF
fields; the scan history labels a redirect into our zone. `/api/v1` is
unchanged.

## 2026-10-26 — Hosted DMARC records

A workspace on Fairway or above can serve a domain's DMARC record from DMARC
Harbor's own zone. The customer publishes one CNAME at `_dmarc.<domain>`
pointing at a random 16-character token name, and every later policy change is
made here without touching their DNS again. The CNAME and TXT are read back to
mark the record active; a release keeps serving until the CNAME is gone and a
TXT is published again.

Browser routes:

- `GET /api/workspaces/{id}/domains/{domainId}/hosted-dmarc` returns
  availability, the CNAME, the served value and version, policy tags,
  delegation state, the last 20 changes and whether the deployment's zone is
  full. `paused` is true when the plan no longer grants `dns.hosted`.
- `POST …/hosted-dmarc` starts hosting. Over an existing record it keeps the
  published policy and other tags and adds our report address; without one it
  uses the onboarding suggestion. The TXT is live before the row is returned.
- `PUT …/hosted-dmarc` changes `p`, `testing` and `np` with `expectedVersion`.
  A strengthening change uses the same readiness assessment as the policy
  planner and can be overridden explicitly. A provider failure rolls the value
  and version back.
- `POST …/hosted-dmarc/check` re-reads the CNAME and TXT.
- `POST …/hosted-dmarc/changes/{changeId}/restore` restores a policy change
  within 7 days, once.
- `POST …/hosted-dmarc/release` stops hosting; it is allowed on every plan.

Capacity is explicit: `HOSTED_DNS_RECORD_LIMIT` defaults to 200 (Cloudflare
Free) and new hosting is refused with `503 HOSTED_DNS_FULL` at the limit. The
feature is off unless the zone, token and zone id are all configured; a partial
set refuses boot.

Scan results gain an optional `dmarc.delegatedTo`. The workspace deletion
preview lists hosted records with the TXT to republish first, and data export
includes hosted records and their changes. The switch planner recognises our
own CNAME and no longer warns about it. DNS monitoring changes are unchanged.
`/api/v1` is unchanged.

## 2026-10-26 — Two-step verification

Accounts can turn on an authenticator app (TOTP, 6 digits, 30 seconds) and
receive 10 one-time backup codes. Password sign-in then answers
`{ twoFactorRedirect: true }` until the code is verified. Google and Microsoft
sign-in and email-verification auto sign-in cannot create a session for an
account with two-step verification on; the user signs in with email, password
and code instead.

Session-authenticated management routes:

- `GET /api/me/security` returns the account's two-step state, whether it has a
  password, the session's auth method, how many backup codes remain and which
  workspaces require two-step verification. It is never workspace scoped so a
  blocked member can still reach it.
- `PUT /api/workspaces/{id}/security` (owner) turns the workspace requirement on
  or off. Turning it on requires the owner to satisfy it already with an
  authenticator app or an SSO session; otherwise the answer is
  `409 MFA_REQUIRED_FOR_CALLER`. `GET` returns the requirement and how many
  non-portal members have not enrolled.
- `POST /api/workspaces/{id}/members/{memberId}/mfa/reset` (owner) resets another
  member: the secret and backup codes are deleted, the flag is cleared and every
  session is revoked.
- `POST /api/staff/users/{userId}/mfa/reset` (staff key) is the recovery path for
  a sole owner, and requires a recorded reason.
- The workspace gate refuses a non-portal member without two-step verification or
  an SSO session with `403 MFA_REQUIRED`, on every workspace-scoped browser route.
  API keys under `/api/v1` and staff endpoints are unaffected.
- `GET /api/workspaces/{id}/members` includes `twoFactorEnabled` for owners and
  admins only.

New audit actions: `MFA_ENABLED`, `MFA_DISABLED`, `MFA_BACKUP_CODE_USED`,
`MFA_BACKUP_CODES_REGENERATED`, `MFA_RESET`,
`WORKSPACE_MFA_REQUIREMENT_CHANGED`, `MFA_SIGN_IN_REFUSED`. The SSO session
cookie is now signed so `getSession` can read it. `/api/v1` is unchanged.

## 2026-10-26 — DMARC failure counting

DMARC passes when **either** aligned check passed (RFC 9989 section 4.4). A
message that passes aligned DKIM and fails aligned SPF is delivered under
`p=reject`, so it is not a failure.

On the browser routes:

- `failedMessages` on domain insights, trend buckets and source attribution now
  counts messages where **both** aligned checks failed. It previously counted
  messages where either check failed.
- `dmarcPassRate` is new: the share of messages where either aligned check
  passed. `partiallyAlignedMessages` is new: messages that passed DMARC but
  failed one aligned check.
- `FAILURE_COUNT` and `FAILURE_RATE` alert metrics measure DMARC failures.
  Existing thresholds were **not** changed. An open event whose condition no
  longer holds resolves through the existing evaluation path on the next run;
  under the previous count it was a false positive.
- Policy readiness uses the DMARC pass rate. The separate 99% DKIM gate for
  `p=reject` is unchanged, because SPF alone does not survive forwarding.

The `/api/v1` surface exposes none of these fields, so its contract is
unchanged.

## 2026-10-26 — Publish DNS records through Cloudflare

New browser routes under `/api` (not `/api/v1`) let a workspace store a scoped
Cloudflare API Token and publish the DNS records this service already generates.
The feature is available from Fairway.

- `GET/POST /workspaces/{id}/dns-connections`, `DELETE
  /workspaces/{id}/dns-connections/{connectionId}`. The token is verified with
  Cloudflare before saving, encrypted at rest, and never returned; only its last
  four characters are shown. Listing and removing are available after a
  downgrade, and the connection is then reported as `paused`.
- `POST /workspaces/{id}/domains/{domainId}/dns-publish/preview` and
  `POST /workspaces/{id}/domains/{domainId}/dns-publish`.
- `POST /workspaces/{id}/dns-publications/{publicationId}/restore`.

**The server-generated record rule.** A caller names a record kind
(`verification`, `dmarc_suggested`, `dmarc_policy`, `switch_dual`,
`switch_cutover`). The server rebuilds the name and TXT value itself. Record text
sent in the body is ignored and never written. `dmarc_policy` refuses the retired
`pct` parameter.

Publishing re-reads the name and compares a SHA-256 fingerprint of the sorted
current values with the preview. If Cloudflare changed in between, the request
answers `409 DNS_CHANGED` with a fresh preview rather than overwriting. Only the
matching record kind is touched; unrelated TXT records at the same name are left
alone, and two DMARC records or a CNAME are refused.

Restores are allowed once, within seven days, and only while the record still
holds the published value. A DnsPublication row keeps the previous value, and
removing the connection keeps that history while clearing its connection
reference.

## 2026-10-26 — Gmail, Yahoo and Outlook sender requirement checks

`GET /api/workspaces/{id}/domains/{domainId}/mailbox-compliance` returns a
read-only checklist of the sender requirements Google, Yahoo and Microsoft
publish, using only evidence DMARC Harbor already holds: the newest completed
DNS scan, aggregate reports from the last 30 days, sender reviews and the cached
reverse-DNS intelligence.

No DNS lookup or network call is made when the route is read. Reports are
attributed to the three providers by the reporting address domain, falling back
to the reporting organisation name; any other reporter is ignored. At most
50,000 report records are read.

Each check reports `meets`, `fails`, `unconfirmed`, `not_measured` or
`not_checkable`, with evidence and a source link. The route never claims full
provider compliance: TLS, spam rate, message format and one-click unsubscribe
are marked `not_checkable` with where to check them. Available on every plan;
domain read permission is required.

## 2026-10-26 — MTA-STS, TLS-RPT and BIMI in DNS scans

DNS scan results gain three optional fields: `mtaSts`, `tlsRpt` and `bimi`.
`undefined` means the scan predates these checks, not that the record is absent.
A published MTA-STS policy and BIMI logo are fetched over HTTPS through a
guarded fetcher that refuses private and reserved addresses, pins the connection
to the checked address, follows no redirects and caps time and size. Only parsed
facts are stored; fetched policy text is stored as the first 2,000 characters and
logo bytes are never stored or returned.

New finding codes:

- `mta_sts_record_invalid`, `mta_sts_policy_unavailable`,
  `mta_sts_policy_invalid`, `mta_sts_mx_not_covered`
- `tls_rpt_record_invalid`
- `bimi_record_invalid`, `bimi_dmarc_not_enforced`, `bimi_logo_unavailable`,
  `bimi_logo_invalid`

A missing record produces no finding, and the scan score is unchanged. DNS
monitoring gains the change kinds `MTA_STS`, `TLS_RPT` and `BIMI`, with
`mta_sts_removed`, `mta_sts_added`, `mta_sts_mode_weakened`,
`mta_sts_mode_strengthened`, `mta_sts_policy_broken`, `tls_rpt_removed`,
`tls_rpt_added`, `tls_rpt_changed`, `bimi_removed`, `bimi_added` and
`bimi_changed`. These travel in the existing `dns.changed` webhook. No route or
webhook event was added. `/api/v1` is unchanged.

## Planned, not yet available

| Planned | Notes |
|---|---|
| `GET /api/v1/domains/{id}/insights` | Trends, spikes, disposition |
| `GET /api/v1/domains/{id}/dmarc-record` | Generated record and `pct` guidance |
| `GET /api/v1/reports`, `/senders` | Workspace-wide reads; today these are per domain |
| Hosted DNS, webhooks and forensic reports through `v1` | Read-only or absent; these stay browser-only for now |

---

## Integration notes for a PSA

**The native integration is the first choice.** A workspace can connect HaloPSA,
ConnectWise PSA or Autotask under Settings → PSA and map each client to a
company; tickets, reminder notes, acknowledgements and closes then happen
without any code. Everything below is for a PSA that is not one of those three,
or for an agency that already has its own automation and prefers to keep it.

The intended onboarding flow for a hand-rolled integration:

1. On a new client event, call `POST /api/v1/clients/bulk` with
   `Idempotency-Key` set to your ticket id.
2. Read the `verificationHost` and `verificationValue` for each domain from the
   response.
3. Publish those TXT records through your DNS automation.
4. **Do not poll for the result.** Wait for the `domain.verified` webhook and
   close the ticket from that.
5. Once verified, hand the client the DMARC record from the browser interface or
   the planned `dmarc-record` endpoint.

Step 4 is the whole reason webhooks exist. Polling means re-checking every
domain on a timer; the webhook means the ticket closes itself.
