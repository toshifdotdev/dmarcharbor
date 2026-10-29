# Setup guide

**Effective date:** `[EFFECTIVE DATE]`

From a new account to a client domain at `p=reject`, in the order you will do it.
Each step says which plan it needs; the FAQ answers the questions in between.

---

## 1. Create your account and workspace

1. Sign up with your work email address, or with Google or Microsoft, and confirm
   the email we send.
2. Create a workspace: your agency's name. You confirm the Data Processing Agreement
   and the Terms of Service on the same screen, because a workspace cannot exist
   without them.
3. Turn on two-step verification from your account's security page. As the owner
   you can require it for everyone in the workspace.

Every account starts on Mooring, which is free. Move to another plan from Billing
when your client book needs it.

## 2. Add a client and its domains

1. Open Clients and add a client: the company whose domains you look after.
2. Add its domains one at a time, or paste a list. Each domain belongs to one
   workspace only; if another workspace already monitors it, you are told.
3. For each domain, publish the ownership record shown on its setup page:

| Host | Type | Value |
|---|---|---|
| `_dmarc-harbor-verification.<domain>` | TXT | `dmarc-harbor-verification=<token>` |

Then press Check. DNS can take a few minutes to an hour to update; checking again
is safe.

## 3. Start receiving reports

Pick one of three ways.

- **Publish a DMARC record yourself.** The setup page gives the exact record,
  starting at `p=none` with this client's reporting address. If the domain already
  has a DMARC record, keep it and add our address to its `rua=` list.
- **Publish through Cloudflare** (Fairway and above). Add a Cloudflare connection
  under Settings, DNS, with an API token that can edit DNS for the zone. Preview
  the change on the domain's page, publish it, and put the old value back if you
  need to.
- **Host the DMARC record** (Fairway and above). Point `_dmarc.<domain>` at us with
  the CNAME shown, and remove the old TXT record in the same edit. From then on,
  every policy change is made on the domain's page with no DNS edit.

Moving from another DMARC service? Open the client's switch kit. It reads what each
domain publishes and gives you a record that reports to both services while you
move, so no data is lost on the day you switch.

Reports usually arrive within 24 to 48 hours. Until then the domain reads as
unmeasured.

## 4. Review who sends as the domain

1. Open the domain and its Senders tab. Each row is a service or server that sent
   mail as the domain, with how much of its mail failed.
2. Mark each sender as yours or not yours. Fix the SPF or DKIM of the ones that are
   yours and failing; the reason they fail is shown beside them.
3. On Fairway and above, name an owner for each sender, so the person fixing it is
   recorded.
4. Open the Subdomains tab. It lists names below the domain, such as
   `news.example.com`, that sent mail in the last 90 days and that you do not
   monitor. Monitor the ones that belong to the client (each counts as a domain on
   the plan), and dismiss the rest.

If SPF is over the 10-lookup limit, managed SPF (Harbor and above) publishes a
flattened record from the services you list and keeps it current.

## 5. Get told when something changes

- **Alerts** (Fairway and above): create rules per domain for failure rate,
  failure count, volume from one source, report silence or new unauthenticated
  sources. Alerts go to the people you choose by email.
- **Slack and Teams:** under Settings, connect one Slack channel and one Teams
  channel, and every alert also posts there.
- **PSA tickets** (Harbor and above): connect HaloPSA, ConnectWise Manage or
  Autotask, map each client to a PSA company, and alerts open, update and close
  tickets.
- **Webhooks** (Fairway and above): send signed events to your own systems.
- **DNS and expiry:** every plan keeps each domain's DNS change history and its
  registration expiry date. Fairway and above send warnings about both.

## 6. Bring in your team

Under Settings, Members, invite colleagues by email as an admin, analyst or viewer.
Open invitations count toward your plan's team size. On Admiralty you can connect
SAML or OIDC single sign-on instead.

## 7. Give your client a view

- **Client portal** (Harbor and above): under Settings, Client portal, invite a
  contact at the client by email. They sign in with that address and see their own
  domains, senders and monthly reports, never forensic data.
- **Share links** (Fairway and above): a read-only report for one domain that opens
  without signing in, and expires when you choose.
- **Digests and monthly reports** (Harbor and above): a scheduled email summary, and
  a PDF per client for each month.
- **Usage for billing** (Harbor and above): on the Clients page, pick a finished
  month and download a CSV with each client's domains, reports, messages and
  alerts, so you can bill them for what they used.
- **Trust Center and compliance pack** (Harbor and above): a public page and a
  signed PDF that state what data is held, by whom, and for how long.
- **Your brand** (Harbor and above): your logo and colours on the portal,
  reports and client emails. On Admiralty, client pages can also run on your own
  domain.

## 8. Move to enforcement

1. Open the domain and read its Policy posture panel. It shows the evidence and
   names what still blocks the next step: too few messages or days, a failing
   sender, open alerts, or for `p=reject` less than a month at `p=quarantine` or too
   little DKIM.
2. When the evidence supports the step, change the policy:
   - On a hosted record, choose the policy on the domain's page and publish it.
   - Through Cloudflare, preview and publish the new record.
   - Otherwise, publish the record yourself.
3. To have the client approve first (Harbor and above), use Client approval under
   the policy ladder. Every portal contact at the client is emailed; whoever answers
   first decides, and the decision is recorded under their account. A hosted record
   changes the moment they approve; otherwise you get the record to publish.
4. Go in stages: `p=none`, then `p=quarantine` (optionally as a trial with `t=y`),
   then `p=reject` after at least a month at quarantine.

## 9. Add the rest of the protection

- **TLS reports** (Fairway and above): publish the TLS-RPT record shown on the
  domain's page to see delivery problems to the domain's mail servers.
- **MTA-STS** (Harbor and above): hosted MTA-STS serves the policy file and record,
  so receivers must use TLS when delivering to the domain.
- **BIMI** (Harbor and above): hosted BIMI serves the logo, and the certificate if
  you have one, once the domain is at enforcement.

## 10. Win new clients

Under Prospects (Fairway and above), check the domain of a company you want to win
and send them the link. They read a plain-language report under your name, with an
example of the fake invoice a criminal could send as them; you see how often it was
opened.

---

## When something is not working

**No reports after two days.** Check the domain's setup page: the DMARC record must
be live and list this client's reporting address in `rua=`. A `rua=https://` address
is not collected; add our mailbox address beside it.

**The domain will not verify.** The TXT record must be at
`_dmarc-harbor-verification.<domain>`, not at the domain itself, and its value must
match exactly. Some DNS hosts add the domain to the host name for you, which turns it
into `..<domain>.<domain>`.

**"Already monitored by another workspace".** A domain can belong to one workspace
only, so reports are never split. Ask whoever added it to remove it, or contact
support.

**"Plan limit reached".** The message says which limit and which plan raises it.
Clients and active domains are counted across every workspace you own; a domain
that has stopped reporting stops counting after the plan's window.

**A sender I recognise is failing.** Open it on the Senders tab. It shows whether SPF,
DKIM or alignment failed, and from which addresses. Fix that service's DNS or its
own settings, then wait for the next day's reports.

**An invitation is refused.** The workspace has reached its plan's team size. Remove
someone, cancel an open invitation, or upgrade.

Still stuck? Email `[SUPPORT EMAIL]`.
