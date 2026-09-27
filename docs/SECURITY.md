# DMARC Harbor — Security Overview

A plain-language summary for customers, prospects and their security teams. No
legal language, no claim we have not implemented.

---

## The one thing that makes DMARC Harbor different

**We do not store your recipients' real email addresses unless you explicitly ask
us to.**

When a mailbox provider sends a forensic DMARC report, it includes the email
address of everyone who received a message that failed authentication. Almost
every DMARC tool stores that address in plain text.

**We hash it with a one-way HMAC by default.** The stored value looks like
`ps1:7f3a9c2e...`. It cannot be reversed into an email address. It is not your
recipients' personal data, and it is not ours to hold.

If you need the real address — to chase a specific delivery problem, for example —
you switch named mode on for that domain. That switch requires you to confirm a
legal basis, encrypts the values with AES-256-GCM, and **expires them after 7 days
regardless of plan.** No tier of our product extends that.

**You can switch named mode off at any time**, which permanently destroys the
encrypted values. We keep the surrounding evidence — which sender failed, how
many messages, when — because that contains no recipient data.

## Access control

| Role | Domains and reports | Forensic evidence | Identify named recipients | Billing |
|---|---|---|---|---|
| Owner | Yes | Yes | Yes | Read and change plan |
| Admin | Yes | Yes | Yes | Read only |
| Analyst | Yes | Yes | No | No |
| Viewer | Read only | No | No | No |

Permissions are individual statements, not a single flag, so "can view reports"
and "can see who failed" are genuinely separate decisions. Being able to read
reports does not give anyone the ability to see recipient addresses.

**Only the owner can change the plan.** That is deliberately separated from who
can read billing, so a compromised analyst account cannot change what the company
is paying for.

## Sign-in security

- Email must be verified before sign-in
- Sessions last 7 days
- **You can see every device you're signed in on** — device, location, when it
  started — and end any of them
- **You can sign out everything else** in one click, or everything including your
  current device
- **Changing your password always signs out every other device.** This is enforced
  on the server. You cannot turn it off, and a direct API call cannot skip it, so a
  stolen password cannot outlive a password change
- Setting your new password to your old one is rejected

## Tenant isolation

Every single query is scoped to a workspace. There is no combined view across
workspaces available to any user, including our own staff.

We maintain one authoritative inventory of which data belongs to which workspace,
client or domain. **The export feature and the erasure feature both read that same
inventory**, which is what makes it structurally impossible for us to export
something we would not erase, or to fail to erase something we told a customer we
hold.

Cross-workspace access attempts are covered by automated tests.

## Data intake

DMARC reports arrive from mailbox providers. Ingestion is authenticated:

- A shared secret signs the report with an HMAC over a timestamp and the raw
  message
- The signature is compared in **constant time**, so it cannot be guessed by
  timing
- Reports older or newer than a 300 second window are rejected
- Raw email bodies are never stored

Report volume is rate limited, and the service rejects oversized payloads.

## Audit trail

Every privileged action is recorded in an append-only log:

- Role and membership changes
- Plan changes and entitlement overrides
- Forensic data purges and identity toggles
- Report share link creation and revocation
- Session revocations
- Data exports requested, downloaded and revoked
- Data erasures requested, cancelled and completed

Each entry records who, when, what, and a request identifier for correlation with
your infrastructure logs.

**When you erase data, the audit trail is anonymised rather than deleted.** The
action, time and target survive so we can prove the change was controlled; the
person, IP address and request identifier are cleared. Deleting the trail would
leave no evidence the erasure happened.

## What we never export

A data export never includes:

- Passwords
- Session tokens
- OAuth tokens

These are not your data to download — they are *the means by which the download is
authorised*. Exporting them would hand over the ability to impersonate the account.
You still get the device, address and expiry of each session so you can see where
you are signed in.

Where we do withhold something, the export file **tells you what it withheld and
why**, so it can never be mistaken for a complete copy of storage.

## Detection

- **New sending source detection.** Sources first seen in the last seven days are
  flagged, and graded by whether they passed SPF, DKIM, both, or neither. A source
  that passes neither is surfaced as a possible spoofing attempt, because a
  legitimate service normally passes at least one.
- **Anomalous authentication** raises an email alert rather than waiting for
  someone to open a dashboard.
- Alerts support acknowledgement, escalation, owner roll-up, and quiet hours in
  each recipient's timezone.

## Engineering practice

- Type checking, linting and a build step gate every change
- **Over 300 automated tests** covering authorisation, tenant isolation, crypto,
  input limits, and every destructive operation's scope
- Dependency audit currently reports **zero known vulnerabilities**
- The database schema is version controlled with reviewed migrations
- Secrets live in environment configuration, never in source. The service
  **refuses to start in production** with development secrets or a development
  email provider, so a misconfiguration fails closed

## What we have not yet done

Being straight about the gaps, because a security page that only lists strengths
is not worth reading:

| Gap | Status |
|---|---|
| **SOC 2 Type II** | Not started. A report can only be issued by an independent licensed auditor after an observation period |
| **Penetration test** | Not yet commissioned |
| **Hosting platform, backup schedule, recovery objectives** | Not finalised |
| **ISO 27001** | Not started |
| **Payment processor** | Not yet selected |

## Reporting a vulnerability

We would like to hear about security problems.

**TBD** — security contact address and safe disclosure channel to be set before
launch. We will acknowledge reports within 3 business days.

## Documents

| Document | Purpose |
|---|---|
| `docs/PRIVACY-POLICY.md` | What we collect, why, and how long we keep it |
| `docs/DPA.md` | Article 28 Data Processing Agreement |
| `docs/SUB-PROCESSORS.md` | Every third party that touches your data |
| `docs/SOC2-READINESS.md` | Compliance track and the controls already implemented |
