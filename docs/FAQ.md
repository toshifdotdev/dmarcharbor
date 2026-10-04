# Frequently asked questions

**Effective date:** `[EFFECTIVE DATE]`
**Legal entity:** `[YOUR LEGAL ENTITY NAME]`, trading as DMARC Harbor

---

## What it does

**What is DMARC?**
DMARC is an email authentication standard (RFC 7489) that lets a domain publish a
policy telling receiving mail servers what to do with mail claiming to come from
that domain without being authorised. Gmail, Yahoo and Microsoft require it for
bulk senders.

**What does DMARC Harbor actually do?**
It reads the aggregate and forensic reports that receiving mail servers send to the
reporting addresses your domains publish, and turns them into measurements and
evidence you can hand to a client. It measures whether SPF and DKIM still hold,
spots senders you do not recognise, and tells you what changed.

**Does it send email?**
No. It holds no SMTP credentials, cannot relay or forward mail, and cannot send or
spoof anything. It does not edit your DNS. Enforcement happens at the receiving
mail servers, applying the policy records you publish and control.

**Where do the reports come from?**
From the mail servers that receive your mail, not from us. We ask each domain to
publish a reporting address, those servers send reports there, and we read them.

**Is it only for MSPs?**
No. Anyone managing domains can use it. It is built for agencies and managed
service providers because they are the ones with many client domains, but a single
domain owner can use it too.

## Getting reports

**How do I start receiving reports?**
Publish a DMARC record with a reporting address we give you, at `p=none` first.
We generate the exact record for you. Reports usually arrive within 24 to 48 hours.

**What if I already have a DMARC record?**
Keep it. We read what is published and tell you what it means. Only change it for a
reason.

**My domain publishes reports to a web address instead of a mailbox. Do you collect those?**
Not yet, and we would rather tell you than pretend. A `rua=https://` record means
your reports are going to a web endpoint we do not read, so you will see no report
data for that domain here until that is arranged. **Leave the record as it is.**
Either set up a report mailbox in your settings so we collect by mail, or wait
until we support that transport.

**Can I check a domain without an account?**
Yes. Enter it on the home page. That is one lookup, at one moment, showing what the
world's mail servers already see.

## Plans and billing

**What are the plans?**
Mooring (free), Fairway, Harbor and Admiralty. See the pricing page for current
prices and limits. Limits are per workspace: number of clients, active domains and
members.

**What happens when I go over my limit?**
Creating beyond a limit is blocked, and the message tells you which limit you
reached. Nothing is deleted and nothing is degraded.

**Can I downgrade below what I am using?**
No, and we will not let you. Moving from Harbor to Fairway allows fewer clients, so
if you have more than Fairway allows we will tell you exactly how many you are over
and on which limits, and you can remove the excess or stay where you are. We would
rather refuse than leave you running on a plan that does not include you.

**When does an upgrade take effect?**
Immediately, and the difference is charged then, so you have the new plan now.

**When does a downgrade take effect?**
At the end of the period you have already paid for. You keep everything you have
paid for until that date. Nothing is removed mid-cycle.

**Do I get a refund?**
There is a 30-day money-back guarantee. After that refunds are discretionary and
are considered for things like a defect we caused or a double charge. See the Refund
Policy.

**Which currency am I charged in?**
Indian rupees are processed by Razorpay. Other currencies are processed by Paddle.
You choose before your first payment and it is fixed after that, because changing it
would mean moving a live subscription between two payment processors.

**What happens if my payment fails?**
We tell you and retry. You keep everything you have paid for and full access through
a grace period, and we tell you exactly when the grace period ends. Your data is
never deleted for a failed payment.

**Can I pay by invoice or bank transfer?**
Not at present. Use a card through Razorpay or Paddle.

## Reports and evidence

**How long do you keep my data?**
It depends on your plan. The free plan keeps 30 days; the highest keeps 1095. Your
current retention period is stated on your Trust Center page and in any compliance
pack you issue, so the answer is never a guess.

**What is a compliance pack?**
A signed document, per client, stating what data we hold, who can read it, how long
we keep it and who we use as sub-processors. It carries a SHA-256 fingerprint
published on your Trust Center page, so your client can verify the copy they were
given is the one we issued.

**What is a Trust Center?**
A public page for a client showing their own DMARC posture, without needing an
account.

**Can I share a report with a client?**
Yes. A share link opens read-only in a browser, with no login. You can revoke it at
any time.

**What about forensic reports and personal data?**
Forensic (ruf) reports can contain recipient email addresses. We do not collect them
unless you switch that on for the domain, and we pseudonymise recipient addresses
by default. You can turn identity retention on per domain if you have a lawful
basis to hold it.

## Clients, sharing and branding

**Can my clients see their own data?**
Yes. The client portal gives a contact you authorise read-only access to their own
domains and measurements. It cannot show forensic data to a portal contact, by
construction.

**Can I use my own brand?**
On Admiralty. You can set your logo and colours and serve the portal on your own
domain. Your clients see your brand, not ours.

**Can colleagues work in the same workspace?**
Yes, with member roles and permissions. Every member has their own login.

## Security

**How are my credentials stored?**
Encrypted at rest. We never display a stored password or webhook URL in full.

**Where is my data stored?**
`[DATA_RESIDENCY_REGION]`. See our Sub-processors notice for who processes it.

**How do you sign me in?**
Email and password, optional Google or Microsoft sign-in, and SAML or OIDC
single sign-on where your plan includes it.

**Do you support single sign-on?**
Yes, on Admiralty. SAML and OIDC are both supported, with JIT provisioning and a
domain allowlist. Sign-in for SSO can be disabled for a connection while leaving
password sign-in available.

**Is there an API?**
Yes. API keys with read and write scopes, scoped to your workspace.

## Support

**How do I get help?**
`[SUPPORT EMAIL]`. See the Complaint Policy for targets and escalation.

**Is there a service level agreement?**
Not unless one is agreed in writing.

**How do I report a security issue?**
`[SECURITY EMAIL]`. We do not have a bug bounty programme at present, and we will
tell you if that changes.

---

## Still stuck

Email `[SUPPORT EMAIL]`. If something here is wrong or out of date, tell us and we
will fix it.