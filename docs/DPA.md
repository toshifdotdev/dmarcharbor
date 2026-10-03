# Data Processing Agreement

**Between:** DMARC Harbor ("the Processor")
**And:** the customer identified in the Order Form or account ("the Controller")

This agreement governs the Processing of Personal Data by DMARC Harbor on behalf
of a Controller. It is required by **Article 28 of the UK and EU General Data
Protection Regulation** where the Controller is established in the UK or EEA, and
is written to satisfy equivalent requirements elsewhere.

Where this agreement conflicts with the Terms of Service, this agreement prevails
for the subject matter of Processing.

> **Reviewer note:** this is a technically accurate draft built from what the
> product actually does. It requires legal review before signature. Items marked
> **TBD** must be completed first.

---

## 1. Definitions

Capitalised terms not defined here have the meanings given in the GDPR, including
**Controller**, **Processor**, **Personal Data**, **Data Subject**, **Processing**,
**Supervisory Authority**, and **Sub-processor**.

**"DMARC Data"** means the authentication report data, forensic report data and
account data described in section 3.

**"Aggregated Evidence"** means DMARC authentication results: source IP addresses,
message counts, SPF and DKIM pass or fail outcomes, and dispositions. Aggregated
Evidence contains no recipient data.

## 2. Subject matter, nature, purpose and duration

| Item | Detail |
|---|---|
| **Subject matter** | Monitoring of email authentication for domains the Controller adds to the service |
| **Nature of Processing** | Collection, storage, organisation, retrieval, consultation, analysis, pseudonymisation, encryption, retention, restriction and erasure |
| **Purpose** | Providing the DMARC monitoring, alerting and reporting service the Controller subscribes to |
| **Duration** | For the term of the subscription, plus the retention periods in section 6 |

## 3. Categories of Personal Data and Data Subjects

### Data we process

| Category | Notes |
|---|---|
| **Recipient identifiers** | Email addresses of the Controller's client's mail recipients. **Stored as one-way HMAC pseudonyms by default** |
| **Named recipients** | Real email addresses and message subject lines. **Only when a domain owner explicitly enables this, after confirming a legal basis.** Encrypted at rest with AES-256-GCM. Retained 7 days |
| **Message subject lines** | Only in the named mode above |
| **Envelope sender addresses** | From DMARC report metadata |
| **Personnel data** | Name, email address, IP address, device and user agent of the Controller's own staff who sign in |
| **Billing identifiers** | Plan, billing period and provider customer reference |

### Data Subjects

- The Controller's client's staff and customers whose email addresses appear in
  DMARC forensic reports
- The Controller's own staff, as workspace members

### Special category data

**None is intentionally processed.** The Controller should not configure the
service in a way that causes special category data to be placed in email subject
lines. Where a subject line contains such data and named mode is enabled, that
data is encrypted at rest and expires after 7 days.

## 4. The Controller's obligations

The Controller:

1. Instructs the Processor only to Process DMARC Data as described in this
   agreement and the documentation
2. Has a lawful basis for collecting the domains and enabling any named data
3. Provides the notices required by Articles 13 and 14 to its own Data Subjects
4. Determines whether named forensic mode is enabled, and for which domains
5. Complies with its own obligations as Controller, including responding to Data
   Subject requests

## 5. The Processor's obligations

### 5.1 Documented instructions

The Processor Processes DMARC Data only on the Controller's documented
instructions, including as set out in this agreement, the Terms of Service and
the product documentation.

### 5.2 Confidentiality

The Processor ensures that persons authorised to Process DMARC Data are bound by
a duty of confidentiality and have received appropriate training.

### 5.3 Security of processing

The Processor implements and maintains the technical and organisational measures
in section 7, appropriate to the risk.

### 5.4 Sub-processors

The Processor may engage the Sub-processors listed in `docs/SUB-PROCESSORS.md`.
The Processor will give **30 days' notice** before adding or replacing a
Sub-processor. The Controller may object in writing within that period, and the
parties will work in good faith to resolve the objection.

### 5.5 Data Subject requests

The Processor will assist the Controller by appropriate technical and organisational
measures, insofar as it is able, to respond to requests under Articles 12 to 22.

Where a Data Subject contacts the Processor directly, the Processor will forward
the request to the Controller without undue delay and will not respond except at
the Controller's instruction or where required by law.

### 5.6 Breach notification

The Processor will notify the Controller without undue delay, and in any event
within **72 hours** of becoming aware, of a Personal Data Breach affecting the
Controller's DMARC Data.

The notification will include, where available: the nature of the breach, the
categories and approximate number of Data Subjects and records affected, the
likely consequences, and the measures taken or proposed. Information not yet
available will be provided without undue delay as it becomes available.

### 5.7 DPIA assistance

The Processor will reasonably assist the Controller with a Data Protection Impact
Assessment under Article 35, taking into account the nature of the Processing and
the information available to it.

### 5.8 Records and audits

The Processor will make available to the Controller all information reasonably
necessary to demonstrate compliance with Article 28, including a description of the
technical and organisational measures in section 7, and the current audit trail
for the Controller's workspace on request.

