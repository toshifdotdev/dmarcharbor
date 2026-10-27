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

`report.received`, `dns.changed`, `policy.changed` and `forensic.received` are
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
