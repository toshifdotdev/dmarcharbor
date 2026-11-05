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
page, and put a previous value back. A workspace can hold up to 5 Cloudflare
connections. Starts on Fairway.

**My domain publishes reports to a web address instead of a mailbox. Do you collect those?**
Not yet. A `rua=https://` address means reports go to a web endpoint we do not read,
so there is no report data for that domain until it also lists our mailbox address.
Add our address beside it rather than replacing it.

**Can I add many domains at once?**
Yes. Paste a list, or import a CSV file, of up to 500 domains on a client's page, or use the
API's bulk endpoints, which take up to 200 clients or 500 domains a request. Each
row is checked on its own, so one bad line does not stop the rest.

**I filed a domain under the wrong client. Can I move it?**
Yes. On the Clients page, choose Move on the domain's row, or open the domain's
setup page and choose Move at the bottom. An owner or admin can move it. Before
anything changes you see what moves with it: reports, scans, alerts, digests,
sender reviews and hosted records all stay attached to the domain. Share links
follow the domain to the new client. Approval requests waiting on the old client's
contacts are withdrawn, because they were asked about their own domain. Monthly
reports already issued stay with the client they were issued for. The DMARC record
in DNS is not changed: if it names the old client's report address, reports keep
arriving, and the confirmation gives the new client's address to publish when you
can. A domain in the middle of a provider switch cannot be moved until the switch
ends. To undo a move, move the domain back.

**Can I rename a client or the workspace?**
Yes. Rename on a client's row in the Clients page changes its name, its short
name (the slug), or both. Its report address, its Trust Center address and its
domains stay the same. The workspace name is in Settings, Workspace; its address
and id stay the same. Owners and admins can rename, and each rename is in the
audit trail with the old and new names.

**Can I deal with many alerts or share links at once?**
Yes. On the Alerts page, Acknowledge all open acknowledges every open alert after
you confirm the count, each with its own audit entry. On a domain's setup page, the
Revoke button above the share links (it says how many are live) withdraws every
live link for that domain at once. A withdrawn link stops working the next time
someone opens it.

**Can I export my client list?**
Yes. Client book CSV on the Clients page downloads every client and domain, one row
per domain, with the ids, report address, ownership state and DMARC policy, ready
for a PSA or CRM import. A client with no domains yet has one row with the domain
columns empty. Any role can download it, and each download is recorded.

**Can I undo a delete?**
No. Deleting a domain, a client or the workspace removes its reports and history
for good, which is why each one first shows what it will delete and asks you to
type the name. To put a domain under another client, move it instead; its history
goes with it.

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
  requirement checks, registration expiry dates, sender review, subdomains seen
  sending that you do not monitor, policy readiness for each step to `p=reject`,
  the switch kit and two-step verification.
- **Fairway:** alerts by email, Slack and Teams (including DNS change and expiry
  warnings), spoofing alerts, sender owners, webhooks, publishing through
  Cloudflare, hosted DMARC, the SPF check for unused includes, forensic reports
  with recipients unnamed, share links, TLS reports and 10 prospect reports a
  month.
- **Harbor:** the client portal and client approvals, named forensic evidence,
  scheduled digests, the API, PSA ticketing, managed SPF, hosted BIMI and
  MTA-STS, the Trust Center, compliance packs and monthly client reports, report
  collection from your own mailbox, your logo, colours and support contact in the
  portal, reports and client emails, the monthly usage export per client, Ask
  (product questions answered in the app from these pages), and 50 prospect
  reports a month.
- **Admiralty:** everything clients open on your own domain, client emails from
  your own address, single sign-on, an unlimited team, and 200 prospect reports a
  month.
- **Fleet:** everything in Harbor, including your logo and colours, for more
  domains, with an unlimited team and 200 prospect reports a month. Your own
  domain and single sign-on stay on Admiralty.

**What are the limits on each plan?**

