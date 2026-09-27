# DMARC Harbor — SOC 2 Type II readiness

This is the working document for the compliance track. It is **not** a claim of
compliance. A SOC 2 report can only be issued by an independent licensed audit
firm after observing controls in operation over a period of time (typically
3–12 months). Nothing in this repository can substitute for that.

## Why this is time critical

SOC 2 has a long lead time that no amount of engineering can compress. The
observation window cannot be skipped, the policy set has to exist before the
auditor tests against it, and Type II additionally requires evidence that
controls *operated* consistently, not merely that they exist.

Every month of delay is a month of enterprise and mid-market agency deals that
cannot be closed, because the buyer's procurement checklist requires the report.

## The honest cost

- **Auditor engagement:** the single largest cost, typically several thousand
  dollars for a Type I and materially more for Type II.
- **Internal time:** an owner must own this. It is a process project, not a
  backlog item, and it competes with product work for the same hours.
- **Tooling:** access management, logging retention and evidence collection.

Recommendation: obtain quotes from two firms and compare. Expect the engagement
to start with a readiness gap assessment, not the audit itself.

## Trust Services Criteria in scope

Recommended for a B2B SaaS handling customer data:

| Criterion | Why it matters here |
|---|---|
| **CC6.1 – Logical access** | Who can reach customer data, and how that is proven |
| **CC6.2 – Registration and authorisation** | New users, role assignment, invitations |
| **CC6.3 – Access modification and revocation** | Role changes, session revocation, offboarding |
| **CC6.6 – Boundary protection** | Network and environment separation |
| **CC6.7 – Transmission and disposal** | Encryption in transit and at rest, secure deletion |
| **CC7.2 – Monitoring** | Detecting anomalies in the running service |
| **CC7.3 – Incident response** | Responding to security events |
| **CC8.1 – Change management** | Every change to the running system is reviewed |
| **A1.2 – Availability** | The service stays up and is recoverable |
| **P1–P8 – Privacy** | Personal data handling, retention, and the data subject rights |

**Privacy is already the strongest part of this product.** The forensic data
design (pseudonymisation by default, opt-in named retention, legal basis
confirmation, shorter retention for personal data, permanent purge) maps almost
directly onto P1–P8. This is a genuine differentiator in a SOC 2 conversation
and should be presented as such.

## Controls already implemented in this repository

| Control | Evidence in code |
|---|---|
| Authentication and session management | Better Auth with email verification, session expiry, rotation |
| Device level session control | `services/session.service.ts`, revocation of one, other, or all |
| Forced revocation on credential change | `auth/auth.config.ts` before hook forces `revokeOtherSessions` |
| Rejection of unchanged password on change | `auth/auth.config.ts` before hook |
| Role based access control | `auth/permissions.ts`, four roles with explicit statements |
| Least privilege on billing | Only `owner` holds `billing: update` |
| Separation of internal and external roles | Forensic identity requires the `forensic:identify` permission |
| Personal data minimisation | Forensic recipients pseudonymised by HMAC unless explicitly enabled |
| Encryption of personal data at rest | AES-256-GCM for named forensic identities |
| Legal basis confirmation before enabling PII | `confirmLegalBasis` required on the identity toggle |
| Shorter retention for personal data | Separate `FORENSIC_PII_RETENTION_DAYS` |
| Permanent destruction of personal data | `confirmNamePurge` destroys encrypted names, retains machine evidence |
| Append only audit trail | `services/audit.service.ts`, written for security relevant actions |
| Per tenant data isolation | Every query scoped by `organizationId` |
| Webhook authenticity | HMAC with timestamp window, compared with `timingSafeEqual` |
| Secrets never persisted or logged | Secrets read from environment, never written to storage |
| Rate limiting on security sensitive actions | Session revocation, report ingestion, public shares |
| Verification out of band | Domain ownership proven by DNS TXT before any data is accepted |
| Plan level quotas and feature gates | `services/entitlements/`, 402 responses with upgrade path |
| Statutory rights never paywalled | `data.export` and `data.erase` forced on for every plan |

## Gaps to close before an audit

| Gap | Why | Effort |
|---|---|---|
| No production deployment | An auditor cannot observe controls in a non production environment | Blocked on infrastructure decision |
| No production database | Same | Blocked |
| No documented information security policy set | CC1.2, CC2.1, CC3.2 expect written policies | Documentation, not code |
| No incident response plan | CC7.3 | Documentation |
| No business continuity or disaster recovery plan | A1.2 | Documentation |
| No access review cadence | CC6.3 expects periodic review, not just enforcement | Process |
| No vendor management policy | Applies once a payment provider is chosen | Process |
| No penetration test | Not strictly required for SOC 2, but expected by buyers | Budget item |
| No formal onboarding and offboarding procedure | CC6.2, CC6.3 | Process |

**Note the shape of this list.** Almost nothing here is code. SOC 2 is mostly
policies, evidence and time. That is precisely why starting early matters, and
precisely why it should not be attempted inside a product sprint.

## Evidence an auditor will ask for

Have these producible before the engagement starts, because retrofitting
evidence under audit pressure is the common failure mode:

- Access control matrix: role to permission to resource, kept in version control
- Quarterly access review records
- Change history for the production configuration
- Log retention policy and the logs themselves
- Encryption configuration evidence
- Incident register, including incidents that were resolved without customer impact
- Vulnerability scan results and remediation records
- Onboarding and offboarding checklists with completed examples
- Backup and restore test results

## Suggested first actions

1. Contact two or three licensed audit firms for a readiness gap assessment.
   Ask explicitly for experience with multi tenant B2B SaaS.
2. Write the information security policy set. This is days of work, not months,
   and it is the prerequisite for everything else.
3. Decide and document the production infrastructure, since an auditor needs
   something to observe.
4. Start collecting access review and change evidence now, even informally, so
   the practice is habitual when the audit begins.
5. Revisit this document each phase and keep the control table honest. A control
   table that overstates coverage is worse than no control table, because the
   auditor will find the gap and it will damage credibility across every other
   claim.
