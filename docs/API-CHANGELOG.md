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

`300 requests per minute` per key, with a standard `429` and
`Retry-After` header.

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

### Events

| Event | Fires when | Opt in |
|---|---|---|
| `domain.verified` | DNS ownership proof confirmed, on the transition only | Default on |
| `alert.triggered` | An alert rule crossed its threshold | Default on |
| `report.received` | A DMARC report arrived | **Opt in** |
| `entitlement.exceeded` | A plan limit was hit | Default on |

`report.received` is opt in because a large agency receives hundreds a day.
Subscribing to events you will ignore trains people to ignore the endpoint, so
it is left off by default.

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

## Planned, not yet available

| Planned | Notes |
|---|---|
| `GET /api/v1/domains/{id}/senders` | Per sending service breakdown |
| `GET /api/v1/domains/{id}/insights` | Trends, spikes, disposition |
| `GET /api/v1/domains/{id}/dmarc-record` | Generated record and `pct` guidance |
| `GET /api/v1/domains/{id}/policy-readiness` | Blockers and staged policy advice |
| `GET /api/v1/reports`, `/senders`, `/alerts` | Read endpoints for the remaining data |
| `GET /api/v1/me` | Plan and entitlements, so an integration can check its own limits |
| Cursor pagination | Read endpoints currently return the full set, capped by the plan |

---

## Integration notes for a PSA

The intended onboarding flow:

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