| Limit | Mooring | Fairway | Harbor | Admiralty | Fleet |
|---|---|---|---|---|---|
| Clients | 1 | 5 | 20 | 75 | 1,000 |
| Active domains | 2 | 20 | 80 | 300 | 5,000 |
| Team members per workspace | 2 | 5 | 25 | No limit | No limit |
| Workspaces per account | 1 | 2 | 3 | 5 | 5 |
| Prospect reports a month | None | 10 | 50 | 200 | 200 |

The next answers say how each limit is counted. Other limits are the same on every
plan: what counts as an active domain, how long data is kept, rate limits, the size
of a bulk import, Cloudflare connections and digest recipients.

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
| 2,001 to 5,000 | $0.75 (₹64) | $2,000.25 (₹1,70,688), covering up to 2,667 |

Adding a domain never lowers the bill. The count is measured before each month
starts, with no proration. From 200 to 300 domains Admiralty costs about the same
and adds your own domain and single sign-on.

**How are the limits counted?**
Clients and active domains are counted across every workspace your account owns,
so a client book cannot be split across workspaces to fit a smaller plan.
Workspaces are counted per account. Team members are counted per workspace, and
open invitations count as seats.

A domain counts as active for its first 14 days, and whenever it has sent a report
in the last 30 days. That is the same on every plan. A parked domain that has
stopped reporting stops counting 30 days after its last report, and starts again
the day a report arrives. On Fleet, this count is also what you are billed for.

**What happens when I reach a limit?**
Adding more is refused, and the message says which limit you reached and which plan
raises it, or to contact us where no plan does. Nothing is deleted and nothing stops
working.

**Can I downgrade below what I am using?**
No. If you have more clients, active domains, team members or workspaces than the
smaller plan allows, we tell you exactly how many over you are on each limit, and
you can remove the excess or stay where you are.

Cancelling is always allowed. When the paid period ends the workspace moves to
Mooring with everything kept, and adding more is refused until you are within
Mooring's limits.

**What happens to features when I downgrade?**
Nothing is deleted, and upgrading again brings everything back as it was.

- Hosted records keep being served so your clients' mail keeps working, but you
  can no longer change them. We email the workspace owners once, listing the
  records to move back to your own DNS.
- Alert rules, digests and a report mailbox are kept but stop running. A kept
  mailbox can still be disconnected, which deletes its stored password.
- Slack and Teams channels and digests can still be paused or removed, but not
  changed or switched back on.
- Share links and Trust Center pages answer as withdrawn while the plan does not
  include them, and work again after an upgrade.
- Single sign-on stops admitting new people at once; existing members get 30 days.
- Your logo and colours stop showing below Harbor, and the stored logo is removed.
  A custom domain kept from Admiralty stops being used, and new client links use
  our address; you can remove it.
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

**Will I find out about subdomains nobody told me about?**
Yes, on every plan. Each domain's Subdomains tab lists the names below it, such as
`news.example.com`, that receivers reported sending mail in the last 90 days and
that you do not monitor, with their volume and pass rate. Monitor a name to add it
to the client as a domain, or dismiss it. A low pass rate there is either a service
nobody set up or someone using a name that looks like the client's.

**How do alerts work?**
Create alert rules per domain, for example on failure rate, volume from one source,
report silence or new unauthenticated sources. Alerts go by email, and to Slack or
Microsoft Teams if you connect a channel. Unacknowledged alerts are repeated and
then rolled up to owners and admins, respecting each person's quiet hours. Starts
on Fairway; spoofing alerts also start on Fairway.

**Does it watch DNS?**
Yes, on every plan. Each verified domain is re-read about once a day, and every
change to its DMARC, SPF, DKIM, MX, MTA-STS, TLS-RPT or BIMI records is kept in its
history. A change marked warning or critical, such as a weaker policy or a removed
record, can be acknowledged there; an informational one, such as a new DKIM
selector, needs nothing. Warnings about changes are sent on Fairway and above.

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

