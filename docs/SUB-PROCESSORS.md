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
| **Cloudflare** | Email routing and the report ingress Worker; the DNS zone that serves records you delegate to us (hosted DMARC, SPF and BIMI); Cloudflare for SaaS, which serves hosted MTA-STS policy files | Raw DMARC report messages in transit only, which the Worker forwards and does not store. Public DNS values and policy files | Global edge |
| **Amazon Web Services** | Object storage for workspace logos (S3) | The logo files you upload | **TBD**: region set at launch |
| **Managed PostgreSQL provider** | Primary database | All stored data | **TBD**: hosting not finalised |
| **Migadu** | Hosted mailbox that receives aggregate and forensic reports | Inbound report messages, which may contain recipient email addresses | **TBD**: confirm before publication |
| **Razorpay** | Subscription billing in Indian rupees, as payment gateway | Company name, billing contact email, plan and amount. **Not your DMARC data** | India |
| **Paddle** | Subscription billing in US dollars, as merchant of record | Company name, billing contact email, plan and amount. **Not your DMARC data** | Provider's region |
| **Google and Microsoft** (optional sign-in) | Federated sign-in | Name, email address, and provider identifier. Only if you use social sign-in | Provider's region |
| **Anthropic** (only when written answers are enabled for the in-product assistant) | Writes short answers to questions about using the product, from our public documentation | The question as typed, after email addresses, links, IP addresses, domain names and anything shaped like a key are removed, and excerpts of our public documentation. **Nothing is taken from a workspace**: no client, domain, report, sender, member or account data is added, the asker's own included | Provider's region |

## Services you connect

These are not our sub-processors. They are services you choose and connect, under
your own agreement with each provider, and we send them only what you configure:

- **Slack and Microsoft Teams**, for alert messages to a channel you choose
- **HaloPSA, ConnectWise Manage and Autotask**, for tickets about your alerts
- **Your Cloudflare account**, when you add a connection to publish records in your
  own DNS zones
- **Your webhook endpoints**, for the events you subscribe to
- **Your own report mailbox**, when you collect reports from a mailbox you run
- **Your identity provider**, when you set up single sign-on

## Not a sub-processor

**We do not use third-party analytics, advertising or session-replay services.**

There is no Google Analytics, no advertising pixel, and no third-party tracking of
any kind in the product. Workspace activity is not profiled for marketing.

Public lookups are not processing on your behalf: DNS queries, and registration
lookups to each domain's registry over RDAP, send only the domain name.

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
| Named recipient addresses and subject lines | Access is deliberately narrow. Sub-processors receive no forensic report content once it is stored |
| Raw DMARC report bodies | Parsed and stored by us; the raw message is not forwarded to a processor for storage |
| Pseudonymised recipient identifiers | Never leave our database |
| Passwords and session tokens | Never transmitted to any third party |

## Before launch

The **TBD** items are genuine open decisions, not oversights. The privacy policy and
the DPA both reference them, and they must be resolved before either document is
published or signed.

**Recommendation:** resolving these is part of the domain and hosting decision, so
it should not be done separately.
