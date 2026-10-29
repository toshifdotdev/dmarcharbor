# Frequently asked questions

**Effective date:** `[EFFECTIVE DATE]`
**Legal entity:** `[YOUR LEGAL ENTITY NAME]`, trading as DMARC Harbor

For a step-by-step setup, read the Setup guide. This page answers the questions
people ask most, one feature at a time, and says which plan each one starts on.

---

## What it does

**What is DMARC?**
DMARC is an email authentication standard (RFC 9989, which replaced RFC 7489). It
lets a domain publish a policy telling receiving mail servers what to do with mail
that claims to come from that domain but fails the checks. Gmail, Yahoo and
Microsoft require it for bulk senders.

**What does DMARC Harbor actually do?**
It reads the aggregate and forensic reports that receiving mail servers send about
your clients' domains, and turns them into a verdict per domain, the senders behind
it, and evidence you can hand to a client. It watches each domain's DNS, warns you
when something changes or breaks, and helps you move each domain safely from
`p=none` to `p=reject`.

**Does it send email as my clients, or change their DNS?**
It never sends mail as anyone. It changes DNS only when you ask it to, in one of
two ways: through a Cloudflare connection you add, or by serving a record you have
delegated to it with a CNAME (hosted DMARC, SPF, BIMI and MTA-STS). Every change
is recorded and can be put back. Without either, it only reads.

**Where do the reports come from?**
From the mail servers that receive your clients' mail. Each domain publishes a
reporting address we give you; those servers send reports there, usually once a
day, and we read them.

**Is it only for MSPs?**
No. It is built for agencies and managed service providers, because they look after
many client domains, but a single domain owner can use it too.

## Getting set up

**How do I start?**
Create an account, create a workspace, add a client, then add its domains. Each
domain needs two DNS records: a TXT record that proves you manage it, and a DMARC
record with our reporting address. We give you both, word for word. The Setup guide
walks through it.

**How do I prove I manage a domain?**
Publish the TXT record shown on the domain's setup page at
`_dmarc-harbor-verification.<domain>`. A DMARC record that already sends reports to
this client's own reporting address also counts as proof. Re-check from the setup
page once DNS has updated.

**How long until I see data?**
Reports usually arrive within 24 to 48 hours of the DMARC record going live. Until
the first one arrives, a domain reads as unmeasured, never as healthy.

**What if the domain already has a DMARC record?**
Keep it. Add our reporting address alongside the existing one so nothing is lost.
If the domain already reports to another DMARC service, the switch kit builds the
record that sends reports to both while you move over.

**What if I use Cloudflare?**
Add a Cloudflare connection with an API token that can edit DNS. You can then
preview and publish the verification record and the DMARC record from the domain's
page, and put a previous value back. Starts on Fairway.

**My domain publishes reports to a web address instead of a mailbox. Do you collect those?**
Not yet. A `rua=https://` address means reports go to a web endpoint we do not read,
so there is no report data for that domain until it also lists our mailbox address.
Add our address beside it rather than replacing it.

**Can I add many domains at once?**
Yes. Paste or import a list on a client's page, or use the API's bulk endpoints.
Each row is checked on its own, so one bad line does not stop the rest.

**Can I check a domain without an account?**
Yes. Enter it on the home page. That is one lookup at one moment, not monitoring.

## Plans and billing

**What are the plans?**
Mooring (free), Fairway, Harbor and Admiralty, plus Fleet, which has Harbor's
features and is priced per active domain, with a price per domain that falls as the
count grows. The pricing page has the current prices, every limit and a full
comparison.

**What starts on which plan?**
- **Every plan, free included:** aggregate reports, the audit trail, data export and
  erasure, DNS monitoring and change history, Gmail, Yahoo and Microsoft sender
  requirement checks, registration expiry dates, sender review, the switch kit and
  two-step verification.
- **Fairway:** alerts by email, Slack and Teams (including DNS change and expiry
  warnings), spoofing alerts, sender owners, webhooks, publishing through
  Cloudflare, hosted DMARC, forensic reports with recipients unnamed, share links,
  TLS reports and 10 prospect reports a month.