**Can you tell me which SPF includes are no longer used?**
Yes, from Fairway. On a domain's Reporting and setup tab, choose Check SPF sources.
Each include and address range in the SPF record is resolved to the servers it
allows and matched against the servers that actually sent the domain's mail in the
last 90 days. A source with no mail is marked, with the lookups removing it would
free. Nothing is called unused until there are reports on at least 14 days, and an
include that cannot be resolved in advance (for example one using `exists`) is shown
as not checkable rather than unused. On the free plan every scan still counts the
record's lookups and warns when it goes over 10.

**Do you support BIMI and MTA-STS?**
Yes. Hosted BIMI serves your logo and certificate; hosted MTA-STS serves the policy
file and record for you. TLS reports (TLS-RPT) show delivery problems to your mail
servers. Hosted BIMI and MTA-STS start on Harbor. Viewing TLS reports starts on
Fairway; they are collected on every plan, so reports received before an upgrade
appear afterwards.

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
A digest is a scheduled email, weekly or monthly, summarising a domain for up to
20 addresses you choose. A monthly report is a PDF per client for each complete month,
downloadable by you and by the client in the portal. Both start on Harbor.

**What is a compliance pack?**
A PDF, per client, with each domain's email authentication evidence and a statement
of what data is held, who can read it, how long it is kept and which sub-processors
are used. When it is issued its SHA-256 fingerprint is recorded, and anyone holding
a copy can check it on the verify page: a changed copy does not match. The PDF does
not carry a digital signature. Starts on Harbor.

![Settings, Trust Center and evidence packs: the button to issue a pack, how an auditor checks one, and the packs issued so far with their fingerprints](/docs-media/evidence-packs.png "Settings, Trust Center and evidence packs. Every pack issued is listed with its reference and fingerprint; a newer pack marks the older one superseded. Sample data.")

**What is a Trust Center?**
A public page per client, at an address that cannot be guessed and that search
engines are asked not to list. It shows each domain's email authentication as last
checked (DMARC policy, SPF, DKIM, MTA-STS, TLS-RPT and BIMI), the policy history,
how much of the mail is reported, the senders seen and the open findings. It then
states how the data is handled: what is held, who can read it, retention, where it
is stored, sub-processors and completed erasures, and lists the compliance packs
issued so a holder can check one. Everything is generated from the live record
when the page opens. You can forward it to an auditor. Starts on Harbor.

