# API reference

## Overview

The API lets your own software work with one workspace: create clients and domains, check domain ownership, run scans, read the evidence (reports, senders, policy readiness, TLS reports), work through alerts and DNS changes, and pull monthly usage for billing. Webhooks are the other direction: the service posts signed events to an address you register.

Use the API when you want something to happen without a person in the app:

- Onboard clients from your PSA, CRM or a spreadsheet, and publish the ownership records through your own DNS automation.
- Copy each client domain's posture into your PSA or RMM every night, so technicians see it where they already work.
- Acknowledge alerts and DNS changes from a ticket, so the app and the ticket agree.
- Keep each domain under the client your PSA says it belongs to.
- Bill your clients from the monthly usage figures.

If your PSA is HaloPSA, ConnectWise PSA or Autotask, connect it under Settings, PSA first. That native integration files tickets, adds notes and closes them with no code. The API is for every other system, and for agencies that already run their own automation.

Everything under `/api/v1` is a contract. Within v1, changes are additive: new endpoints and new fields can appear, and nothing is removed, renamed or changes meaning. A breaking change would ship as v2 beside v1. Write your client so it ignores fields it does not know.

**Every endpoint**

| Method and path | Scope | Plan feature | What it does |
|---|---|---|---|
| [GET /api/v1/me](#get-api-v1-me) | `read` | `api.access` | The workspace, plan, features, limits and this key |
| [GET /api/v1/clients](#get-api-v1-clients) | `read` | `api.access` | Clients with their domains, paged |
| [POST /api/v1/clients](#post-api-v1-clients) | `write` | `api.access` | Create one client, optionally with domains |
| [POST /api/v1/clients/bulk](#post-api-v1-clients-bulk) | `write` | `api.access` | Create up to 200 clients in one call |
| [GET /api/v1/domains](#get-api-v1-domains) | `read` | `api.access` | Every domain in the workspace, paged |
| [POST /api/v1/domains](#post-api-v1-domains) | `write` | `api.access` | Add one domain to a client |
| [POST /api/v1/domains/bulk](#post-api-v1-domains-bulk) | `write` | `api.access` | Add up to 500 domains to one client |
| [POST /api/v1/domains/{domainId}/verify](#post-api-v1-domains-domainid-verify) | `write` | `api.access` | Check the ownership record now |
| [POST /api/v1/domains/{domainId}/move](#post-api-v1-domains-domainid-move) | `write` | `api.access` | Move a domain to another client |
| [GET /api/v1/domains/{domain}](#get-api-v1-domains-domain) | `read` | `api.access` | One domain with its records and registration |
| [GET /api/v1/domains/{domain}/scans](#get-api-v1-domains-domain-scans) | `read` | `api.access` | Scan history, paged |
| [POST /api/v1/domains/{domain}/scans](#post-api-v1-domains-domain-scans) | `write` | `api.access` | Run a scan now |
| [GET /api/v1/domains/{domain}/reports](#get-api-v1-domains-domain-reports) | `read` | `api.access` | Aggregate report headers with counts, paged |
| [GET /api/v1/domains/{domain}/senders](#get-api-v1-domains-domain-senders) | `read` | `api.access` | Sending services and their results |
| [GET /api/v1/domains/{domain}/policy-readiness](#get-api-v1-domains-domain-policy-readiness) | `read` | `api.access` | What blocks a stricter DMARC policy |
| [GET /api/v1/domains/{domain}/tls-reports/summary](#get-api-v1-domains-domain-tls-reports-summary) | `read` | `reports.tlsrpt` | TLS-RPT summary |
| [GET /api/v1/alerts](#get-api-v1-alerts) | `read` | `alerts.email` | Alerts, paged and filterable |
| [POST /api/v1/alerts/{alertId}/acknowledge](#post-api-v1-alerts-alertid-acknowledge) | `write` | `alerts.email` | Acknowledge an alert |
| [GET /api/v1/dns-changes](#get-api-v1-dns-changes) | `read` | `api.access` | DNS changes, paged and filterable |
| [POST /api/v1/dns-changes/{changeId}/acknowledge](#post-api-v1-dns-changes-changeid-acknowledge) | `write` | `api.access` | Acknowledge a DNS change |
| [GET /api/v1/usage](#get-api-v1-usage) | `read` | `reports.usageExport` | Per-client usage for one month |

Every route also needs `api.access`. The plan feature column names the extra feature a route needs, where there is one. See [Plan gates](#plan-gates).

## Base URL

Requests go to the host you use the app on, followed by `/api/v1`. The examples here use:

```text
https://app.dmarcharbor.example/api/v1
```

An agency whose client pages run on its own verified domain can call the API on that host as well, for example `https://portal.wistholm-it.example/api/v1`. The key decides the workspace, not the host, so both addresses reach the same data.

Call the API from a server, a scheduled job or your PSA's automation. Never put a key in a web page or a browser extension: the key acts for the whole workspace, and the API does not accept browser calls from other sites.

## Authentication

Every request carries an API key as a bearer token:

```http
Authorization: Bearer dmh_EXAMPLE0_EXAMPLE0-not-a-real-key-wistholm-it-0000000
```

The examples read the key from an environment variable, which is where it should live:

```bash
export DMH_API_KEY='dmh_EXAMPLE0_EXAMPLE0-not-a-real-key-wistholm-it-0000000'

curl -sS https://app.dmarcharbor.example/api/v1/me \
  -H "Authorization: Bearer $DMH_API_KEY"
```

The same call in PowerShell:

```powershell
$headers = @{ Authorization = "Bearer $env:DMH_API_KEY" }
Invoke-RestMethod -Uri 'https://app.dmarcharbor.example/api/v1/me' -Headers $headers
```

### Issuing a key

Keys are issued in the app under Settings, API keys. Only the workspace owner can issue one, because a key acts for the whole workspace. Owners and admins can see the list and revoke keys.

- **Name.** 3 to 80 characters, and unique among the workspace's live keys. Name it after the system that uses it ("HaloPSA sync", "Billing export") so you know what breaks when you revoke it.
- **Scopes.** `read` calls the read endpoints. `write` calls the endpoints that create or change something. The two are separate: a key with only `write` cannot call a read endpoint. Give a key both if it needs both, and give anything that only reports a `read` key.
- **Expiry.** 30 days, 90 days, 1 year (the default) or 3 years. An expired key stops working at once. Settings, API keys shows the days left and flags a key with 30 days or fewer.

The full key is shown once, when it is issued, and cannot be shown again. It is stored only as a SHA-256 hash, so nobody at the service can read it back either. Store it in your secret manager straight away.

![Settings, API keys: two live keys named after the systems that hold them, with their scope, last use and expiry, and the form to issue another](/docs-media/api-keys.png "Settings, API keys. Each key is named after the system that holds it, so the list says what breaks when one is revoked. Sample data: an invented workspace and keys.")

A key looks like `dmh_` followed by eight characters, an underscore and a 43-character secret. The first part (for example `dmh_EXAMPLE0`) is the prefix the app shows so you can tell keys apart.

### Using a key safely

- The workspace comes from the key, never from the path. A key cannot reach another workspace.
- Settings, API keys shows when each key was last used and from which address. A key nobody can name is a key to revoke.
- Revoking takes effect on the next request. To rotate a key, issue the new one under a new name (two live keys cannot share a name), deploy it, check that it shows a last use, then revoke the old one.
- A key works only while the plan includes the API. After a downgrade every request answers 402 until the plan includes it again; the key itself is not deleted.

## Requests and responses

- Send request bodies as JSON with `Content-Type: application/json`. A body without that header is read as empty and fails validation.
- A request body can be at most 10 KB. A larger body is refused with 413 before it reaches the endpoint. Split a large import into batches of about 100 rows.
- Responses are JSON in UTF-8. Dates are ISO 8601 strings in UTC, for example `2026-11-28T09:14:03.000Z`.
- Ids are opaque strings. Do not parse them.
- Where a path takes `{domain}`, the domain's id or its slug both work. The slug is the readable identifier in the app's address bar, for example `pellowyn-dental-example-k3x9q2`.
- A value the service does not have is `null`, never an empty string or a zero.
- Anything that does not belong to the key's workspace answers 404, exactly as if it did not exist.

## Rate limits

Four limits can apply to a request. Each counts requests in a one-minute window that starts with the first request, and each answers 429 when it is spent.

| Limit | Counted per | Default | Applies to |
|---|---|---|---|
| Per key | API key | 300 a minute | Every `/api/v1` request with a valid key |
| Per address | Your server's IP address | 300 a minute | Every `/api/v1` request, before the key is checked |
| Scans | Your server's IP address | 20 a minute | `POST /api/v1/domains/{domain}/scans` |
| Whole service | Your server's IP address | 600 a minute | Every request to the service, the app included |

The per-key limit is your integration's real budget. The per-address limits matter when several integrations run on one server: they share it. The scan budget is shared with scans started in the app and other on-demand lookups from the same address. The deployment can change the per-key, scan and whole-service numbers, so read the headers rather than hard-coding them.

Every answer carries the headers of the budget it was last counted against. On most routes that is the per-key limit; on the scan route it is the scan limit:

```http
RateLimit-Policy: 300;w=60
RateLimit: limit=300, remaining=287, reset=41
```

`reset` is the number of seconds until the window starts again. A refused request also carries `Retry-After` with the same number of seconds:

```http
HTTP/1.1 429 Too Many Requests
RateLimit-Policy: 300;w=60
RateLimit: limit=300, remaining=0, reset=17
Retry-After: 17
Content-Type: application/json; charset=utf-8

{"error":{"code":"RATE_LIMITED","message":"Too many API requests for this key. Wait a minute and try again."}}
```

The per-address limit says "Too many API requests. Wait a minute and try again." and the whole-service limit says "Too many requests from this network. Wait a minute and try again." The scan limit is the exception: its 429 body is plain text ("Too many requests, please try again later."), not JSON. Decide on the status code and `Retry-After`, never on the body.

Refused requests still count, so retrying in a tight loop keeps you refused until the window ends. Wait for `Retry-After`, then continue.

## Errors

Every error has one shape, except the scan limit's 429, which is plain text:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "That domain is not in this workspace."
  }
}
```

`code` is stable and is what your code should branch on. `message` is a sentence for a person and can change. Some errors add fields beside `code` and `message`; they are listed with the code.

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | The body or query is wrong: a missing field, malformed JSON, a `limit` outside 1 to 200, an unknown filter value |
| 400 | `INVALID_PERIOD` | `GET /usage`: `month` is not a `YYYY-MM` calendar month |
| 400 | `PERIOD_NOT_COMPLETE` | `GET /usage`: the month has not ended |
| 400 | `PERIOD_TOO_OLD` | `GET /usage`: the month is more than 12 complete months ago |
| 401 | `UNAUTHORIZED` | No key, or a key that is invalid, revoked or expired |
| 402 | `FEATURE_NOT_IN_PLAN` | The plan does not include the API or the feature the route needs. Adds `feature`, `plan`, `planLabel`, `requiredIn` and `upgradeTo` |
| 402 | `PLAN_LIMIT_REACHED` | A single create would go past the plan's clients or active domains, or a bulk request is over its size cap (adds `limit` and `requested`) |
| 403 | `FORBIDDEN` | The key does not carry the scope the route needs |
| 404 | `NOT_FOUND` | The resource is not in this workspace, or the endpoint does not exist |
| 409 | `CONFLICT` | The request conflicts with what exists: a slug or domain already in use, a scan of an unverified domain, an alert already acknowledged, a move blocked by a provider switch (adds `blockers`) |
| 409 | `IDEMPOTENCY_KEY_REUSED` | An `Idempotency-Key` was reused with a different request |
| 413 | `INTERNAL` | The body is over 10 KB. The message is "request entity too large". The code is a known defect: treat 413 as "split the request" |
| 429 | `RATE_LIMITED` | A rate limit is spent. The scan limit answers in plain text instead |
| 500 | `INTERNAL` | Something failed on the service's side. Retry later with the same `Idempotency-Key` |

A 402 for a missing feature looks like this:

```json
{
  "error": {
    "code": "FEATURE_NOT_IN_PLAN",
    "message": "API access is not included in Fairway. Upgrade to Harbor to use it.",
    "feature": "api.access",
    "plan": "FAIRWAY",
    "planLabel": "Fairway",
    "requiredIn": "HARBOR",
    "upgradeTo": "HARBOR"
  }
}
```

A malformed JSON body answers 400 `INVALID_REQUEST` with the parser's own message, for example "Expected property name or '}' in JSON at position 1", so you can see where the body broke.

## Pagination

List endpoints return a page of rows under a named key, and `nextCursor` beside it:

```json
{
  "domains": [ { "id": "cmh2k5a1q0009wq8z7m3b8k2d", "name": "pellowyn-dental.example" } ],
  "nextCursor": "cmh2k5a1q0009wq8z7m3b8k2d"
}
```

To read the next page, send `nextCursor` back as `?cursor=`. When `nextCursor` is `null`, you have the last page. There is no total count and no page number.

- `limit` sets the page size: a whole number from 1 to 200, 50 when it is left out. A value outside that range is refused with 400 rather than adjusted.
- `cursor` is the id of the last row of the previous page, at most 64 characters. A cursor that does not match a row returns an empty page.
- Two lists cap the page lower than 200: scans and DNS changes return at most 100 rows. Asking for more is not an error; you get 100 and a cursor.

| Endpoint | Rows under | Order | Largest page |
|---|---|---|---|
| `GET /clients` | `clients` | Oldest client first | 200 |
| `GET /domains` | `domains` | Domain name, A to Z | 200 |
| `GET /domains/{domain}/scans` | `scans` | Newest scan first | 100 |
| `GET /domains/{domain}/reports` | `reports` | Newest report received first | 200 |
| `GET /alerts` | `alerts` | Newest alert first | 200 |
| `GET /dns-changes` | `changes` | Newest change first | 100 |

`GET /domains/{domain}/senders` is not paged: it returns at most 25 senders, the ones with the most failing mail first. `GET /usage` is not paged: it returns one row per client.

## Idempotency

Automation retries. Without protection, a create that timed out and was sent again makes two clients. Send an `Idempotency-Key` header on writes and a retry returns the first answer instead of doing the work twice:

```bash
curl -sS -X POST https://app.dmarcharbor.example/api/v1/clients \
  -H "Authorization: Bearer $DMH_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: halo-ticket-48213" \
  -d '{"name":"Pellowyn Dental","domains":["pellowyn-dental.example"]}'
```

A ticket number or a job id makes a good key: it is stable across retries and unique to the piece of work.

- These endpoints honour the header: `POST /clients`, `POST /clients/bulk`, `POST /domains`, `POST /domains/bulk`, `POST /domains/{domainId}/verify`, `POST /domains/{domainId}/move` and `POST /domains/{domain}/scans`.
- A retry with the same key and the same request gets the stored status and body back, with the header `Idempotency-Replayed: true`. Nothing runs a second time.
- The same key with a different request (a different body, path or query) answers 409 `IDEMPOTENCY_KEY_REUSED`. "Different" is byte for byte: the same fields in another order count as different, so send the retry exactly as the first attempt.
- Only successful answers are stored. A refusal (402, 404, 409) changed nothing, so a retry with the same key runs again and gets a fresh answer. That is what lets you free room on the plan, or fix a name, and retry a single create with the same key.
- A bulk import answers 201 even when some rows failed, and that answer is stored. Resend the failed rows as a new request with a new key.
- A key is remembered for 24 hours from the first request, per workspace.
- The stored answer exists once the first request has finished. A retry sent while the first is still running is not matched, so set your timeout longer than the request can take, and retry after it.
- On verify, a key replays the verdict already given. To ask DNS again, send the request without a key or with a new one.

The two acknowledge endpoints do not read the header. They are safe to repeat anyway: acknowledging a DNS change twice returns the same change, and acknowledging an alert twice answers 409, which means it is already done.

## Plan gates

The API is included on Harbor, Admiralty and Fleet (the `api.access` feature). Some routes read data that has its own feature as well:

| Feature | Routes | Included on |
|---|---|---|
| `api.access` | Every `/api/v1` route | Harbor, Admiralty, Fleet |
| `alerts.email` | `GET /alerts`, `POST /alerts/{alertId}/acknowledge` | Fairway and above |
| `reports.tlsrpt` | `GET /domains/{domain}/tls-reports/summary` | Fairway and above |
| `reports.usageExport` | `GET /usage` | Harbor, Admiralty, Fleet |

Every plan that includes the API includes the other three today, so the 402 an integration usually meets is `api.access` after a downgrade. Check before you call: `GET /me` returns every feature as `true` or `false`, with the same keys used here.

The plan is checked on every request, not only when the key is issued. A refusal is a 402 with code `FEATURE_NOT_IN_PLAN` and the feature's key in `feature` (see [Errors](#errors)).

Plan limits are separate from features: the number of clients and active domains a plan includes. `GET /me` returns them under `limits`. A single create that would go past them answers 402 `PLAN_LIMIT_REACHED`; a bulk import creates what fits and lists the rest in `planLimitRejections`.

## Workspace

### GET /api/v1/me

Which workspace the key belongs to, what the plan includes, and what this key may do. Call it first, and whenever you need to know whether a feature is available, instead of hard-coding plan names.

- Scope `read`. No parameters.

```bash
curl -sS https://app.dmarcharbor.example/api/v1/me \
  -H "Authorization: Bearer $DMH_API_KEY"
```

**Response 200**

```json
{
  "workspace": { "id": "q8Zr2VmK4xT7nLw1pB6yHc3dF9sJ0aGe", "name": "Wistholm IT", "slug": "wistholm-it" },
  "plan": { "tier": "HARBOR", "label": "Harbor", "status": "ACTIVE", "currentPeriodEnd": "2026-12-14T00:00:00.000Z" },
  "features": {
    "reports.aggregate": true,
    "reports.forensic": true,
    "reports.forensicNamed": true,
    "alerts.email": true,
    "alerts.spoofing": true,
    "sharing.links": true,
    "digests": true,
    "audit.trail": true,
    "portal.client": true,
    "auth.sso": false,
    "rollout.canary": false,
    "branding.whitelabel": true,
    "api.access": true,
    "data.export": true,
    "data.erase": true,
    "trust.center": true,
    "reports.compliancePack": true,
    "reports.inbox": true,
    "reports.tlsrpt": true,
    "branding.logoUpload": true,
    "branding.customDomain": false,
    "integrations.webhooks": true,
    "senders.owners": true,
    "dns.automation": true,
    "dns.hosted": true,
    "dns.managedSpf": true,
    "dns.hostedBimi": true,
    "dns.hostedMtaSts": true,
    "integrations.psa": true,
    "prospects.reports": true,
    "reports.usageExport": true,
    "dns.spfUsage": true
  },
  "limits": { "maxClients": 20, "maxActiveDomains": 80, "maxMembers": 25 },
  "key": {
    "id": "cmh9t2w5r0001ab7k3x8m4n2p",
    "name": "HaloPSA sync",
    "scopes": ["read", "write"],
    "expiresAt": "2027-11-28T10:15:00.000Z"
  }
}
```

- `plan.tier` is `MOORING`, `FAIRWAY`, `HARBOR`, `ADMIRALTY` or `FLEET`. `plan.status` is `ACTIVE`, `TRIALING`, `PAST_DUE`, `CANCELLED`, `EXPIRED` or `NONE`.
- `limits.maxMembers` is `null` on a plan with no team-size limit.
- `key.expiresAt` is when this key stops working.

Errors: 401, 402, 429.

## Clients

### GET /api/v1/clients

Every client, oldest first, each with its domains and their verification state.

- Scope `read`. Paged; see [Pagination](#pagination).

| Parameter | In | Notes |
|---|---|---|
| `limit` | query | 1 to 200, default 50 |
| `cursor` | query | `nextCursor` from the previous page |

```bash
curl -sS "https://app.dmarcharbor.example/api/v1/clients?limit=100" \
  -H "Authorization: Bearer $DMH_API_KEY"
```

**Response 200**

```json
{
  "clients": [
    {
      "id": "cmh2k4x7p0003wq8z5t1v9a6e",
      "name": "Pellowyn Dental",
      "slug": "pellowyn-dental",
      "createdAt": "2026-09-14T08:02:11.408Z",
      "domains": [
        {
          "id": "cmh2k5a1q0009wq8z7m3b8k2d",
          "name": "pellowyn-dental.example",
          "status": "VERIFIED",
          "dmarcPolicy": "none",
          "verifiedAt": "2026-09-14T09:47:30.112Z"
        }
      ]
    },
    {
      "id": "cmh2k4x7p0007wq8z2c6j1r4h",
      "name": "Corriwick Café",
      "slug": "corriwick-cafe",
      "createdAt": "2026-10-03T13:20:45.019Z",
      "domains": [
        {
          "id": "cmh2k5a1q000bwq8z4v6n1s8f",
          "name": "corriwick-cafe.example",
          "status": "PENDING",
          "dmarcPolicy": null,
          "verifiedAt": null
        }
      ]
    }
  ],
  "nextCursor": null
}
```

- A domain's `status` is `PENDING` (not verified yet), `VERIFIED` or `FAILED` (it was verified and the proof has since gone).
- `dmarcPolicy` is the published `p=` value from the latest scan (`none`, `quarantine` or `reject`), or `null` before a scan has read one.

Errors: 400 (bad `limit` or `cursor`), 401, 402, 429.

### POST /api/v1/clients

Creates one client, and optionally its domains. The answer carries the TXT record to publish for each domain, so you can start DNS work without a second call.

- Scope `write`. Honours `Idempotency-Key`.

| Field | Type | Notes |
|---|---|---|
| `name` | string, required | 1 to 120 characters |
| `slug` | string | Up to 48 characters, lowercased. Made from the name when left out |
| `domains` | array of strings | Up to 100 domain names. A pasted URL is reduced to its host |

The slug is made by lowercasing the name and turning every run of other characters into a hyphen, so accented letters drop out: "Corriwick Café" becomes `corriwick-caf`. Send `slug` when the name has accents or when you want a particular one.

```bash
curl -sS -X POST https://app.dmarcharbor.example/api/v1/clients \
  -H "Authorization: Bearer $DMH_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: halo-ticket-48219" \
  -d '{"name":"Corriwick Café","slug":"corriwick-cafe","domains":["corriwick-cafe.example"]}'
```

**Response 201**

```json
{
  "index": 0,
  "clientId": "cmh2k4x7p0007wq8z2c6j1r4h",
  "name": "Corriwick Café",
  "slug": "corriwick-cafe",
  "domains": [
    {
      "domainId": "cmh2k5a1q000bwq8z4v6n1s8f",
      "name": "corriwick-cafe.example",
      "verificationHost": "_dmarc-harbor-verification.corriwick-cafe.example",
      "verificationValue": "dmarc-harbor-verification=6f1c2b8e-4d7a-4a39-9e52-0b3f7c1d8a64"
    }
  ]
}
```

Publish a TXT record at `verificationHost` with `verificationValue` as its text, then call [verify](#post-api-v1-domains-domainid-verify) or wait for the `domain.verified` webhook. The service never changes your DNS.

Errors:

- 400 `INVALID_REQUEST`: the body is not valid (no name, a name over 120 characters, more than 100 domains), in which case the message is always "A client name is required.", or a domain name is not usable ("One of those domain names is not usable.").
- 402 `PLAN_LIMIT_REACHED`: the plan has no room for another client or for these domains. The message says which.
- 409 `CONFLICT`: the slug is taken (`A client with the slug "corriwick-cafe" already exists.`) or a domain is already in this workspace (`Already monitoring corriwick-cafe.example.`).
- 401, 402 `FEATURE_NOT_IN_PLAN`, 403, 409 `IDEMPOTENCY_KEY_REUSED`, 413, 429, 500. A domain that another workspace already monitors currently fails the whole request with 500; see [Known issues](#known-issues).

### POST /api/v1/clients/bulk

Creates many clients in one call. Each row stands alone: a bad row is reported and skipped, a row the plan has no room for is reported separately, and the rest are created.

- Scope `write`. Honours `Idempotency-Key`. At most 200 clients per request, and the body must fit in 10 KB.

| Field | Type | Notes |
|---|---|---|
| `clients` | array, required | At least one row |
| `clients[].name` | string | Up to 200 characters; an empty name fails that row |
| `clients[].slug` | string | Up to 48 characters, as for a single create |
| `clients[].domains` | array of strings | Up to 200 per row |

```bash
curl -sS -X POST https://app.dmarcharbor.example/api/v1/clients/bulk \
  -H "Authorization: Bearer $DMH_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: crm-import-2026-11-28" \
  -d '{"clients":[
        {"name":"Haskerley Law","domains":["haskerley-law.example"]},
        {"name":"Pellowyn Dental","domains":["pellowyn-dental.example"]},
        {"name":"Ollerbeck Vets","domains":["ollerbeck-vets.example","ollerbeck-vets-booking.example"]}
      ]}'
```

**Response 201**

```json
{
  "created": 1,
  "failed": 1,
  "planBlocked": 1,
  "clients": [
    {
      "index": 0,
      "clientId": "cmh4p8d2s0002xk9q6w1e5r3t",
      "name": "Haskerley Law",
      "slug": "haskerley-law",
      "domains": [
        {
          "domainId": "cmh4p8d2t0004xk9q3n7b2v8y",
          "name": "haskerley-law.example",
          "verificationHost": "_dmarc-harbor-verification.haskerley-law.example",
          "verificationValue": "dmarc-harbor-verification=0b9e4c71-5a2d-4f86-8c13-7e6a2d9f4b05"
        }
      ]
    }
  ],
  "failures": [
    { "index": 1, "name": "Pellowyn Dental", "reason": "A client with the slug \"pellowyn-dental\" already exists." }
  ],
  "planLimitRejections": [
    { "index": 2, "name": "Ollerbeck Vets", "reason": "Harbor includes 80 active domains and only 1 remain." }
  ],
  "limits": { "maxClients": 200, "maxDomains": 500 }
}
```

- `index` is the row's position in your request, starting at 0, so you can match every outcome to its row.
- `failures` are rows that were wrong: no name, a slug that is taken, a domain name that is not usable, a domain already in this workspace. Fix the row and send it again.
- `planLimitRejections` are rows that were fine but did not fit the plan. Upgrade or free room, then send them again.
- The answer is 201 even when no row was created. Read the counts.
- `limits` is the per-request cap of this endpoint and of `POST /domains/bulk`, not the plan's limits.

Errors: 400 (no `clients` array, or a row of the wrong shape), 401, 402 `FEATURE_NOT_IN_PLAN`, 402 `PLAN_LIMIT_REACHED` with `limit` and `requested` (more than 200 rows), 403, 409 `IDEMPOTENCY_KEY_REUSED`, 413, 429, 500 (see [Known issues](#known-issues)).

## Domains

### GET /api/v1/domains

Every domain in the workspace across all clients, A to Z, each with its client, verification state, published policy and score.

- Scope `read`. Paged; see [Pagination](#pagination).

| Parameter | In | Notes |
|---|---|---|
| `limit` | query | 1 to 200, default 50 |
| `cursor` | query | `nextCursor` from the previous page |

```bash
curl -sS "https://app.dmarcharbor.example/api/v1/domains?limit=200" \
  -H "Authorization: Bearer $DMH_API_KEY"
```

**Response 200**

```json
{
  "domains": [
    {
      "id": "cmh2k5a1q000bwq8z4v6n1s8f",
      "name": "corriwick-cafe.example",
      "status": "PENDING",
      "dmarcPolicy": null,
      "dmarcRecord": null,
      "verifiedAt": null,
      "score": null,
      "collectForensicReports": false,
      "client": { "id": "cmh2k4x7p0007wq8z2c6j1r4h", "name": "Corriwick Café", "slug": "corriwick-cafe" }
    },
    {
      "id": "cmh2k5a1q0009wq8z7m3b8k2d",
      "name": "pellowyn-dental.example",
      "status": "VERIFIED",
      "dmarcPolicy": "none",
      "dmarcRecord": "v=DMARC1; p=none; rua=mailto:rua+3f9a1c7e5b2d@reports.dmarcharbor.example",
      "verifiedAt": "2026-09-14T09:47:30.112Z",
      "score": 78,
      "collectForensicReports": false,
      "client": { "id": "cmh2k4x7p0003wq8z5t1v9a6e", "name": "Pellowyn Dental", "slug": "pellowyn-dental" }
    }
  ],
  "nextCursor": null
}
```

- `score` is the latest scan's score from 0 to 100, or `null` before the first completed scan.
- `dmarcRecord` is the DMARC record the latest scan read.
- The list does not carry the domain's slug; [GET /api/v1/domains/{domain}](#get-api-v1-domains-domain) does.

Errors: 400, 401, 402, 429.

### POST /api/v1/domains

Adds one domain to an existing client and returns the TXT record to publish.

- Scope `write`. Honours `Idempotency-Key`.

| Field | Type | Notes |
|---|---|---|
| `clientId` | string, required | The client's id (not its slug) |
| `name` | string, required | The domain name, up to 253 characters. Lowercased; a pasted URL is reduced to its host |

```bash
curl -sS -X POST https://app.dmarcharbor.example/api/v1/domains \
  -H "Authorization: Bearer $DMH_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: halo-ticket-48230" \
  -d '{"clientId":"cmh2k4x7p0003wq8z5t1v9a6e","name":"pellowyn-smiles.example"}'
```

**Response 201**

```json
{
  "index": 0,
  "domainId": "cmh6r1m9b0006tz4x8k2q7w3c",
  "slug": "pellowyn-smiles-example-w4h8n1",
  "name": "pellowyn-smiles.example",
  "clientId": "cmh2k4x7p0003wq8z5t1v9a6e",
  "verificationHost": "_dmarc-harbor-verification.pellowyn-smiles.example",
  "verificationValue": "dmarc-harbor-verification=a42f7d90-1c6b-4e3a-b8d5-93e0c7f1a6b2"
}
```

Errors:

- 400 `INVALID_REQUEST`: no `clientId`, or no usable domain name.
- 402 `PLAN_LIMIT_REACHED`: the plan has no room for another active domain.
- 409 `CONFLICT`: the domain is already in this workspace, or another workspace monitors it ("That domain is already monitored by another workspace. Remove it there first, or ask them to release it.").
- A `clientId` that is not in this workspace currently answers 402 `FEATURE_NOT_IN_PLAN` with the message "That client is not in this workspace." rather than 404; see [Known issues](#known-issues).
- 401, 403, 409 `IDEMPOTENCY_KEY_REUSED`, 413, 429, 500.

### POST /api/v1/domains/bulk

Adds many domains to one client. Same per-row rules as the client import.

- Scope `write`. Honours `Idempotency-Key`. At most 500 domains per request, and the body must fit in 10 KB (a few hundred names).

| Field | Type | Notes |
|---|---|---|
| `clientId` | string, required | The client's id |
| `domains` | array of strings, required | At least one |

```bash
curl -sS -X POST https://app.dmarcharbor.example/api/v1/domains/bulk \
  -H "Authorization: Bearer $DMH_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: pellowyn-domains-batch-1" \
  -d '{"clientId":"cmh2k4x7p0003wq8z5t1v9a6e","domains":["pellowyn-smiles.example","PELLOWYN-DENTAL.example","not a domain","brisenhay-trading.example"]}'
```

**Response 201**

```json
{
  "created": 1,
  "failed": 3,
  "planBlocked": 0,
  "domains": [
    {
      "index": 0,
      "domainId": "cmh6r1m9b0006tz4x8k2q7w3c",
      "slug": "pellowyn-smiles-example-w4h8n1",
      "name": "pellowyn-smiles.example",
      "clientId": "cmh2k4x7p0003wq8z5t1v9a6e",
      "verificationHost": "_dmarc-harbor-verification.pellowyn-smiles.example",
      "verificationValue": "dmarc-harbor-verification=a42f7d90-1c6b-4e3a-b8d5-93e0c7f1a6b2"
    }
  ],
  "failures": [
    { "index": 1, "name": "pellowyn-dental.example", "reason": "That domain is already in this workspace." },
    { "index": 2, "name": "not a domain", "reason": "That is not a usable domain name." },
    { "index": 3, "name": "brisenhay-trading.example", "reason": "That domain is already monitored by another workspace. Remove it there first, or ask them to release it." }
  ],
  "planLimitRejections": [],
  "limits": { "maxClients": 200, "maxDomains": 500 }
}
```

Errors: 400, 401, 402 `PLAN_LIMIT_REACHED` with `limit` and `requested` (more than 500 domains), 402 `FEATURE_NOT_IN_PLAN` for a `clientId` outside the workspace (see [Known issues](#known-issues)), 403, 409 `IDEMPOTENCY_KEY_REUSED`, 413, 429, 500.

### POST /api/v1/domains/{domainId}/verify

Reads the ownership record now and updates the domain. You do not have to call this: pending domains are also re-checked in the background about once an hour, and the `domain.verified` webhook says when one passes. Call it when someone has just published the record and is waiting.

- Scope `write`. Honours `Idempotency-Key` (a key replays the earlier verdict; leave it out for a fresh read).

| Parameter | In | Notes |
|---|---|---|
| `domainId` | path | The domain's id. The slug also works |

```bash
curl -sS -X POST https://app.dmarcharbor.example/api/v1/domains/cmh2k5a1q000bwq8z4v6n1s8f/verify \
  -H "Authorization: Bearer $DMH_API_KEY"
```

**Response 200**

```json
{
  "domain": { "id": "cmh2k5a1q000bwq8z4v6n1s8f", "name": "corriwick-cafe.example", "status": "VERIFIED" },
  "verification": {
    "verified": true,
    "lookupStatus": "found",
    "host": "_dmarc-harbor-verification.corriwick-cafe.example",
    "type": "TXT",
    "value": "dmarc-harbor-verification=6f1c2b8e-4d7a-4a39-9e52-0b3f7c1d8a64",
    "method": "txt",
    "reportAddressLookupStatus": "found",
    "status": "VERIFIED"
  }
}
```

The answer is 200 whether or not the record was found. Read `verification`:

- `verified` is whether ownership is proved now.
- `lookupStatus` is what the TXT lookup at `host` returned: `found` (a TXT record exists there, which may still be the wrong value), `missing` or `error`. A lookup `error` also adds `error` with the resolver's reason.
- `method` is the proof that held: `txt` for the TXT record, `report_address` when the domain's published DMARC record already sends reports to this client's own report address, or `null`.
- `reportAddressLookupStatus` is the result of the `_dmarc` lookup used for the second proof, or `null` when that check did not run.
- `status` is the domain's state after the check: `VERIFIED`, `PENDING` or `FAILED`. A verified domain is never demoted by a lookup error.
- `host` and `value` are the record to publish, so a caller can show them again without another call.

Errors: 400, 401, 402, 403, 404 (the domain is not in this workspace), 409 `IDEMPOTENCY_KEY_REUSED`, 429.

### POST /api/v1/domains/{domainId}/move

Moves a domain, with everything it owns, to another client in the workspace: for a domain filed under the wrong client, or a brand one client sold to another. Use it from a PSA sync that keeps each domain under the company the PSA says it belongs to.

- Scope `write`. Honours `Idempotency-Key`.
- Moving a domain to the client it is already under answers 200 with `moved: false` and changes nothing, so a nightly sync can send it every time.

| Field | In | Notes |
|---|---|---|
| `domainId` | path | The domain's id or slug |
| `clientId` | body, required | The id of the client to move it to, in this workspace |

What moves with the domain, unchanged: its aggregate and forensic reports, scans, DNS changes, alert rules and alerts, digests, sender reviews and hosted records. Its share links move to the new client, so a shared page names the new client. What changes hands: the previous client's portal contacts stop seeing the domain and the new client's start; approval requests still waiting on the previous client's contacts are withdrawn; monthly reports include the domain under the new client from the next one issued. Open PSA tickets stay with the previous client's PSA company, and new ones go to the new client's.

The domain's DMARC record in DNS is not changed. If it sends reports to the previous client's report address, reports keep arriving, but the record no longer proves the new client owns the domain: publish `reportAddress.next` in its `rua` tag. When `reportAddress.hosted` is true the record is served by the service rather than the client's DNS; check it on the domain's page in the app.

```bash
curl -sS -X POST https://app.dmarcharbor.example/api/v1/domains/cmh7w2k8d0004tz4x6n3q9m1b/move \
  -H "Authorization: Bearer $DMH_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: halo-ticket-48302-move" \
  -d '{"clientId":"cmh7w1x4c0002tz4x2k9p5r7d"}'
```

**Response 200**

```json
{
  "domain": {
    "id": "cmh7w2k8d0004tz4x6n3q9m1b",
    "name": "thrandle-build.example",
    "slug": "thrandle-build-example-r5t2w9",
    "clientId": "cmh7w1x4c0002tz4x2k9p5r7d"
  },
  "from": { "id": "cmh4p8d2s0002xk9q6w1e5r3t", "name": "Haskerley Law" },
  "to": { "id": "cmh7w1x4c0002tz4x2k9p5r7d", "name": "Thrandle Build" },
  "reportAddress": {
    "previous": "rua+8c2e4f6a1b3d@reports.dmarcharbor.example",
    "next": "rua+5d7f9b1c3e2a@reports.dmarcharbor.example",
    "recordNamesPrevious": true,
    "hosted": false
  },
  "moved": true,
  "shareLinksMoved": 1,
  "withdrawnProposals": 0
}
```

- `moved` is false when the domain was already under that client.
- `shareLinksMoved` and `withdrawnProposals` count the share links that now name the new client and the approval requests withdrawn.
- `reportAddress.recordNamesPrevious` is true when the DMARC record last read from DNS sends reports to the previous client's address, which is when you should publish `reportAddress.next`.

Errors:

- 400 `INVALID_REQUEST`: no `clientId` in the body ("A domain in the path and a clientId in the body are required.").
- 404 `NOT_FOUND`: the domain or the client is not in this workspace. The message says which.
- 409 `CONFLICT` with `blockers`: a provider switch is under way for the domain, and its planned record names the previous client's address. Finish or stop the switch on the domain's page, then move it. Each blocker has a `code` (`SWITCH_IN_PROGRESS`) and a `message`.
- 409 `CONFLICT`: the domain changed client while the request was being handled ("The domain changed client while this was being sent. Try again.").
- 401, 402, 403, 409 `IDEMPOTENCY_KEY_REUSED`, 413, 429, 500.

### GET /api/v1/domains/{domain}

One domain: everything the list carries, plus its slug, when it was last scanned, its SPF record, its DKIM selectors and its registration expiry.

- Scope `read`.

| Parameter | In | Notes |
|---|---|---|
| `domain` | path | The domain's id or slug |

```bash
curl -sS https://app.dmarcharbor.example/api/v1/domains/pellowyn-dental-example-k3x9q2 \
  -H "Authorization: Bearer $DMH_API_KEY"
```

**Response 200**

```json
{
  "domain": {
    "id": "cmh2k5a1q0009wq8z7m3b8k2d",
    "name": "pellowyn-dental.example",
    "slug": "pellowyn-dental-example-k3x9q2",
    "status": "VERIFIED",
    "dmarcPolicy": "none",
    "dmarcRecord": "v=DMARC1; p=none; rua=mailto:rua+3f9a1c7e5b2d@reports.dmarcharbor.example",
    "verifiedAt": "2026-09-14T09:47:30.112Z",
    "score": 78,
    "collectForensicReports": false,
    "lastScanAt": "2026-11-28T03:12:09.000Z",
    "spfRecord": "v=spf1 include:spf.protection.outlook.com include:hubspotemail.net -all",
    "mxRecords": [],
    "dkimSelectors": ["selector1", "selector2", "hs1"],
    "client": { "id": "cmh2k4x7p0003wq8z5t1v9a6e", "name": "Pellowyn Dental", "slug": "pellowyn-dental" },
    "registration": {
      "registrableDomain": "pellowyn-dental.example",
      "status": "ok",
      "expiresAt": "2027-03-02T23:59:59.000Z",
      "registrar": "Example Registrar Ltd",
      "checkedAt": "2026-11-28T04:00:12.000Z"
    }
  }
}
```

- `dkimSelectors` are the selectors the latest scan found a key at.
- `mxRecords` is meant to list the domain's mail servers. It is currently always an empty array; see [Known issues](#known-issues).
- `registration` is the registry's answer, read over RDAP about once a day, or `null` before the first lookup. `status` is `ok`, `no_expiry` (the registry publishes no expiry date), `unsupported`, `not_found` or `error`. A failed lookup keeps the last good date.

Errors: 401, 402, 404, 429.

## Scans

A scan reads the domain's DMARC, SPF, DKIM, MX, MTA-STS, TLS-RPT and BIMI records, scores them, and records any change since the previous scan as a [DNS change](#dns-changes). Verified domains are also scanned on a schedule.

### GET /api/v1/domains/{domain}/scans

The domain's scan history, newest first. Each row is the outcome, not the scanner's working detail: read the domain for the conclusions.

- Scope `read`. Paged, at most 100 a page.

| Parameter | In | Notes |
|---|---|---|
| `domain` | path | The domain's id or slug |
| `limit` | query | 1 to 200, default 50; more than 100 returns 100 |
| `cursor` | query | `nextCursor` from the previous page |

```bash
curl -sS "https://app.dmarcharbor.example/api/v1/domains/pellowyn-dental-example-k3x9q2/scans?limit=20" \
  -H "Authorization: Bearer $DMH_API_KEY"
```

**Response 200**

```json
{
  "scans": [
    {
      "id": "cmhb3q7n2000ftd5w1x8k4m6z",
      "status": "COMPLETED",
      "trigger": "SCHEDULED",
      "score": 78,
      "error": null,
      "startedAt": "2026-11-28T03:12:04.391Z",
      "completedAt": "2026-11-28T03:12:09.000Z",
      "changeCount": 1
    },
    {
      "id": "cmhafx2c9000atd5w6p3r8v1n",
      "status": "FAILED",
      "trigger": "MANUAL",
      "score": null,
      "error": "The lookups did not return an answer.",
      "startedAt": "2026-11-26T15:40:11.207Z",
      "completedAt": "2026-11-26T15:40:21.000Z",
      "changeCount": 0
    }
  ],
  "nextCursor": "cmhafx2c9000atd5w6p3r8v1n"
}
```

- `status` is `RUNNING`, `COMPLETED` or `FAILED`. A failed scan keeps its reason in `error` and leaves the domain as the previous scan left it.
- `trigger` is `SCHEDULED` or `MANUAL` (started in the app or through the API).
- `changeCount` is the number of DNS changes the scan recorded.

Errors: 400, 401, 402, 404, 429.

### POST /api/v1/domains/{domain}/scans

Runs a scan now. The request waits for the scan, usually a few seconds, and answers 202 with the finished row.

- Scope `write`. Honours `Idempotency-Key` (a retry returns the same scan instead of running another).
- Limited to 20 scans a minute per address as well as by the key's budget; see [Rate limits](#rate-limits).
- The domain must be verified.

```bash
curl -sS -X POST https://app.dmarcharbor.example/api/v1/domains/pellowyn-dental-example-k3x9q2/scans \
  -H "Authorization: Bearer $DMH_API_KEY" \
  -H "Idempotency-Key: rescan-pellowyn-2026-11-28T10"
```

**Response 202**

```json
{
  "scan": {
    "id": "cmhb7d4k1000htd5w9q2n6x3s",
    "status": "COMPLETED",
    "trigger": "MANUAL",
    "score": 78,
    "error": null,
    "startedAt": "2026-11-28T10:04:51.118Z",
    "completedAt": "2026-11-28T10:04:55.000Z",
    "changeCount": 0
  }
}
```

A scan that could not finish still answers 202, with `status` `FAILED` and the reason in `error`. `changeCount` is always 0 in this answer, even when the scan recorded changes; read the scan list or `GET /dns-changes` for them (see [Known issues](#known-issues)).

Errors: 401, 402, 403, 404, 409 `CONFLICT` ("Verify the domain before running an authenticated scan."), 409 `IDEMPOTENCY_KEY_REUSED`, 429 (the scan limit's 429 is plain text).

## Reports, senders and readiness

### GET /api/v1/domains/{domain}/reports

The domain's aggregate DMARC reports, newest received first: who reported, the period covered, and how much mail passed or failed. Row-level detail (sending addresses, envelope senders) is not included; it stays in the app.

- Scope `read`. Paged.

| Parameter | In | Notes |
|---|---|---|
| `domain` | path | The domain's id or slug |
| `limit` | query | 1 to 200, default 50 |
| `cursor` | query | `nextCursor` from the previous page |

```bash
curl -sS "https://app.dmarcharbor.example/api/v1/domains/pellowyn-dental-example-k3x9q2/reports?limit=2" \
  -H "Authorization: Bearer $DMH_API_KEY"
```

**Response 200**

```json
{
  "reports": [
    {
      "id": "cmhb2w8f5000ctd5w3k7m1q9x",
      "reportId": "13582731940228856197",
      "reportingOrganization": "google.com",
      "reportType": "AGGREGATE",
      "dateRangeBegin": "2026-11-27T00:00:00.000Z",
      "dateRangeEnd": "2026-11-27T23:59:59.000Z",
      "receivedAt": "2026-11-28T06:14:22.530Z",
      "recordCount": 3,
      "messageCount": 1840,
      "passedMessages": 1834,
      "failedMessages": 6
    },
    {
      "id": "cmhb2t1a8000btd5w5n2x6r4v",
      "reportId": "pellowyn-dental.example!1795737600!1795824000",
      "reportingOrganization": "Enterprise Outlook",
      "reportType": "AGGREGATE",
      "dateRangeBegin": "2026-11-27T00:00:00.000Z",
      "dateRangeEnd": "2026-11-28T00:00:00.000Z",
      "receivedAt": "2026-11-28T04:51:07.114Z",
      "recordCount": 5,
      "messageCount": 412,
      "passedMessages": 412,
      "failedMessages": 0
    }
  ],
  "nextCursor": "cmhb2t1a8000btd5w5n2x6r4v"
}
```

`passedMessages` counts messages that passed DMARC, meaning aligned DKIM or aligned SPF passed, the same rule the app uses. `failedMessages` is the rest.

Errors: 400, 401, 402, 404, 429.

### GET /api/v1/domains/{domain}/senders

The services sending mail as the domain, from its aggregate reports: how much each sent, how much failed, whether it signs with DKIM and passes SPF, and whether someone has reviewed it. The same table as the domain's Senders tab, without the sending addresses.

- Scope `read`. Not paged: at most 25 senders, the ones with the most failing mail first. Based on the newest 50,000 report rows.

```bash
curl -sS https://app.dmarcharbor.example/api/v1/domains/pellowyn-dental-example-k3x9q2/senders \
  -H "Authorization: Bearer $DMH_API_KEY"
```

**Response 200**

```json
{
  "senders": [
    {
      "service": null,
      "serviceName": null,
      "senderDomain": "bulk-relay.example",
      "totalMessages": 64,
      "failedMessages": 64,
      "dmarcFailedMessages": 64,
      "failureSharePercent": 100,
      "dkimPassMessages": 0,
      "spfPassMessages": 0,
      "status": "failing",
      "confidence": "unknown",
      "firstSeenAt": "2026-11-26T06:02:18.000Z",
      "lastSeenAt": "2026-11-28T06:14:22.000Z",
      "isNew": true,
      "review": { "status": "UNREVIEWED", "note": null, "reviewedAt": null }
    },
    {
      "service": "hubspot",
      "serviceName": "HubSpot",
      "senderDomain": "pellowyn-dental.example",
      "totalMessages": 2140,
      "failedMessages": 180,
      "dmarcFailedMessages": 18,
      "failureSharePercent": 8,
      "dkimPassMessages": 2120,
      "spfPassMessages": 1962,
      "status": "degraded",
      "confidence": "confirmed",
      "firstSeenAt": "2026-09-16T05:40:02.000Z",
      "lastSeenAt": "2026-11-28T06:14:22.000Z",
      "isNew": false,
      "review": { "status": "APPROVED", "note": "Patient newsletters.", "reviewedAt": "2026-10-02T09:41:00.000Z" }
    },
    {
      "service": "microsoft-365",
      "serviceName": "Microsoft 365",
      "senderDomain": "pellowyn-dental.example",
      "totalMessages": 18240,
      "failedMessages": 312,
      "dmarcFailedMessages": 0,
      "failureSharePercent": 2,
      "dkimPassMessages": 18240,
      "spfPassMessages": 17928,
      "status": "clean",
      "confidence": "confirmed",
      "firstSeenAt": "2026-09-14T06:12:40.000Z",
      "lastSeenAt": "2026-11-28T06:14:22.000Z",
      "isNew": false,
      "review": { "status": "APPROVED", "note": "Staff mailboxes.", "reviewedAt": "2026-10-02T09:40:12.000Z" }
    }
  ]
}
```

- `service` is a stable identifier to key on (`microsoft-365`, `google-workspace`, `hubspot`, `sendgrid` and so on), and `serviceName` is the label to show a person. Both are `null` for a sender that is not recognised.
- `confidence` is how the sender was recognised: `confirmed` (a passing aligned DKIM or SPF domain belongs to the service), `likely` (the sending servers' confirmed reverse DNS belongs to it), `network` (only the network operator is known, so no service is named), `own` (the servers belong to the domain itself) or `unknown`.
- `dmarcFailedMessages` failed DMARC: both aligned DKIM and aligned SPF failed. `failedMessages` did not pass both checks, a wider count; `failureSharePercent` is that count as a whole percentage of `totalMessages`.
- `status` is `clean` (no DMARC failures), `degraded` (up to 5% failed DMARC), `failing` (more than 5%) or `insufficient-data` (fewer than 50 messages).
- `isNew` is true for a sender first seen in the last 7 days.
- `review.status` is `APPROVED`, `NOT_OURS` or `UNREVIEWED`, set by a person on the Senders tab.

Errors: 401, 402, 404, 429.

### GET /api/v1/domains/{domain}/policy-readiness

What stands between the domain and a stricter DMARC policy, in plain sentences. The same assessment as the domain's Policy posture panel in the app.

- Scope `read`.

```bash
curl -sS https://app.dmarcharbor.example/api/v1/domains/pellowyn-dental-example-k3x9q2/policy-readiness \
  -H "Authorization: Bearer $DMH_API_KEY"
```

**Response 200**

```json
{
  "level": "none",
  "ready": false,
  "currentPolicy": "none",
  "testing": false,
  "daysObserved": 47,
  "daysAtCurrentPolicy": 47,
  "dkimPassRatePercent": 99.6,
  "messagesObserved": 20444,
  "passRatePercent": 99.6,
  "openAlerts": 0,
  "staleAlerts": 0,
  "failingSenders": 1,
  "observedSenders": 3,
  "blockers": [
    "Sending service bulk-relay.example fails DMARC on 100% of its 64 messages (seen from 203.0.113.45). Fix its SPF or DKIM before enforcing, or confirm it is an attacker."
  ],
  "blockersByLevel": {
    "quarantine": [
      "Sending service bulk-relay.example fails DMARC on 100% of its 64 messages (seen from 203.0.113.45). Fix its SPF or DKIM before enforcing, or confirm it is an attacker."
    ],
    "reject": [
      "Sending service bulk-relay.example fails DMARC on 100% of its 64 messages (seen from 203.0.113.45). Fix its SPF or DKIM before enforcing, or confirm it is an attacker.",
      "The domain is not on p=quarantine yet. RFC 9989 section 7.4 moves in stages: p=none, then p=quarantine for at least as long, then p=reject."
    ]
  }
}
```

- `level` is the strictest policy the evidence supports now: `none`, `quarantine` or `reject`. `ready` is true when that is above `none`.
- `currentPolicy` is the published policy, or `unknown`. `testing` is true when `t=y` is published.
- `blockers` are the points blocking the next step. `blockersByLevel` lists them separately for `quarantine` and `reject`, so a request for one level can be checked against that level.
- The thresholds behind the sentences: at least 1,000 messages and 30 days of reports, a DMARC pass rate of 95% for quarantine and 99% for reject, 30 days at quarantine before reject, and 99% DKIM for reject.
- Mark a sender Not ours on the Senders tab when it is an attacker, and it stops blocking.

Errors: 401, 402, 404, 429.

### GET /api/v1/domains/{domain}/tls-reports/summary

The domain's TLS-RPT reports over a window: how many delivery sessions succeeded and failed, why they failed, at which mail server, and whether the domain publishes the record that sends the reports here.

- Scope `read`. Needs `reports.tlsrpt`.

| Parameter | In | Notes |
|---|---|---|
| `domain` | path | The domain's id or slug |
| `days` | query | Window in days, 1 to 365, default 30. Out-of-range values are brought into range |

```bash
curl -sS "https://app.dmarcharbor.example/api/v1/domains/pellowyn-dental-example-k3x9q2/tls-reports/summary?days=30" \
  -H "Authorization: Bearer $DMH_API_KEY"
```

**Response 200**

```json
{
  "days": 30,
  "reportCount": 58,
  "successfulSessions": 41210,
  "failedSessions": 12,
  "failureSharePercent": 0.02,
  "lastReportAt": "2026-11-28T07:02:44.810Z",
  "byResultType": [
    { "resultType": "certificate-host-mismatch", "failedSessions": 9, "reporters": ["Google Inc."] },
    { "resultType": "validation-failure", "failedSessions": 3, "reporters": ["Microsoft Corporation"] }
  ],
  "byMxHost": [
    { "receivingMxHostname": "mx1.pellowyn-dental.example", "failedSessions": 12, "resultTypes": ["certificate-host-mismatch", "validation-failure"] }
  ],
  "byPolicyType": [
    { "policyType": "sts", "successfulSessions": 41210, "failedSessions": 12 }
  ],
  "record": {
    "status": "ours",
    "host": "_smtp._tls.pellowyn-dental.example",
    "current": "v=TLSRPTv1; rua=mailto:rua+3f9a1c7e5b2d@reports.dmarcharbor.example",
    "suggested": "v=TLSRPTv1; rua=mailto:rua+3f9a1c7e5b2d@reports.dmarcharbor.example"
  }
}
```

- `failureSharePercent` is failed sessions as a percentage of all sessions, or `null` when there were none.
- `byMxHost` lists at most 20 mail servers, the most failures first.
- `record.status` is `ours` (the published record sends reports here), `other` (a valid record that does not), `missing`, `invalid` or `unknown` (no completed scan has read it). `suggested` is the record to publish.

Errors: 401, 402 `FEATURE_NOT_IN_PLAN` (`reports.tlsrpt`), 404, 429.

## Alerts

Alerts are raised by the alert rules set up in the app (for example "more than 250 DMARC failures a day"). Each alert is `open` until someone acknowledges it or the condition clears.

### GET /api/v1/alerts

Alerts in the workspace, newest first.

- Scope `read`. Needs `alerts.email`. Paged.

| Parameter | In | Notes |
|---|---|---|
| `state` | query | `open`, `acknowledged` or `resolved`. Leave out for all |
| `domain` | query | A domain id or slug. A domain outside the workspace answers 404 |
| `limit` | query | 1 to 200, default 50 |
| `cursor` | query | `nextCursor` from the previous page |

```bash
curl -sS "https://app.dmarcharbor.example/api/v1/alerts?state=open" \
  -H "Authorization: Bearer $DMH_API_KEY"
```

**Response 200**

```json
{
  "alerts": [
    {
      "id": "cmhb5k2r7000etd5w8x1q4n9c",
      "state": "open",
      "ruleId": "cmh8v3n6d0002tz4x5m9q1k7b",
      "ruleName": "DMARC failures above 250 a day",
      "domain": { "id": "cmh2k5a1q000bwq8z4v6n1s8f", "name": "corriwick-cafe.example", "slug": "corriwick-cafe-example-p7d2m4" },
      "metric": "FAILURE_COUNT",
      "operator": "GREATER_THAN",
      "observedValue": 412,
      "threshold": 250,
      "windowMinutes": 1440,
      "summary": "Observed 412 messages that failed DMARC in the last 1440 minutes, above the 250 message threshold.",
      "reminderLevel": 1,
      "triggeredAt": "2026-11-28T08:15:00.000Z",
      "acknowledgedAt": null,
      "resolvedAt": null
    }
  ],
  "nextCursor": null
}
```

- `state` is `open` (needs a person), `acknowledged` or `resolved` (the condition cleared before anyone acknowledged it).
- `metric` is `FAILURE_COUNT`, `FAILURE_RATE`, `SOURCE_IP_VOLUME`, `FORENSIC_FAILURES`, `REPORT_SILENCE` or `NEW_UNAUTHENTICATED_SOURCE`. `operator` is `GREATER_THAN`, `GREATER_THAN_OR_EQUAL` or `LESS_THAN`.
- `reminderLevel` rises each time the reminder ladder chases an alert nobody has acknowledged.
- Deleting a rule in the app removes its alerts as well.

Errors: 400 (bad `state`, `limit` or `cursor`), 401, 402 (`alerts.email`), 404 (`domain`), 429.

### POST /api/v1/alerts/{alertId}/acknowledge

Acknowledges an open alert on behalf of the key. The audit trail records the key, not a person, and when the workspace's PSA connection has a ticket for the alert, the ticket gets a note saying it was acknowledged through the API.

- Scope `write`. Needs `alerts.email`. No body. Does not read `Idempotency-Key`.

| Parameter | In | Notes |
|---|---|---|
| `alertId` | path | The alert's id, from the list or from the `alert.triggered` webhook (`alertEventId`) |

```bash
curl -sS -X POST https://app.dmarcharbor.example/api/v1/alerts/cmhb5k2r7000etd5w8x1q4n9c/acknowledge \
  -H "Authorization: Bearer $DMH_API_KEY"
```

**Response 200**

```json
{
  "alert": {
    "id": "cmhb5k2r7000etd5w8x1q4n9c",
    "state": "acknowledged",
    "ruleId": "cmh8v3n6d0002tz4x5m9q1k7b",
    "ruleName": "DMARC failures above 250 a day",
    "domain": { "id": "cmh2k5a1q000bwq8z4v6n1s8f", "name": "corriwick-cafe.example", "slug": "corriwick-cafe-example-p7d2m4" },
    "metric": "FAILURE_COUNT",
    "operator": "GREATER_THAN",
    "observedValue": 412,
    "threshold": 250,
    "windowMinutes": 1440,
    "summary": "Observed 412 messages that failed DMARC in the last 1440 minutes, above the 250 message threshold.",
    "reminderLevel": 1,
    "triggeredAt": "2026-11-28T08:15:00.000Z",
    "acknowledgedAt": "2026-11-28T08:41:37.902Z",
    "resolvedAt": null
  }
}
```

Errors: 401, 402, 403, 404, 409 `CONFLICT` ("That alert has already been acknowledged or resolved."), 429. Treat the 409 as done: somebody, or an earlier retry of yours, got there first.

## DNS changes

Each scan compares the domain's records with the previous completed scan and records every meaningful difference as a DNS change: a DMARC policy that weakened, an SPF record that changed, a DKIM selector that disappeared.

### GET /api/v1/dns-changes

DNS changes across the workspace, newest first.

- Scope `read`. Paged, at most 100 a page.

| Parameter | In | Notes |
|---|---|---|
| `domain` | query | A domain id or slug. A domain outside the workspace answers 404 |
| `severity` | query | `INFO`, `WARNING`, `CRITICAL`, or several separated by commas: `?severity=WARNING,CRITICAL`. Do not repeat the parameter |
| `acknowledged` | query | `true` or `false` |
| `limit` | query | 1 to 200, default 50; more than 100 returns 100 |
| `cursor` | query | `nextCursor` from the previous page |

```bash
curl -sS "https://app.dmarcharbor.example/api/v1/dns-changes?severity=WARNING,CRITICAL&acknowledged=false" \
  -H "Authorization: Bearer $DMH_API_KEY"
```

**Response 200**

```json
{
  "changes": [
    {
      "id": "cmhb3q8a4000gtd5w2v7k9m1x",
      "kind": "DMARC_POLICY",
      "severity": "CRITICAL",
      "code": "dmarc_policy_weakened",
      "summary": "The DMARC policy weakened from p=quarantine to p=none.",
      "detectedAt": "2026-11-28T03:12:09.000Z",
      "scanId": "cmhb3q7n2000ftd5w1x8k4m6z",
      "acknowledgedAt": null,
      "acknowledgedBy": null
    }
  ],
  "nextCursor": null
}
```

- `kind` is `DMARC_RECORD`, `DMARC_POLICY`, `DMARC_RUA`, `SPF_RECORD`, `SPF_LOOKUPS`, `SPF_ALL`, `DKIM_SELECTOR`, `MX`, `MTA_STS`, `TLS_RPT` or `BIMI`.
- `code` names the change exactly, for example `dmarc_record_removed`, `dmarc_rua_ours_removed`, `spf_record_changed`, `dkim_selector_removed` or `mta_sts_mode_weakened`. Key automation on `code`, and show `summary` to people.
- `acknowledgedBy` is the name of the person who acknowledged it in the app, and `null` when it is not acknowledged or was acknowledged through the API.
- The rows do not carry the domain. Filter with `?domain=`, or match `scanId` to the domain's scan list.

Errors: 400 (bad `severity`, `acknowledged`, `limit` or `cursor`), 401, 402, 404 (`domain`), 429.

### POST /api/v1/dns-changes/{changeId}/acknowledge

Marks a DNS change as seen, on behalf of the key. The audit trail records the key. When the workspace's PSA connection filed a ticket for the change, the ticket gets a note, and it closes once every change on it is acknowledged.

- Scope `write`. No body. Does not read `Idempotency-Key`, and does not need it: acknowledging a change that is already acknowledged changes nothing and returns it again with 200.

| Parameter | In | Notes |
|---|---|---|
| `changeId` | path | The change's id, from the list or from the `dns.changed` webhook (`changes[].id`) |

```bash
curl -sS -X POST https://app.dmarcharbor.example/api/v1/dns-changes/cmhb3q8a4000gtd5w2v7k9m1x/acknowledge \
  -H "Authorization: Bearer $DMH_API_KEY"
```

**Response 200**

```json
{
  "change": {
    "id": "cmhb3q8a4000gtd5w2v7k9m1x",
    "kind": "DMARC_POLICY",
    "severity": "CRITICAL",
    "code": "dmarc_policy_weakened",
    "summary": "The DMARC policy weakened from p=quarantine to p=none.",
    "detectedAt": "2026-11-28T03:12:09.000Z",
    "scanId": "cmhb3q7n2000ftd5w1x8k4m6z",
    "acknowledgedAt": "2026-11-28T09:02:15.441Z",
    "acknowledgedBy": null
  }
}
```

Errors: 401, 402, 403, 404, 429.

## Usage for billing

### GET /api/v1/usage

What each client used in one complete calendar month (UTC), for billing your clients. One row per client, including clients with nothing to show, sorted by name, plus totals. The same figures as the CSV export in the app.

- Scope `read`. Needs `reports.usageExport`.

| Parameter | In | Notes |
|---|---|---|
| `month` | query | `YYYY-MM`, one of the last 12 complete months. Defaults to the last complete month |

```bash
curl -sS "https://app.dmarcharbor.example/api/v1/usage?month=2026-11" \
  -H "Authorization: Bearer $DMH_API_KEY"
```

**Response 200**

```json
{
  "period": {
    "key": "2026-11",
    "label": "November 2026",
    "start": "2026-11-01T00:00:00.000Z",
    "end": "2026-12-01T00:00:00.000Z"
  },
  "generatedAt": "2026-12-03T06:00:04.118Z",
  "clients": [
    {
      "clientId": "cmh2k4x7p0007wq8z2c6j1r4h",
      "clientName": "Corriwick Café",
      "clientSlug": "corriwick-cafe",
      "domains": 1,
      "verifiedDomains": 1,
      "activeDomains": 1,
      "reports": 214,
      "messages": 9182,
      "dmarcPassMessages": 8770,
      "dmarcPassPercent": 95.5,
      "forensicReports": 0,
      "alertsOpened": 2
    },
    {
      "clientId": "cmh2k4x7p0003wq8z5t1v9a6e",
      "clientName": "Pellowyn Dental",
      "clientSlug": "pellowyn-dental",
      "domains": 2,
      "verifiedDomains": 1,
      "activeDomains": 2,
      "reports": 388,
      "messages": 61405,
      "dmarcPassMessages": 61154,
      "dmarcPassPercent": 99.6,
      "forensicReports": 3,
      "alertsOpened": 0
    }
  ],
  "totals": {
    "domains": 3,
    "verifiedDomains": 2,
    "activeDomains": 3,
    "reports": 602,
    "messages": 70587,
    "dmarcPassMessages": 69924,
    "dmarcPassPercent": 99.1,
    "forensicReports": 3,
    "alertsOpened": 2
  }
}
```

- `domains` and `verifiedDomains` count domains that existed, and were verified, by the end of the month.
- `activeDomains` counts domains that received a report for the month or were added in it.
- `reports` and `messages` count aggregate reports by the month their reporting period begins in, the same rule as the monthly client report. `dmarcPassPercent` has one decimal place and is `null` when there were no messages.
- `period.end` is exclusive: the month runs from `start` up to, not including, `end`.

Errors: 400 `INVALID_PERIOD` (not `YYYY-MM`), 400 `PERIOD_NOT_COMPLETE` (this month or later), 400 `PERIOD_TOO_OLD` (more than 12 complete months ago), 401, 402 (`reports.usageExport`), 429.

## Webhooks

Webhooks run the other way from the API. You register an https address once, and the service posts a signed JSON event to it when something happens: a domain verifies, an alert opens, a DNS change is recorded. Your system only receives. Polling the API still works, and webhooks mean you do not have to.

Webhooks are included from Fairway. Owners and admins manage them.

### Registering an endpoint

Endpoints are managed in the app under Settings, Webhooks, in Add an endpoint:

1. Give it a name after the system it feeds, for example "HaloPSA production".
2. Enter the URL. It must be public https. Local, loopback and private addresses are refused, and the check is repeated on every delivery against the address the name resolves to. Redirects are not followed, so register the final URL.
3. Choose the events under Send it when. `domain.verified` and `alert.triggered` are chosen by default; the others are off because they can be frequent.
4. Choose Add endpoint and copy the signing secret it shows. It is shown once and stored encrypted. Put it in your receiver's secret store.

![Settings, Webhooks: no endpoint yet, the Add an endpoint form with its event choices, and the headers to check a signature against](/docs-media/webhooks.png "Settings, Webhooks before any endpoint is added. The right-hand column lists the headers your receiver checks. Sample data.")

Send a test event posts a test `domain.verified` event to every endpoint subscribed to `domain.verified`. Check the delivery log for the result.

The secret cannot be changed in place. To rotate it, add a second endpoint with the same URL, let your receiver accept both secrets, then remove the old endpoint.

The webhook settings use the app's own routes, which are not part of the API contract. Manage endpoints in the app rather than by script.

### What a delivery looks like

Each delivery is an HTTPS `POST` with a JSON body and these headers:

```http
POST /hooks/dmarc HTTP/1.1
Host: halopsa.wistholm-it.example
Content-Type: application/json
User-Agent: DMARC-Harbor-Webhook/1
x-dmarcharbor-event: domain.verified
x-dmarcharbor-delivery: cmhb9n3x6000jtd5w4r8k2p7m
x-dmarcharbor-attempt: 1
x-dmarcharbor-timestamp: 1795856573
x-dmarcharbor-signature: sha256=5b0e2f4c1a9d8e7f6a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f
```

```json
{
  "id": "evt_Wf3kQ9xLm2Ab",
  "type": "domain.verified",
  "createdAt": "2026-11-28T09:02:53.118Z",
  "data": {
    "domainId": "cmh2k5a1q000bwq8z4v6n1s8f",
    "domainName": "corriwick-cafe.example",
    "clientId": "cmh2k4x7p0007wq8z2c6j1r4h",
    "verifiedAt": "2026-11-28T09:02:53.118Z",
    "source": "background",
    "method": "txt"
  }
}
```

- `id` identifies the event. It is the same on every attempt, every replay and every endpoint that receives it, so use it to ignore duplicates.
- `x-dmarcharbor-delivery` identifies one event sent to one endpoint, and is the id shown in the delivery log. `x-dmarcharbor-attempt` counts from 1.
- `x-dmarcharbor-timestamp` is when this attempt was signed, in Unix seconds. Each attempt is signed afresh, so the signature differs between attempts of the same event.
- The payload says what happened and which ids to fetch. It never carries report contents or personal data; read detail from the API when you need it.
- Events can arrive out of order and more than once. Deliveries go out in batches every 30 seconds.

### Verifying the signature

The signature is an HMAC-SHA256 of the timestamp, a full stop and the raw request body, keyed with the endpoint's signing secret (the secret as text, exactly as it was shown), written as `sha256=` and lowercase hex.

```text
x-dmarcharbor-signature = "sha256=" + hex(HMAC-SHA256(secret, timestamp + "." + rawBody))
```

Check three things before acting on a delivery: the signature matches, compared in constant time; the timestamp is within five minutes of your clock; and you have not already handled the event `id`. Compute the HMAC over the raw bytes you received. Parsing the JSON and serialising it again changes the bytes, and the signature will not match.

Node.js, with Express:

```javascript
import crypto from 'node:crypto';
import express from 'express';

const app = express();
const secret = process.env.DMH_WEBHOOK_SECRET; // the signing secret, as shown once

// express.raw keeps the body as the exact bytes that were signed.
app.post('/hooks/dmarc', express.raw({ type: 'application/json' }), (req, res) => {
  const timestamp = req.get('x-dmarcharbor-timestamp') ?? '';
  const signature = req.get('x-dmarcharbor-signature') ?? '';
  const body = req.body.toString('utf8');

  // Refuse anything signed more than five minutes ago, so a captured request cannot be replayed.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!timestamp || !Number.isFinite(age) || age > 300) return res.status(400).end();

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).end();

  const event = JSON.parse(body);
  // Acknowledge first, then do the work: the sender waits at most 10 seconds.
  res.status(204).end();
  handleEvent(event); // your code: skip it if event.id was already handled
});

app.listen(8080);
```

Python, with Flask:

```python
import hashlib
import hmac
import os
import time

from flask import Flask, abort, request

app = Flask(__name__)
SECRET = os.environ["DMH_WEBHOOK_SECRET"].encode("utf-8")  # the signing secret, as shown once


@app.post("/hooks/dmarc")
def receive():
    timestamp = request.headers.get("x-dmarcharbor-timestamp", "")
    signature = request.headers.get("x-dmarcharbor-signature", "")
    body = request.get_data()  # the raw bytes, exactly as signed

    # Refuse anything signed more than five minutes ago.
    try:
        age = abs(time.time() - int(timestamp))
    except ValueError:
        abort(400)
    if age > 300:
        abort(400)

    signed = timestamp.encode("utf-8") + b"." + body
    expected = "sha256=" + hmac.new(SECRET, signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        abort(401)

    event = request.get_json()
    handle_event(event)  # your code: skip it if event["id"] was already handled
    return "", 204
```

### Events

| Event | Sent when | Chosen by default |
|---|---|---|
| `domain.verified` | A domain's ownership is proved, on the change to verified only | Yes |
| `alert.triggered` | An alert opens | Yes |
| `report.received` | An aggregate DMARC report is stored for the first time | No |
| `entitlement.exceeded` | Something in the app is refused because a plan limit is full | No |
| `dns.changed` | A scan records one or more DNS changes | No |
| `policy.changed` | A scan records a change to the DMARC policy tags | No |
| `forensic.received` | A forensic (failure) report is stored for the first time | No |
| `tlsrpt.received` | A TLS-RPT report is stored for the first time | No |

Each event below shows its `data`; the envelope (`id`, `type`, `createdAt`) is the same for all of them.

### `domain.verified`

Sent once, when a domain becomes verified, whichever check proved it: the background re-check, the app or `POST /domains/{domainId}/verify`. A re-check of a domain that is already verified sends nothing.

```json
{
  "domainId": "cmh2k5a1q000bwq8z4v6n1s8f",
  "domainName": "corriwick-cafe.example",
  "clientId": "cmh2k4x7p0007wq8z2c6j1r4h",
  "verifiedAt": "2026-11-28T09:02:53.118Z",
  "source": "background",
  "method": "txt"
}
```

`method` is `txt` or `report_address`, as in [verify](#post-api-v1-domains-domainid-verify). `source` is currently always `background`, whichever check found the record.

The test event from Send a test event has this `data`, and needs no action:

```json
{
  "test": true,
  "domainId": "test",
  "domainName": "example.com",
  "message": "This is a test delivery from DMARC Harbor. No action is required."
}
```

### `alert.triggered`

Sent when an alert opens. Reminders for an open alert do not send it again.

```json
{
  "alertEventId": "cmhb5k2r7000etd5w8x1q4n9c",
  "ruleId": "cmh8v3n6d0002tz4x5m9q1k7b",
  "ruleName": "DMARC failures above 250 a day",
  "domainId": "cmh2k5a1q000bwq8z4v6n1s8f",
  "domainName": "corriwick-cafe.example",
  "metric": "FAILURE_COUNT",
  "observedValue": 412,
  "threshold": 250,
  "summary": "Observed 412 messages that failed DMARC in the last 1440 minutes, above the 250 message threshold.",
  "triggeredAt": "2026-11-28T08:15:00.000Z"
}
```

`alertEventId` is the `alertId` for [acknowledging the alert](#post-api-v1-alerts-alertid-acknowledge).

### `report.received`

Sent the first time an aggregate report is stored. The same report arriving again, by mail or by another route, sends nothing.

```json
{
  "reportId": "cmhb2w8f5000ctd5w3k7m1q9x",
  "domainId": "cmh2k5a1q0009wq8z7m3b8k2d",
  "domainName": "pellowyn-dental.example",
  "reportType": "AGGREGATE",
  "recordCount": 3,
  "receivedAt": "2026-11-28T06:14:22.530Z"
}
```

### `entitlement.exceeded`

Sent when someone in the app tries to add a client or a domain and the plan has no room. Rows refused by the API's own imports are reported in `planLimitRejections` instead and do not send this event.

```json
{
  "quota": "activeDomain",
  "label": "active domains",
  "used": 80,
  "limit": 80,
  "plan": "HARBOR",
  "planLabel": "Harbor",
  "upgradeTo": "ADMIRALTY",
  "occurredAt": "2026-11-28T11:20:31.004Z"
}
```

`quota` is `client` or `activeDomain`. `upgradeTo` is the next plan up, or `null`.

### `dns.changed`

Sent after a scan, scheduled or started by hand, that recorded at least one DNS change. One event per scan, listing every change.

```json
{
  "domainId": "cmh2k5a1q0009wq8z7m3b8k2d",
  "domainName": "pellowyn-dental.example",
  "scanId": "cmhb3q7n2000ftd5w1x8k4m6z",
  "previousScanId": "cmhaz9w4e0009td5w7k1n3q8v",
  "trigger": "SCHEDULED",
  "changes": [
    {
      "id": "cmhb3q8a4000gtd5w2v7k9m1x",
      "kind": "DMARC_POLICY",
      "severity": "CRITICAL",
      "code": "dmarc_policy_weakened",
      "summary": "The DMARC policy weakened from p=quarantine to p=none."
    }
  ]
}
```

Each `changes[].id` is a `changeId` for [acknowledging the change](#post-api-v1-dns-changes-changeid-acknowledge).

### `policy.changed`

Sent beside `dns.changed` when the scan's changes include the DMARC policy, with the tags before and after.

```json
{
  "domainId": "cmh2k5a1q0009wq8z7m3b8k2d",
  "domainName": "pellowyn-dental.example",
  "scanId": "cmhb3q7n2000ftd5w1x8k4m6z",
  "from": { "p": "quarantine", "sp": null, "np": null, "testing": false },
  "to": { "p": "none", "sp": null, "np": null, "testing": false },
  "direction": "weakened"
}
```

`direction` is `weakened`, `strengthened` or `changed`, judged across `p`, `sp` and `np` together.

### `forensic.received`

Sent the first time a forensic report is stored. It carries no addresses, subjects or message content.

```json
{
  "forensicId": "cmhb6p1d3000itd5w5k8x2n4q",
  "domainId": "cmh2k5a1q0009wq8z7m3b8k2d",
  "domainName": "pellowyn-dental.example",
  "feedbackType": "auth-failure",
  "arrivedAt": "2026-11-28T07:55:12.000Z",
  "receivedAt": "2026-11-28T07:58:40.613Z"
}
```

### `tlsrpt.received`

Sent the first time a TLS-RPT report is stored.

```json
{
  "reportId": "cmhb6v8k2000ktd5w1m4x7q3n",
  "domainId": "cmh2k5a1q0009wq8z7m3b8k2d",
  "domainName": "pellowyn-dental.example",
  "organizationName": "Google Inc.",
  "successfulSessions": 712,
  "failedSessions": 0,
  "receivedAt": "2026-11-28T07:02:44.810Z"
}
```

### Retries, suspension and the delivery log

Answer with any 2xx status within 10 seconds to accept a delivery. Anything else is a failure: another status, a redirect, a refused connection or no answer in time. Only the first 64 KB of your answer is read, and its content does not matter.

A failed delivery is tried again, five attempts in all:

| Attempt | When |
|---|---|
| 1 | Within about 30 seconds of the event |
| 2 | 1 minute after attempt 1 failed |
| 3 | 5 minutes after attempt 2 |
| 4 | 30 minutes after attempt 3 |
| 5 | 2 hours after attempt 4, then it is marked gave up |

A delivery that gave up is not lost for good. Once it is more than 24 hours old, it is queued for another full round of five attempts, as long as its endpoint is not suspended.

Suspension protects both sides from an endpoint that is down for days. Each endpoint counts failed attempts, and any success resets the count. At 20 failed attempts in a row the endpoint is suspended:

- Deliveries already waiting for it are held.
- New events are not queued for it at all while it is suspended. They are not sent later, so catch up from the API once it is back, for example with `GET /alerts?state=open` and `GET /dns-changes?acknowledged=false`.
- About 30 hours after the suspension began, if it has held deliveries, the service releases them as a trial. If they go through the endpoint is back; if they fail it is suspended again sooner.
- Resume the endpoint in Settings, Webhooks to end a suspension at once. Its held deliveries then show Send again in the delivery log.

Pausing an endpoint in Settings, Webhooks stops new events being queued for it. Deliveries already queued before the pause can still be sent. Pausing and removing work on every plan; after a downgrade below Fairway no new events are queued for any endpoint.

The delivery log, under What was sent in Settings, Webhooks, lists the last fifty deliveries with the event, the endpoint, the outcome, the number of tries, and what your system answered (the HTTP status and the error). Send again queues a delivery once more from its first attempt, signed with a new timestamp, so you can recover what failed while your receiver was down.

## Recipes

Short, complete patterns for the jobs MSPs automate first. They use the example host and fictional data; replace both.

### Onboard a new client from a PSA ticket

A new-client ticket in your PSA creates the client and its domains, publishes the ownership records, and closes itself when the domains verify.

1. Create the client with the ticket number as the `Idempotency-Key`, so a retried automation run cannot create it twice:

```bash
curl -sS -X POST https://app.dmarcharbor.example/api/v1/clients \
  -H "Authorization: Bearer $DMH_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: halo-ticket-48213" \
  -d '{"name":"Pellowyn Dental","slug":"pellowyn-dental","domains":["pellowyn-dental.example"]}'
```

2. Store `clientId` and each `domainId` on the ticket. Publish a TXT record at each `verificationHost` with `verificationValue` as its text, through your DNS automation or by sending the values to whoever runs the client's DNS.
3. Do not poll. Pending domains are re-checked about once an hour, and the `domain.verified` webhook fires when each one passes. When it arrives, find the ticket by `domainId` and close it, or move it to the next step. If someone is waiting on the phone, call [verify](#post-api-v1-domains-domainid-verify) once.
4. If the create answers 402 `PLAN_LIMIT_REACHED`, put the ticket on hold with the message: it says which limit is full. If it answers 409 `CONFLICT`, the client or domain already exists; look it up with `GET /clients`.
5. Once verified, publish the client's DMARC record from the domain's page in the app (by hand, through a Cloudflare connection, or as a hosted record). The API does not generate DMARC records.

For a spreadsheet of many clients, send `POST /clients/bulk` in batches of about 100 rows, each with its own `Idempotency-Key`, and handle `failures` and `planLimitRejections` row by row.

### Sync posture into your PSA every night

A nightly job walks every domain and writes its posture onto the matching PSA asset or configuration item: verification state, published policy, score, and what blocks the next step.

```python
import os
import time

import requests  # pip install requests

BASE = "https://app.dmarcharbor.example/api/v1"
session = requests.Session()
session.headers["Authorization"] = f"Bearer {os.environ['DMH_API_KEY']}"


def get(path, **params):
    """GET with the one retry rule the API needs: on 429, wait for Retry-After."""
    while True:
        response = session.get(f"{BASE}{path}", params=params, timeout=30)
        if response.status_code == 429:
            time.sleep(int(response.headers.get("Retry-After", "60")))
            continue
        response.raise_for_status()
        return response.json()


def every_domain():
    cursor = None
    while True:
        page = get("/domains", limit=200, **({"cursor": cursor} if cursor else {}))
        yield from page["domains"]
        cursor = page["nextCursor"]
        if cursor is None:
            return


for domain in every_domain():
    posture = {
        "client": domain["client"]["name"],
        "domain": domain["name"],
        "verified": domain["status"] == "VERIFIED",
        "policy": domain["dmarcPolicy"],
        "score": domain["score"],
        "blockers": [],
    }
    if domain["status"] == "VERIFIED" and domain["dmarcPolicy"] != "reject":
        readiness = get(f"/domains/{domain['id']}/policy-readiness")
        posture["next_step_ready"] = readiness["ready"]
        posture["blockers"] = readiness["blockers"]
    update_psa_asset(posture)  # your PSA's own API
```

- A read-only key is enough. Two calls per domain stay well inside the default 300 a minute for a few hundred domains, and the 429 rule covers a larger book.
- Key the PSA record on the domain `id`, not its name: the id never changes.
- Add `GET /dns-changes?acknowledged=false&severity=WARNING,CRITICAL` to the same job to list what changed since yesterday and still needs a look.
- When the PSA says a domain belongs to a different company, call [move](#post-api-v1-domains-domainid-move) with that client's id (this needs a `write` key). It answers `moved: false` when nothing needed to change, so the job can send it for every domain.

### Acknowledge alerts and DNS changes from a ticket

When a technician picks up a ticket for an alert or a DNS change, the PSA tells the app, so the reminder ladder stops chasing and the app's view matches the ticket.

1. Subscribe an endpoint to `alert.triggered` and `dns.changed`. Open a ticket from each event, and store `alertEventId`, or each `changes[].id`, on it.
2. When the ticket is assigned or set to In progress, have the PSA's automation call:

```bash
# An alert: 200 with the alert, or 409 if it was already acknowledged or resolved.
curl -sS -X POST https://app.dmarcharbor.example/api/v1/alerts/cmhb5k2r7000etd5w8x1q4n9c/acknowledge \
  -H "Authorization: Bearer $DMH_API_KEY"

# A DNS change: 200 with the change, also when it was already acknowledged.
curl -sS -X POST https://app.dmarcharbor.example/api/v1/dns-changes/cmhb3q8a4000gtd5w2v7k9m1x/acknowledge \
  -H "Authorization: Bearer $DMH_API_KEY"
```

3. Treat a 409 on an alert as success. Treat a 404 as "not ours to touch": the alert or change is not in this workspace.

The key needs `write`. If the workspace also uses the native PSA connection, these acknowledgements add a note to its ticket saying they came through the API, so do not run both for the same events or each ticket gets two trails.

### Monthly usage for billing

On the third day of each month, pull the previous month and bill each client from it. Reports for the last days of a month arrive during the first days of the next, so the third gives them time to land.

```python
import csv
import os
import sys

import requests

BASE = "https://app.dmarcharbor.example/api/v1"
headers = {"Authorization": f"Bearer {os.environ['DMH_API_KEY']}"}

# Leave month out to get the last complete month.
usage = requests.get(f"{BASE}/usage", headers=headers, params={"month": "2026-11"}, timeout=60)
usage.raise_for_status()
data = usage.json()

writer = csv.writer(sys.stdout)
writer.writerow(["month", "client_id", "client", "active_domains", "messages", "dmarc_pass_percent"])
for row in data["clients"]:
    writer.writerow([
        data["period"]["key"],
        row["clientId"],
        row["clientName"],
        row["activeDomains"],
        row["messages"],
        "" if row["dmarcPassPercent"] is None else row["dmarcPassPercent"],
    ])
```

- Map `clientId` to the PSA company once and keep the mapping; names can change.
- Bill on `activeDomains` for a per-domain price, or on `domains` for everything under management.
- A month can be fetched again for 12 months. The figures stay the same unless reports for it arrived late, or clients or domains were removed since.

## Known issues

These are places where the API does not yet do what it should. They are listed so you can work around them, and this page changes when they are fixed.

- **`mxRecords` is always empty.** `GET /domains/{domain}` returns `mxRecords: []` for every domain. Read MX hosts from DNS yourself until it is fixed.
- **A new scan reports `changeCount: 0`.** The answer to `POST /domains/{domain}/scans` always has `changeCount: 0`. The scan list and `GET /dns-changes` have the real count and the changes.
- **A client id outside the workspace answers 402.** `POST /domains` and `POST /domains/bulk` answer 402 `FEATURE_NOT_IN_PLAN` with the message "That client is not in this workspace." when `clientId` is wrong, instead of 404. Check the message, not only the code.
- **A domain held by another workspace fails a client import.** In `POST /clients` and `POST /clients/bulk`, a domain that another workspace already monitors fails the whole request with 500, and nothing in it is created. Create such clients without that domain, then add it with `POST /domains`, which reports the conflict for that row only.
- **An oversized body answers 413 with code `INTERNAL`.** Branch on the 413 status and split the request.
- **The scan limit's 429 is plain text.** Branch on the status and `Retry-After`.

## Not part of the contract

The app itself talks to routes under `/api` that are not under `/api/v1`: settings, webhooks, API keys, PSA connections, hosted DNS and the rest. They change whenever the app changes, without notice, and integrations must not call them. Everything an integration may rely on is on this page.

A machine-readable OpenAPI description of the service is served at `/api/docs/openapi.json` for code generators. It describes the app's own routes too; only the paths under `/v1` are the contract described here.

Things the API does not do today, which are done in the app: removing or renaming clients and domains, generating or publishing DMARC records, hosted DNS, forensic report detail, report rows and sending addresses, alert rules, and managing webhooks and API keys.