- **Harbor:** the client portal and client approvals, named forensic evidence,
  scheduled digests, the API, PSA ticketing, managed SPF, hosted BIMI and
  MTA-STS, the Trust Center, compliance packs and monthly client reports, report
  collection from your own mailbox, your logo and colours on everything clients
  see, and 50 prospect reports a month.
- **Admiralty:** client pages on your own domain, single sign-on, an unlimited
  team, and 200 prospect reports a month.
- **Fleet:** everything in Harbor, including your logo and colours, for more
  domains, with an unlimited team.

**How many people can join a workspace?**
Mooring 2, Fairway 5, Harbor 25, and Admiralty and Fleet have no limit. These are
your own staff. A client's people sign in to the client portal instead, and they do
not use a seat.

**How is Fleet priced?**
Per active domain a month, in bands:

| Active domains | Per domain | Smallest bill in the band |
|---|---|---|
| Up to 200 | $2.00 (₹169) | $150 (₹12,675), covering up to 75 |
| 201 to 500 | $1.25 (₹106) | $400 (₹33,920), covering up to 320 |
| 501 to 2,000 | $1.00 (₹85) | $625 (₹53,125), covering up to 625 |
| 2,001 to 5,000 | $0.75 (₹64) | $2,000 (₹1,70,688), covering up to 2,667 |

Adding a domain never lowers the bill. The count is measured before each month
starts, with no proration. From 200 to 300 domains Admiralty costs about the same
and adds your own domain and single sign-on.

**How are the limits counted?**
Clients and active domains are counted across every workspace your account owns,
so a client book cannot be split across workspaces to fit a smaller plan. Team
members are counted per workspace, and open invitations count as seats. A domain
is active while it has sent a report within the plan's window, and for its first 14
days; a parked domain that has stopped reporting stops counting.

**What happens when I reach a limit?**
Adding more is refused, and the message says which limit you reached and which plan
raises it. Nothing is deleted and nothing stops working.

**Can I downgrade below what I am using?**
No. If you have more clients, domains or members than the smaller plan allows, we
tell you exactly how many over you are on each limit, and you can remove the excess
or stay where you are.

**What happens to features when I downgrade?**
Nothing is deleted, and upgrading again brings everything back as it was.

- Hosted records keep being served so your clients' mail keeps working, but you
  can no longer change them. We email the workspace owners once, listing the
  records to move back to your own DNS.
- Alert rules, digests and a report mailbox are kept but stop running. A kept
  mailbox can still be disconnected, which deletes its stored password.
- Share links and Trust Center pages answer as withdrawn while the plan does not
  include them, and work again after an upgrade.
- Single sign-on stops admitting new people at once; existing members get 30 days.
- Your logo and colours stop showing below Harbor, and the stored logo is removed.
  A custom domain kept from Admiralty stops being used; you can remove it.
  See "What happens to single sign-on if we leave Admiralty?" below.

**When does a plan change take effect?**
It depends on how you pay. Paying in rupees through Razorpay, a change up or down
takes effect at the end of the period you have paid for, with no mid-period charge.
Paying in dollars through Paddle, the change applies straight away and Paddle
prorates the difference. The billing page says which applies to you before you
confirm.

**Do I get a refund?**
There is a 14-day money-back guarantee on your first payment. It applies once per
customer. After that, refunds are considered case by case, for example for a
double charge or a fault on our side. See the Refund Policy.

**Which currency am I charged in?**
Rupees are processed by Razorpay and US dollars by Paddle. You choose before your
first payment, and it is fixed after that, because changing it would mean moving a
live subscription between two payment processors.

**What happens if my payment fails?**
We tell you and retry. You keep full access for 7 days after the paid period ends,
and we tell you the exact date. If it is still unpaid then, the workspace moves to
the free plan with all its data kept; upgrading brings everything back.

**Can I pay by invoice or bank transfer?**
Not at present. Pay by card through Razorpay or Paddle.

