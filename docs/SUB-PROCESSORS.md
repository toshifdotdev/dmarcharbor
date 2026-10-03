# DMARC Harbor: Sub-processors

GDPR Article 28(2) requires us to inform you of the sub-processors we use to
process your data, and to give you notice before adding or replacing one.

**Notice period: 30 days.** If you object in writing within that period we will
work in good faith to resolve it, including discussing alternatives.

**Last updated:** at launch.

---

## Current sub-processors

| Provider | What it does | Data it touches | Region |
|---|---|---|---|
| **Resend** | Transactional and alert email | Your users' email addresses, names, and notification content. Alert content may include domain names, sender sources and counts | **TBD**: confirm before publication |
| **Cloudflare** | Email routing and the report ingress Worker | Raw DMARC report messages in transit only. The Worker forwards them and does not store them | Global edge |
| **Managed PostgreSQL provider** | Primary database | All stored data | **TBD**: hosting not finalised |
| **Google and Microsoft** (optional sign-in) | Federated sign-in | Name, email address, and provider identifier. Only if you enable social sign-in | Provider's region |
| **Payment processor** | Subscription billing | Your company name, billing contact email, plan and amount. **Not your DMARC data** | **TBD**: not yet selected |

## Not a sub-processor

**We do not use third-party analytics, advertising or session-replay services.**

There is no Google Analytics, no advertising pixel, and no third-party tracking of
any kind in the product. Workspace activity is not profiled for marketing.

## Our responsibilities for sub-processors

- We select sub-processors with reference to the technical and organisational
  measures required by the Data Processing Agreement
- We enter written agreements with each sub-processor imposing data protection
  obligations no less protective than those in our DPA
- We flow down the same pseudonymisation and encryption commitments. Resend
  transmits notification email; it does not receive your DMARC report data
- We do not use a sub-processor to process your data for its own purposes
- We will not move your data to a new sub-processor without notice

## Data that no sub-processor receives

| Data | Why not shared |
|---|---|
| Named recipient addresses and subject lines | Access is deliberately narrow. Sub-processors receive no forensic report content |
| Raw DMARC report bodies | Parsed and stored by us; the raw message is not forwarded to a processor for storage |
| Pseudonymised recipient identifiers | Never leave our database |
| Passwords and session tokens | Never transmitted to any third party |

## Before launch

The three **TBD** items are genuine open decisions, not oversights. The privacy
policy and the DPA both reference them, and all three must be resolved before
either document is published or signed.

**Recommendation:** resolving these is part of the domain and hosting decision, so
it should not be done separately.
