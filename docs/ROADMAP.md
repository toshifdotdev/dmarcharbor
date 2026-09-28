# DMARC Harbor roadmap

Where the product is, and what is deliberately outstanding. Kept in the repo so
it survives a handover or a lost conversation.

## Shipped

| Phase | Commit | What |
|---|---|---|
| Core DMARC | `bb4e4ff` and earlier | Ingestion, readiness, shares, digests, alerts |
| Session management | `bb4e4ff` | Device list, revocation, rate limits |
| Canary and new senders | `02d48ea` | Rollout stages, spoofing detection |
| Alerts | `a1b0bd6` | Thresholds, escalation, rollups |
| Plan entitlements | `e254c36` | Catalog, quotas, 402s, overrides |
| Data inventory | `1c8a778` | What is held, per client |
| Data export | `f2716c9` | JSON and CSV, free on every plan |
| Data erasure | `88a13c7` | Preview, grace, certificate |
| Public API and webhooks | `7ad50e6` | Keys, bulk onboarding, signed events |
| Client portal | `4140b7d` | Grant based access, no forensic data |
| Re-verification and white label | `cb7b564` | Background checks, branding, host routing |
| Billing | `6105538` | Razorpay and Paddle, dunning, reconciliation |
| Entitlement enforcement | `9b5f2ba` | Six ungated paid features closed |
| Transactional email | `69a3498` | Nine templates, white labelled |
| Tenant isolation suite | `45a845d` | Eighteen cross tenant probes |
| Trust Center | `c2a39c3` | Public per client page, revocable |
| Compliance pack | `65b6ef8` | Signed PDF, published digest |
| Logo storage | `4c12a0d` | S3, no agency URLs rendered |
| IMAP collection and dedup | `ed29d3d` | Shared mailbox, encrypted credentials, report identity |

## Remaining

| Phase | Status | Notes |
|---|---|---|
| **Frontend** | Not started | Next.js. Billing screen, white label settings, portal, trust center, compliance pack download |
| **4. IMAP ingestion and dedup** | Shipped | Mailbox credentials encrypted, poll resumes from the last UID, dedup on report identity |
| **5. SSO** | Not started | SAML and OIDC, JIT provisioning, domain restriction, plus Google login as a separately labelled cheaper option |

## Outstanding decisions

### Data residency and sub processors — revisit after the frontend

**Why this exists:** the Trust Center and the compliance pack both publish a
residency statement, and both currently say *"as configured for the provider
account"*. That was written deliberately rather than guessed at, because no
hosting had been chosen. It is honest, and it is not yet an answer.

Nothing published today is false. It is simply not finished, and a procurement
team cannot use it.

**To resolve:**

1. Name the sub processors and their jurisdictions, rather than the generic
   categories currently listed. Outstanding: object storage for logos, the
   report mailbox, the transactional email provider, and the payment processors.
2. Decide whether EU-only data residency is offered as a feature. Probably not
   at current scale.
3. Replace the placeholder region string once hosting is chosen.

**Note on lawfulness:** a non EU sub processor is not automatically a problem.
Standard Contractual Clauses plus a signed DPA make a transfer lawful, and every
major provider offers them. The gap right now is paperwork and naming, not code.

**Owner action:** pick hosting, then have this answered before selling to an EU
or UK enterprise buyer.

### Payment adapters are unverified

Both the Razorpay and Paddle adapters were written against published
documentation and have not run against a live sandbox. Every unverified point is
marked with a `NOTE: verify against sandbox` comment in the adapter.

The highest risk one is the Razorpay subscription end date bound. A value
outside what the account permits means subscriptions are either rejected or
silently end early, and the second case is the failure this project already had
to fix once.

### Provider migration between Razorpay and Paddle

The two cannot see each other's subscriptions, so moving a customer between them
needs a deliberate migration path. The unique constraint on the provider
subscription identifier is the piece that has to be released first.

## Not planned

- **Proration.** A plan change is scheduled, never charged mid cycle. If a
  customer needs to downgrade and start the cheaper plan immediately, that
  needs a credit for the unused time.
- **Shared Redis.** An in process TTL cache is sufficient until a second
  instance runs.
- **HaloPSA connector.** The public API is the integration. There is no
  connector to build.