![The top of a Trust Center: published by the agency, a plain statement of what the page is, and four figures for the client's domains](/docs-media/trust-center.png "The top of a Trust Center page, as an auditor opens it. Sample data: an invented agency and client.")

**What is a prospect report?**
A plain-language email security check of a company you want to win, shared as a
link under your workspace's name. It is a snapshot taken when you create it, so
opening the link never scans anyone's DNS. Fairway includes 10 a month, Harbor 50,
Admiralty and Fleet 200. Every report created in a calendar month (UTC) counts,
including one you have since removed, because each one was a scan.

**Can I use my own brand?**
From Harbor, your agency's name, logo and colours appear in the client portal, on
monthly reports, Trust Centers and prospect reports, and in the emails clients
receive. Unless you send from your own address (see below), those emails come from
our shared address with your agency's name in front. The pages open at our address.

Also from Harbor, add a support email and a support page under Settings, White
label, Client contact. Clients see them in the portal, and on the sign-in page once
it is on your own domain. Replies to the emails they receive go to your support
email.

On Admiralty, add your own domain, such as `reports.youragency.example`, under
Settings, White label, and verify it. From then on everything a client opens is on
your address: the portal and its sign-in page, share links, Trust Centers, prospect
reports, and the links in monthly report and password reset emails. Clients sign in
there with email and password, because Google and Microsoft sign-in only complete
on our address. The browser tab shows your initial, and our pricing, guides and
legal pages are not served on your domain.

Admiralty can also send client emails from your own address, such as
`reports@mail.youragency.example`. Add it under Settings, White label, Email from
your domain, publish the DKIM and SPF records it shows, and check them. Use a
subdomain such as `mail.youragency.example`, so the records never touch your main
mail. Until the address is verified, and again if the records are later removed,
client emails come from our shared address with your agency's name.

## Team and security

**Can colleagues work in the same workspace?**
Yes. Invite them by email as an admin, analyst or viewer. Admins run the workspace
but cannot change the plan or delete the workspace. Analysts can change domains and
reports but cannot add or delete domains, delete reports, manage clients or see named
forensic recipients. Viewers read clients, domains and reports, and cannot see forensic
data at all. Everyone on the team can see the plan and its usage; only the owner can
change it. Each plan has a team size, and open invitations count against it; an
invitation that has expired does not. A workspace has one owner, who can hand it to
another member under Settings, Members, confirming with their password or an
authenticator code. They stay on as an admin, and the workspace then follows the new
owner's plan.

**How do you sign me in?**
Email and password, or Google or Microsoft. Two-step verification with an
authenticator app is available on every plan, and each code works once. Turning
it on turns off Google and Microsoft sign-in for that account, because we cannot
see whether they asked for a second step; you sign in with your email, password
and code instead. A workspace can require two-step verification of everyone,
and members who sign in with Google or Microsoft then set a password and an
authenticator app. After 10 wrong passwords in 15 minutes, password sign-in for
that account pauses for 15 minutes and we email you; a password reset gets you
in straight away. We email you whenever your password changes. You can see and
end every signed-in device under Settings, Signed-in devices, or from the
account menu.

**How do I change my password?**
Under Settings, Password and two-step. Enter your current password and a new
one of at least 8 characters; a password found in a known data breach is
refused. "Sign out my other devices" is ticked for you, so the old password and
every other session stop working together. We email you to confirm the change.
If you sign in with Google or Microsoft and have no password, Set a password
there emails you a link instead. Forgotten it? Use Forgot password? on the
sign-in page.

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
The same on every plan: aggregate and TLS reports for 400 days, forensic reports
for 30 days, and named recipient details for 7 days. A data export can be
downloaded for 7 days. The audit trail is kept until a deletion request removes
it. Your Trust Center and compliance packs state these figures, so the answer is
never a guess.

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
The hosting region is not confirmed yet, so it is not stated here. Your Trust
Center and compliance packs say "Not confirmed yet" until it is, rather than
guess. The Sub-processors notice lists who processes the data, with each region
where it is confirmed.

**How do I bill my clients for what they used?**
On the Clients page, choose a month and download the usage CSV. It has one row per
client: domains, verified and active domains, aggregate reports, messages, the DMARC
pass rate, forensic reports and alerts opened, then a totals row. It covers complete
months only, the last twelve, and counts each report in the month its reporting
period starts, the same as the monthly client report. The same figures are at
`GET /api/v1/usage` for a PSA or billing tool. Starts on Harbor.

**Is there an API?**
Yes, on Harbor and above. The workspace owner creates API keys that read, or read
and change. The reference, with every endpoint, example and error, is at
`/docs/api`; the machine-readable version is `/api/docs/openapi.json`, and changes
are listed in the API changelog.

## Support

**How do I get help?**
Email `[SUPPORT EMAIL]`. See the Complaint Policy for targets and escalation.

**Can I ask questions inside the app?**
Yes, on Harbor, Admiralty and Fleet. Ask, in the bottom-right corner of the app,
takes a question about the product and answers it from this FAQ, the setup guide,
the API reference, the pricing page and the legal pages, with links to the pages it
used. It cannot see your workspace's data and never changes anything. When those
pages do not answer a question, it says it does not know and points you to support.
Each person can ask 10 questions a minute, and a workspace 200 a day. A question it
could not answer is kept for 180 days so these pages can be improved, with email
addresses, domains and IP addresses removed and nothing that links it to you or
your workspace.

**Is there a service level agreement?**
Not unless one is agreed in writing.

**How do I report a security issue?**
Email `[SECURITY EMAIL]`. We do not run a bug bounty programme at present, and we will
say so here if that changes.

---

## Still stuck

Email `[SUPPORT EMAIL]`. If something here is wrong or out of date, tell us and we
will fix it.