**Is there a free trial of the paid plans?**
No. Mooring is free with no card and no time limit, and the 14-day money-back
guarantee covers your first payment.

## Monitoring and alerts

**What do the five words on a domain mean?**
Each domain reads as exactly one of pass, block, unverified, stale or unmeasured,
chosen from report data. A domain that has never reported is never called passing,
and one that stopped reporting says so.

**What are senders, and what should I do with them?**
Senders are the services and servers that sent mail as a domain. Mark each one as
yours or not yours. A failing sender that is yours keeps blocking enforcement until
its SPF or DKIM is fixed, because enforcing would stop its real mail. A failing
sender you mark as not yours stops blocking, because stopping it is the point. On
Fairway and above you can name an owner for each sender, so the person who fixes it
is recorded.

**How do alerts work?**
Create alert rules per domain, for example on failure rate, volume from one source,
report silence or new unauthenticated sources. Alerts go by email, and to Slack or
Microsoft Teams if you connect a channel. Unacknowledged alerts are repeated and
then rolled up to owners and admins, respecting each person's quiet hours. Starts
on Fairway; spoofing alerts also start on Fairway.

**Does it watch DNS?**
Yes, on every plan. Each verified domain is re-read about once a day, and every
change to its DMARC, SPF, DKIM, MX, MTA-STS, TLS-RPT or BIMI records is kept in its
history, where you can acknowledge it. Warnings about changes are sent on Fairway
and above.

**Does it warn me before a domain registration expires?**
The expiry date is read from the registry over RDAP and shown on every plan.
Warnings at 30, 14, 7 and 1 days, and on the day, are sent on Fairway and above.
Some country-code registries publish no expiry date; the domain says so.

**Does it check the Gmail, Yahoo and Microsoft sender rules?**
Yes, on every plan. Each domain's page shows which of the bulk sender requirements
it meets and what is missing.

**Can alerts open tickets in my PSA?**
Yes, in HaloPSA, ConnectWise Manage or Autotask. Map each client to a PSA company,
and alerts open, update and close tickets there. Starts on Harbor.

**Can I get events in my own systems?**
Yes. Webhooks send signed events: `domain.verified`, `alert.triggered`,
`dns.changed`, `policy.changed`, `report.received`, `forensic.received`,
`tlsrpt.received` and `entitlement.exceeded`. Each delivery is logged and can be
replayed. Starts on Fairway.

## Moving to enforcement

**How do I know a domain is ready for quarantine or reject?**
Each domain's page shows its readiness: days and messages observed, pass rate,
failing and new senders, open alerts, and for reject a month at quarantine and DKIM
on nearly all mail. It names what still blocks the next step.

**What is hosted DMARC?**
You point `_dmarc` at us once with a CNAME, and change the policy from the domain's
page after that, with no DNS edit and every change kept and reversible. You can
stop hosting at any time; we keep serving until your own record is back. Starts on
Fairway.

**Can my client approve enforcement?**
Yes. Ask for the next step from the domain's page and every portal contact at that
client is emailed under your brand. They read what changes, the risk to their own
mail and the evidence, then approve or decline in the portal, and the decision is
recorded under their account. A hosted record changes the moment they approve;
otherwise you get the exact record to publish. Requests expire after 14 days.
Starts on Harbor.

**What about SPF's 10-lookup limit?**
Managed SPF publishes a flattened SPF record from the services you list and keeps it
current, so the domain stays under the limit. Starts on Harbor.

**Do you support BIMI and MTA-STS?**
Yes. Hosted BIMI serves your logo and certificate; hosted MTA-STS serves the policy
file and record for you. TLS reports (TLS-RPT) show delivery problems to your mail
servers. Hosted BIMI and MTA-STS start on Harbor; TLS reports on Fairway.

## Clients, sharing and branding

**Can my clients see their own data?**
Yes. The client portal gives a contact you invite read-only access to their own
verified domains, senders and monthly reports, and lets them answer approval
requests. They sign in with their email address, or with Google or Microsoft. It
never shows forensic data. Starts on Harbor.

