# DMARC Harbor: Privacy Policy

**Status:** draft for legal review. Effective date to be set at launch.
**Applies to:** the DMARC Harbor API and the dmarcharbor.com service.

> **Reviewer note:** this document describes what the software actually does. The
> technical statements are derived from the running configuration, not from
> marketing. Items marked **TBD** are decisions not yet made: they must be
> filled in before this is published, and a privacy policy that guesses is worse
> than no privacy policy.

---

## 1. Who we are

DMARC Harbor is a DMARC monitoring service for agencies and managed service
providers. Customers connect their client domains, and DMARC Harbor collects and
analyses the email authentication reports that mailbox providers send about
those domains.

DMARC Harbor is operated as a **data processor** for the personal data it holds
on behalf of a customer's client. The terms of that processing are set out in the
Data Processing Agreement.

## 2. What we collect

### Account data
Name, email address, and password. If you sign in with Google or Microsoft we
receive the identifier and email address that provider returns.

### Workspace data
Client names, domain names, and the roles your team members hold.

### DMARC report data
Mailbox providers such as Google, Microsoft and Yahoo send DMARC reports. For
each sending source in those reports we store the source IP address, the number
of messages, whether SPF and DKIM passed, and the disposition.

Aggregate DMARC reports contain no recipient data. This is a property of the
DMARC standard itself.

### Forensic report data
Forensic (RUF) reports are per message and **do** contain recipient data.

By default we store recipient addresses as **one-way HMAC pseudonyms**. A
pseudonym is a hash that cannot be reversed, so the stored value is not the
email address and cannot be turned back into one.

**Real recipient email addresses and subject lines are stored only when a domain
owner explicitly turns this on**, which requires confirming a legal basis. When
enabled, those values are encrypted with AES-256-GCM before storage.

### Payment data
**TBD**: we do not store card numbers. Payment is handled by a payment
processor acting as the merchant of record. See the Sub-processors list.

## 3. Why we collect it

| Purpose | Lawful basis |
|---|---|
| Providing the DMARC monitoring service you pay for | Contract |
| Sending service alerts, digests and share links | Contract |
| Verifying domain ownership by DNS | Legitimate interest: prevents someone monitoring a domain they do not own |
| Detecting and investigating spoofing | Legitimate interest |
| Storing forensic evidence you requested | Consent, per domain, with a legal basis confirmed |
| Billing and accounting records | Legal obligation |

## 4. What we do not do

- **We do not sell your data.** No exceptions.
- **We do not use your DMARC data to train anything.**
- **We do not send your reports to any third party** for their own purposes.
- **We do not read your email.** We only receive the authentication reports that mailbox providers generate about your domains.
- **We do not modify your DNS.** DMARC Harbor only reads published records. You make every DNS change.

## 5. How long we keep things

| Data | Retention |
|---|---|
| Aggregate DMARC reports and per source rows | **400 days** (default, configurable per plan) |
| Forensic report evidence | **30 days** (default, configurable per plan) |
| **Named** recipient addresses and subject lines, when enabled | **7 days** |
| Audit trail | 30 days to 10 years, depending on plan |
| Sessions | Until sign out, revocation, or expiry (7 days default) |
| Export job records | 7 days |
| Erasure certificates | 3 years |
| Invoices and payment records | **As long as tax law requires**: typically 6 to 8 years |

**Named personal data expires in 7 days regardless of plan.** No plan extends it.
This is deliberately much shorter than evidence retention.

## 6. Who can see your data

Only members of your workspace, according to their role:

| Role | Can see |
|---|---|
| Owner | Everything in the workspace, including billing and plan |
| Admin | Everything except billing changes |
| Analyst | Domains, reports, forensic evidence, alerts. **Cannot** identify named recipients |
| Viewer | Read only. No forensic access |

**Tenant isolation:** every query is scoped to a single workspace. We do not
offer a combined view across workspaces to any user, including our own staff.

## 7. Sub-processors

We use a small number of third parties. The current list is in
`docs/SUB-PROCESSORS.md`. We will give **30 days' notice** before adding or
replacing a sub-processor.

## 8. Your rights

You have the right to:

- **Access** your data: export it as JSON or CSV, at any time, on any plan including free
- **Erase** your data: delete a client, a domain, or the whole workspace
- **Correct** inaccurate data
- **Object** to processing based on legitimate interest
- **Export** it in a portable format
- **Withdraw consent** for named forensic data, which immediately returns you to pseudonyms
- **Complain** to your data protection authority

**Access and erasure are free on every plan, including the free plan.** They are
statutory rights, not features.

To exercise any of these, use the export and erasure endpoints in the product, or
contact us. We respond within 30 days.

### How erasure works

When you request erasure, we show you exactly what will be deleted, anonymised
or kept, and why, before anything happens. The request then waits **seven days**
so it can be cancelled if it was a mistake.

| What happens | Detail |
|---|---|
| **Deleted in full** | Named recipient addresses and subject lines, and everything encrypted alongside them |
| **Anonymised** | The audit trail keeps the action, time and target, but the person, IP address and request id are cleared. Subscription records keep the plan and period, but provider identifiers are cleared |
| **Kept** | DMARC authentication evidence: source IPs, pass and fail results, message counts. This contains no recipient data |
| **Proof** | A certificate is written before deletion, containing no personal data, and survives it |

## 9. International transfers

**TBD**: our hosting region is not yet finalised. This section must state the
region and the transfer mechanism, such as Standard Contractual Clauses, before
publication.

## 10. Security

We pseudonymise recipient data by default, encrypt named data at rest, keep an
append-only audit trail of privileged actions, and never export credentials.
A plain-language summary is in `docs/SECURITY.md`.

## 11. Children

DMARC Harbor is a business service and is not intended for anyone under 16.

## 12. Changes

We will notify you by email **30 days** before a material change to this policy.

## 13. Contact

Privacy questions: privacy@dmarcharbor.com

---

## Items that must be completed before publication

1. Hosting region and international transfer mechanism
2. Payment processor, once selected
3. Effective date and company legal name
4. Supervisory authority, if one applies
5. Legal review
