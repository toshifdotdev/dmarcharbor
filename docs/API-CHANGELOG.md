# DMARC Harbor API — Changelog

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
| 5 | 2 hours |
| 6 | 12 hours, then given up |

Respond `2xx` to acknowledge. Anything else, or no response within 10 seconds,
is treated as a failure. After 20 consecutive failures an endpoint is suspended
for 24 hours rather than retried forever.

### Delivery log and replay

`GET /api/workspaces/{id}/webhook-deliveries` lists every attempt with its
response code and last error, so a failing integration is diagnosable without
waiting for a customer complaint. `POST .../webhook-deliveries/{id}/replay`
requeues a failed delivery with a fresh signature.

---

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
response cannot produce a duplicate. Retries back off over 1, 5, 30, 120 and
720 minutes, give up after five attempts, and a 401 or 403 pauses the connection
at once because retrying cannot fix bad credentials. Twenty consecutive failures
also pause it, with an audit row and an in-app notification to owners and admins.

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