**Can I share a report without giving portal access?**
Yes. A share link opens a read-only report for one domain in a browser, with no
sign-in. It expires after the number of days you choose, up to a year, and you can
revoke it at any time. Starts on Fairway.

**What are digests and monthly reports?**
A digest is a scheduled email, weekly or monthly, summarising a domain for the
addresses you choose. A monthly report is a PDF per client for each complete month,
downloadable by you and by the client in the portal. Both start on Harbor.

**What is a compliance pack?**
A signed PDF, per client, stating what data is held, who can read it, how long it is
kept and which sub-processors are used. It carries a SHA-256 fingerprint that anyone
can check on the verify page. Starts on Harbor.

**What is a Trust Center?**
A public page per client, at an address that cannot be guessed, showing the same
facts as the compliance pack: data held, access, retention, where it is stored,
sub-processors and completed erasures. You can forward it to an auditor. Starts on
Harbor.

**What is a prospect report?**
A plain-language email security check of a company you want to win, shared as a
link under your workspace's name. It is a snapshot taken when you create it, so
opening the link never scans anyone's DNS. Fairway includes 10 a month, Harbor 50,
Admiralty and Fleet 200.

**Can I use my own brand?**
From Harbor, your logo and colours appear in the portal, on reports and on the
emails clients receive. On Admiralty the portal and other client pages can also
run on your own domain, so DMARC Harbor's address never appears.

## Team and security

**Can colleagues work in the same workspace?**
Yes. Invite them by email as an admin, analyst or viewer. Only the owner can change
the plan; analysts cannot see named forensic recipients; viewers cannot see forensic
data at all. Each plan has a team size, and open invitations count against it.

**How do you sign me in?**
Email and password, or Google or Microsoft. Two-step verification with an
authenticator app is available on every plan, and a workspace can require it of
everyone. You can see and end every session from your account.

**Do you support single sign-on?**
Yes, on Admiralty. SAML and OIDC are both supported, with just-in-time provisioning
limited to the email domains you allow.

**What happens to single sign-on if we leave Admiralty?**
Nobody new can join through your connection. Existing members can keep signing in
through it for 30 days. After that they sign in with their email address and
password. Anyone who joined through single sign-on and never set a password can
create one with Forgot password on the sign-in page.

**What about forensic reports and personal data?**
Forensic reports can contain recipient addresses and subject lines. We collect them
only when you switch that on for a domain, and store recipient addresses as one-way
pseudonyms by default. On Harbor and above you can keep named recipients for a
domain when you have a lawful basis; they are encrypted and deleted after 7 days on
every plan.

**How long do you keep my data?**
The same on every plan: aggregate reports for 400 days, forensic reports for 30
days, and named recipient details for 7 days. The audit trail is kept until a
deletion request removes it. Your Trust Center and compliance packs state these
figures, so the answer is never a guess.

**How do I export or delete my data?**
From the workspace settings, on every plan. An export covers everything we hold for
the workspace except passwords and session tokens, and says what it left out.
Erasure shows exactly what will be deleted first and then waits 7 days, so a mistake
can be cancelled.

**How are my credentials stored?**
Encrypted at rest: Cloudflare tokens, PSA credentials, mailbox passwords, and the
Slack and Teams addresses alerts post to. We never show a stored secret in full
again.

**Where is my data stored?**
`[DATA_RESIDENCY_REGION]`. See the Sub-processors notice for who processes it.

**Is there an API?**
Yes, on Harbor and above. The workspace owner creates API keys with read or write
scope. The reference is published at `/api/docs/openapi.json`, and changes are
listed in the API changelog.

## Support

**How do I get help?**
Email `[SUPPORT EMAIL]`. See the Complaint Policy for targets and escalation.

**Is there a service level agreement?**
Not unless one is agreed in writing.

**How do I report a security issue?**
Email `[SECURITY EMAIL]`. We do not run a bug bounty programme at present, and we will
say so here if that changes.

---

## Still stuck

Email `[SUPPORT EMAIL]`. If something here is wrong or out of date, tell us and we
will fix it.