The Controller may audit the Processor once in any twelve month period on 30 days'
written notice, and additionally following a Personal Data Breach. Audits shall
protect the confidentiality of other customers and shall be conducted remotely
unless on-site audit is required by law.

### 5.9 Deletion and return

On termination of the subscription, the Processor will, at the Controller's
choice, delete or return the Controller's DMARC Data, and delete existing copies,
within **90 days**, except as retained under section 6.

## 6. Retention

The following periods apply. Retention depends partly on the Controller's plan, so
the Controller's actual periods are shown in its product.

| Data | Period |
|---|---|
| Aggregated Evidence | 400 days on the default plan, up to 10 years on the highest |
| Forensic report evidence | 30 days by default |
| **Named** recipient identifiers and subject lines | **7 days, on every plan** |
| Audit trail | 30 days to 10 years, by plan |
| Invoices and payment records | As long as tax law requires, typically 6 to 8 years |
| Erasure certificates | 3 years |

On termination of the subscription, the Processor will delete Aggregated Evidence
and forensic data. Aggregated Evidence may be retained in a de-identified form for
statistical purposes, provided it cannot be attributed to the Controller or any
Data Subject.

## 7. Security measures

The measures below are those implemented in the service. This list is a
description, not a guarantee, and is not a substitute for a compliance audit.

### Access control
- Four workspace roles with explicit permissions; permissions are additive
  statements, not a single flag
- Only the workspace **owner** can change the plan; only owner and admin can
  read billing
- Least privilege on data access: internal roles cannot identify named recipients
  without the separate `forensic:identify` permission
- Payment administration is separated from reporting administration

### Authentication and session security
- Passwords hashed by the authentication library
- Email verification required before sign-in
- Session duration 7 days, refreshed at most once per day
- Device level session control: a user can list every signed-in device and revoke
  one, all others, or all sessions including the current one
- **Changing a password always revokes all other sessions**, enforced
  server-side, so a stolen password cannot survive a password change
- Reusing the current password as the new password is rejected
- Security sensitive actions are rate limited

### Data protection
- **Recipient data is pseudonymised by default** using one-way HMAC. The stored
  value is not the email address and cannot be reversed
- **Named data is encrypted at rest** with AES-256-GCM, and requires a confirmed
  legal basis
- Named personal data expires after 7 days regardless of plan
- Named data can be permanently destroyed on request, which deletes the encrypted
  values while retaining the surrounding evidence record
- Credentials are never included in a data export. Passwords, session tokens and
  OAuth tokens are never serialised, because they are the means of authorisation
  rather than the Controller's data

### Transport and integrity
- Report ingestion is authenticated with an HMAC signature over a timestamp and
  the raw message, compared in constant time, and rejected outside a 300 second
  window
- Secrets are read from the environment and are never written to storage or logs
- The service refuses to start in production with development secrets or
  development email configuration

### Logging and monitoring
- Append-only audit trail recording privileged actions: role changes, plan changes,
  data purges, session revocations, report share creation and revocation,
  entitlement overrides, data exports and data erasures
- Audit entries record actor, time, target and request identifier
- Anomalous authentication, such as a new sending source failing both SPF and DKIM,
  raises an alert
- Alerts support acknowledgement, escalation, owner roll-up and quiet hours

### Tenant isolation
- Every query is scoped by workspace identifier
- A data inventory is the single source of truth for which data belongs to which
  workspace, client or domain, used by both the export and the erasure feature so
  the two cannot disagree
- Cross-workspace access is covered by tests

### Availability and recovery
- Liveness and readiness probes separate process health from dependency health
- **TBD**: the production hosting platform, backup schedule and recovery time
  objective are not yet finalised, and must be stated here before signature

### Secure development
- Type checking, linting and a test suite of over 300 automated tests gate every
  change
- Dependency vulnerabilities are audited and currently report none

## 8. Breach handling

On becoming aware of a Personal Data Breach, the Processor will:

1. Contain it and preserve evidence
2. Assess the risk to Data Subjects
3. Notify the Controller within 72 hours
4. Record the incident, including incidents with no customer impact
5. Provide a post-incident summary on request

## 9. Deletion requests from Data Subjects

Where a Data Subject of the Controller's client requests deletion, the Controller
should use the service's erasure feature where it can act directly, or contact the
Processor. The Processor will act on a documented instruction from the Controller.

**Aggregate and forensic evidence is retained where it contains no personal data.**
Where a request is declined on that basis, the response explains that the retained
data is authentication evidence and contains no recipient data.

## 10. Term

This agreement continues while the Controller has an active subscription and
survives termination for the retention periods in section 6, and for the audit
records that demonstrate compliance.

## 11. Governing law

**TBD**: to be completed. Note that processing governed by UK or EU GDPR must
name a law and forum capable of satisfying those regulations.

---

## Items that must be completed before signature

1. Hosting platform, region, and the resulting transfer mechanism
2. Payment processor
3. Backup schedule and recovery objectives
4. Governing law and jurisdiction
5. Company legal name and registered address
6. Legal review
