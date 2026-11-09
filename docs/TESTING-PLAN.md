# Manual testing plan

Hands-on testing of the product in a browser, one area per session, against
real email and real Google and Microsoft accounts. It complements the automated
suites: those prove the code does what it says; this proves a person can get
through each flow and that the FAQ, the Setup guide and the words on screen say
what actually happens.

Each item ends as **pass**, **gap** (works, but falls short of what it should
do or of what dmarcian and EasyDMARC do) or **broken** (does not work, or does
something different from what the copy says). Findings are fixed before the
next session starts, and the fixed items are tested again.

## How a session runs

1. Start Postgres (`docker compose up -d postgres`), apply migrations
   (`npx prisma migrate deploy` in `apps/api`), then the API
   (`npm run dev` in `apps/api`, port 4000) and the web app (`npm run dev` in
   `apps/web`, port 3100).
2. Drive the browser with the Playwright MCP. The person testing types every
   password and every code that comes from their own phone or inbox, and reads
   every email; the agent pauses for each and says exactly what to do.
3. For every item, check three things: what happens, what the screen says, and
   what the FAQ and the Setup guide say. Then compare with dmarcian and
   EasyDMARC from their public documentation, and link the sources.
4. Report at the end of the session, one line per item: pass, gap or broken,
   with the evidence (screenshots in `.shots/`, email subjects, database rows).

## Test accounts

Plus addresses on one Gmail inbox, so every message lands in
`dmarcharbor@gmail.com`:

- `dmarcharbor+test1@gmail.com`, `+test2` and so on for email and password
  accounts, a new number for each fresh account.
- `dmarcharbor@gmail.com` for Google sign-in.
- `dmarcharbor@outlook.com` for Microsoft sign-in (a personal account).
- `dmarcharbor+toshif@gmail.com` is the local seed owner
  (`apps/api/scripts/seed-dev-user.ts`).

Never use a reserved domain (`.test`, `.example`, `.invalid`) for an account
that should receive mail: the API never sends to one.

## Session 1: accounts and sign-in

In this order:

1. **Email and password sign-up with email verification.** A short password is
   refused as you type. A password found in a known breach is refused. The
   "Check your inbox" screen names the address and the 24-hour expiry; the
   verification email arrives, and its link signs you in on `/welcome`, which
   says "Email verified". Signing up again with an address that already has an
   account shows the same screen and emails the owner instead.
2. **Sign-in and sign-out.** A wrong password and an unknown address get the
   same sentence. Signing in before verifying sends a fresh link. Sign-out ends
   the session; a protected page then sends you to sign-in and back.
3. **Wrong passwords.** After 10 wrong passwords for one address in 15 minutes,
   password sign-in for it pauses for 15 minutes, even with the right password,
   and the screen says how long. The owner gets one "Sign-in to your account was
   paused" email. A different address from the same browser is not paused by
   it. A password reset ends the pause.
4. **Password reset.** The reset email arrives and its link works for one hour.
   Setting a new password signs out every device and sends "Your password was
   changed". A breached password is refused as the new one.
5. **Two-step verification.** Set up with the QR code or the setup key, a wrong
   code refused, ten backup codes. At sign-in the code is asked for; a code that
   was already used is refused even within its 30 seconds; a backup code works
   once; five wrong codes end the attempt. Regenerating codes stops the old
   ones. A workspace can require it. Every change sends an email.
6. **Google sign-in** with `dmarcharbor@gmail.com`: a new account arrives
   verified and goes to the workspace step. Going back in the browser and
   retrying lands on our sign-in page with a sentence, never the library's
   error page.
7. **Microsoft sign-in** with `dmarcharbor@outlook.com`: a personal account
   arrives verified. A work or school account is trusted only when its
   organisation verified the email domain; otherwise it gets a confirmation
   link first.
8. **Sessions.** Every device is listed with the current one marked. One device,
   every other device, and everywhere can each be signed out, and the signed-out
   device is refused on its next request.

### Re-test after the session 1 fixes

Items 1 to 6 again, looking specifically at: the Microsoft account's verified
state and the welcome page's words for an unverified account; a reused code
refused with "That code was already used"; the back-button retry landing on
`/sign-in?error=state_mismatch`; the pause after 10 wrong passwords, its email
and its audit rows; the "Your password was changed" email after a reset and
after a change; a breached password refused at sign-up.

## All sessions

Twenty in all: the seventeen planned first, and three for what was built
after them (the free tools and guides, routed Slack and Teams channels, and
the Cloudflare zone import). A session marked * needs nothing new set up.

What the state column means:

- **final** (with the date): run in full from this plan, every finding fixed
  and tested again. The fast pass skips it.
- **re-run**: an earlier tester (Gemini) ran it. It is run again in full,
  from this plan, before the fast pass, and then becomes final.
- **fast pass**: run and fixed before the redesign. It gets the quick check
  in the fast pass only.
- **not run** and **new**: never run. Run in full, then final.

**Order from here.** Sessions 4, 5, 8, 10, 18, 19 and 20 are done; next the
session never run (14), then the re-runs (7, 9, 12, 13, 16, 17). Billing (11) is last, once the Razorpay keys exist. Then one
fast pass over every session not marked final.

| # | Session | Set up first | State |
|---|---|---|---|
| 1 | Accounts and sign-in | nothing | fast pass |
| 2* | Workspace, team members, roles, invitations | nothing | fast pass |
| 3* | Clients and domains: add, verify, bulk import, move, rename, delete | nothing | fast pass |
| 4 | Report ingestion: real DMARC reports arriving and being measured | Migadu mailbox, `rua` on our `_dmarc` record, reports received | **final** (9 November 2026), on Google's first report for `dmarcharbor.com` |
| 5* | Domain posture, senders (with setup-guide links), subdomains, readiness, the portfolio and domain page figures | real reports from session 4 | **final** (9 November 2026) |
| 6* | DNS monitoring, change history, expiry, Gmail, Yahoo and Microsoft checks, the home-page checker | nothing | fast pass |
| 7 | Alerts by email, Slack and Teams (single channel) | Slack and Teams test channels | **re-run** (Gemini); routing is in 19 |
| 8 | PSA tickets and every webhook feature: endpoints, deliveries, retries, suspension, replay, rotation, client limits, `/api/v1` | a HaloPSA trial, a webhook receiver, an API key | **final** (8 November 2026); ConnectWise and Autotask wait for a live account |
| 9 | Publishing DNS: Cloudflare connection, hosted DMARC, managed SPF | a Cloudflare token | **re-run** (Gemini); zone import is in 20 |
| 10 | Hosted BIMI, MTA-STS, TLS reports | a BIMI origin and Cloudflare for SaaS | **final** (9 November 2026), on `linkshift.in` through a tunnel; Gmail's logo needs a real VMC |
| 11 | Billing: checkout, upgrade, downgrade, failed payment, refund | Razorpay test keys, Paddle sandbox, a tunnel | **not run**: last |
| 12 | White label: logo, colours, support contact, branded client emails | S3 keys for logos | **re-run** (Gemini) |
| 13* | Client portal, approvals, share links, Trust Center, compliance packs, verifier, monthly reports, digests | sessions 2, 3 and 12 | **re-run** (Gemini) |
| 14 | Admiralty: custom domain, agency sending domain, single sign-on | a second domain, a full-access Resend key, an SSO provider | **not run** |
| 15* | Prospect reports, switch kit, usage export, API keys and the API | nothing | fast pass; the webhook API is in 8 |
| 16* | Data export, erasure, audit trail, plan limits on every plan | nothing | **re-run** (Gemini) |
| 17 | Ask, public site, docs and SEO, one end-to-end run as a new MSP | an Anthropic API key | **re-run** (Gemini) |
| 18* | Free tools, glossary and setup guides | nothing | **final** (8 November 2026); the agency-host check is repeated live in 14 |
| 19 | Routed Slack and Teams channels | 2 Slack and 2 Teams test channels | **final** (9 November 2026) |
| 20 | Cloudflare zone import | a Cloudflare token that can read several zones | **final** (9 November 2026); several zones checked against stand-in answers, the account has one |

## Session 8: PSA tickets and webhooks

Owner `dmarcharbor+toshif@gmail.com` on a plan that includes PSA ticketing and
webhooks. The receiver is a webhook.site URL: it is public, shows every header
and body, and its response code can be set to 500 to test failures. The API
refuses a local or private address, so a localhost receiver cannot be used.

**PSA (HaloPSA trial).** Only HaloPSA is tested: its trial is self-serve.
Autotask and ConnectWise need a vendor-issued sandbox; their forms are checked
for wording only.

1. **Connect.** The three providers listed; ConnectWise disabled with its
   sentence when `PSA_CONNECTWISE_CLIENT_ID` is unset. A wrong secret is
   refused in Halo's own words and nothing is stored. An `http://` address, a
   private address and an address with a path are each refused with their own
   sentence. Right credentials: "Connected", the hint shows the host and the
   last four characters of the client ID, never the secret.
2. **Mapping.** Every client listed as "Not mapped: no tickets". Search finds
   Halo companies after two characters; "No company matched" for nonsense.
   Map, change, remove; each writes an audit row.
3. **Ticket settings.** Read the options from Halo: teams, ticket types, open
   and closed statuses fill in; priority offers only the default (Halo returns
   none). Save, reload, the choices stay. Two tabs saving at once: the second
   is told someone else changed it.
4. **Alert opens a ticket.** An alert on a mapped client's domain opens one
   ticket under the right company, with the title ending `[DH-xxxxxxxx]`, the
   body naming workspace, client, domain, rule and the link back. "Open the
   ticket" goes to it in Halo.
5. **Notes and close.** A reminder adds an internal note; acknowledging adds
   "Acknowledged in DMARC Harbor by …"; resolving adds the resolved note and,
   with a closed status chosen and the close switch on, closes the ticket.
   With no closed status the close is skipped with its sentence.
6. **Unmapped client.** An alert on an unmapped client's domain opens no
   ticket: the log says why, "Events not ticketed" counts it, and the warning
   names the client. Mapping it removes the warning.
7. **DNS-change tickets.** A critical DNS change opens one ticket per domain
   listing the changes; acknowledging each adds a note; the last one closes it.
   The switch off: no ticket.
8. **Failure and pause.** Revoking the Halo secret: the next job pauses
   ticketing at once, owners and admins get "PSA ticketing paused" in the
   bell, the screen says why with Resume. Replacing the credentials and
   resuming sends what was queued, with no duplicate ticket.
9. **Pause, replace, disconnect.** Pause stops new tickets and keeps the
   queue. Replacing with another Halo instance clears the mappings. Disconnect
   says tickets in Halo stay, and removes the mappings and queue.
10. **Roles and plan.** An analyst and a viewer see the screen but cannot
    change it. A plan without PSA shows the upgrade notice and refuses connect
    with a sentence.

**Webhooks.**

11. **Add.** An `http://` URL, a localhost URL and a private IP are each
    refused with a sentence. A webhook.site URL is accepted; the secret is
    shown once and never again; the default events are domain verified and
    alert fires.
12. **Test event.** "Send a test event" queues one; webhook.site receives a
    `domain.verified` POST with `test: true`, all five `x-dmarcharbor-*`
    headers and the user agent. The signature checks out against the secret
    with the recipe on the page. With no endpoint subscribed to
    `domain.verified`, the screen says nothing was queued.
13. **Real events.** An alert firing, a DNS change and a policy change each
    arrive once, only at endpoints subscribed to them, with the documented
    payload.
14. **Delivery log.** Every delivery listed with the event, endpoint, outcome,
    tries and the receiver's answer; the readouts match the rows.
15. **Retries and give-up.** webhook.site set to answer 500: attempts at about
    1, 5, 30 and 120 minutes, then "Gave up" after five tries, with the HTTP
    code shown. A 301 is recorded as a redirect not followed.
16. **Send again.** A given-up delivery sent again arrives with the same event
    id and a fresh signature. On a paused endpoint it is refused with the
    sentence saying to resume first.
17. **Suspension.** 20 failures in a row suspend the endpoint: the line says
    "Suspended after repeated failures" with the time, queued deliveries show
    "Held". Resume clears it as the screen promises, and the held deliveries
    then send. Check what the owner is told about a suspension.
18. **Pause and resume.** Pause holds new deliveries; resume sends them.
19. **Rotation.** Rotate with a 1-hour overlap: the new secret shown once,
    deliveries carry two `sha256=` values, new first, and each verifies with
    its secret; the row says until when. Rotate with none: the old secret
    stops at once, behind a danger confirmation.
20. **Client limits.** An endpoint for one client receives that client's
    domain events and the test and workspace events, and nothing about another
    client. Changing the clients takes effect on the next event.
21. **Remove.** The confirmation says the delivery record goes too; it does.
22. **Through `/api/v1`.** With a `read` key: list endpoints and deliveries,
    every write refused. With a `write` key: add, test, rotate, pause, change
    clients, remove, replay. Another workspace's endpoint is a 404. The
    answers match `docs/API.md`.
23. **Roles and plan.** An analyst cannot change endpoints. On a plan without
    webhooks, adding, testing, rotating and replaying are refused and pausing
    and removing still work; an existing endpoint receives no new events.

For each: what the FAQ, `docs/API.md` (Webhooks, Webhook endpoints, the PSA
recipes) and the screen say, compared with how dmarcian and EasyDMARC
document their webhooks and PSA links.

### Session 8 results (8 November 2026): final

Webhooks against webhook.site receivers (and httpbin.org for a 301); PSA against
a HaloPSA trial (`dmarcharbor.trial.usehalo.com`) with two companies, Pellowyn
Dental and Corriwick Café. Real alerts came from failing aggregate reports on
`pellowyn-clinic.example` (mapped) and `haskerley-law.example` (not mapped);
critical DNS changes were recorded as the monitor records them.

**PSA**

| # | Item | Result |
|---|---|---|
| 1 | Connect | **Pass** after fixes. Three providers listed, ConnectWise disabled with its sentence; a wrong secret refused in Halo's words (`invalid_client`), nothing stored; the hint shows the host and the client ID's last four characters only. |
| 2 | Mapping | **Pass.** Search waits for two characters, "No company matched" for nonsense; map, change, remove. |
| 3 | Ticket settings | **Pass** after a fix. Teams, types and statuses read from Halo; saved; a stale save refused with "Someone else changed this connection". Priority offers only the default (Halo sends none). |
| 4 | Alert opens a ticket | **Pass.** Ticket 2907 under Pellowyn Dental, team 1st Line Support, type Alert, status New, title ending `[DH-…]`, body naming workspace, client, domain, rule and the link back. |
| 5 | Notes and close | **Pass** after a fix. Reminder, acknowledgement and resolve notes are internal Halo actions; resolve closed tickets 2907 and 2908 (status Closed). |
| 6 | Unmapped client | **Pass.** Haskerley Law's alert opened no ticket; the log, the readout and the warning name it; mapping clears the warning, unmapping brings it back. |
| 7 | DNS-change tickets | **Pass.** Ticket 2909 listed both changes; each acknowledgement noted it; the last closed it. With the switch off, no ticket. |
| 8 | Failure and pause | **Pass** after a fix. A revoked secret paused ticketing at once, the owner got "PSA ticketing paused" in the bell, the screen said why with Resume; after replacing the credentials the queued ticket was filed once (2910), no duplicate. |
| 9 | Pause, replace, disconnect | **Pass** for pause, resume and replace. Disconnect not pressed, to keep the trial connected for the fast pass. |
| 10 | Roles and plan | **Pass** after a copy fix. Analyst and viewer are refused (403) and see "No access"; on Fairway connect, test, options and mapping answer 402 naming Harbor, pausing still works. |

**Webhooks**

| # | Item | Result |
|---|---|---|
| 11 | Add | **Pass** after a copy fix. `http://`, localhost, 10/8, 169.254.169.254, `::1` refused; the secret shown once. |
| 12 | Test event | **Pass.** All five headers and the user agent; the signature checks with the page's recipe. |
| 13 | Real events | **Pass.** `alert.triggered`, `dns.changed` and `policy.changed` (reject to none) each arrived once, signed. |
| 14 | Delivery log | **Pass.** |
| 15 | Retries | **Pass.** Waits of 1, 5, 30 and 120 minutes, then gave up after five; a 301 recorded as "Redirects are not followed; register the final URL". |
| 16 | Send again | **Pass.** Same event id, fresh signature; refused on a paused endpoint. |
| 17 | Suspension | **Pass** after fixes. Suspended at 20 failures; the trial delivery comes 30 hours after the suspension began, as `docs/API.md` says; Resume now sends what was held. |
| 18 | Pause and resume | **Pass.** |
| 19 | Rotation | **Pass.** One-hour overlap: two values, new first, each matching; None: only the new one, behind a red confirmation. |
| 20 | Client limits | **Pass.** |
| 21 | Remove | **Pass.** The endpoint and its deliveries are gone. |
| 22 | `/api/v1` | **Pass.** A read key lists only; a write key does everything; another workspace's endpoint and delivery are 404. |
| 23 | Roles and plan | **Pass.** On Mooring, add, test, rotate, replay and edits answer 402 naming Fairway; pause and remove work; no event is queued. |

**Broken, fixed**

- An acknowledged alert never resolved, so its PSA ticket never closed although the setting says it closes when the alert resolves.
- Halo's API page shows the resource server as `…/api`; we refused it.
- Our setup steps omitted `read:customers`, without which connecting cannot work.
- After adding a permission in Halo, the cached token kept the old permissions for up to an hour.
- Halo sends no closed flag, so both status pickers listed every status, sales orders included, and "Closed" was offered as the open status.
- Resuming a suspended webhook endpoint left its failure count at 20 and its deliveries held.
- The rest of a delivery batch kept going to an endpoint after it was suspended, one audit row per delivery.
- The suspended line gave the wrong trial time.

**Gap, fixed**

- Nobody was told about a webhook suspension: owners and admins now get a `WEBHOOK` notice.
- Recent activity did not say which client or domain a row was about.
- "Connected" beside "No successful call yet" straight after connecting.
- The pause sentence said the credentials were refused twice; reminder notes said "nobody has acknowledged" twice; the secret notice repeated itself; the `http://` refusal was garbled.
- The settings header said "read-only for you" above a "No access" panel.
- Pausing PSA ticketing drops what happens during the pause; the screen now says so.

**Open, for later sessions**

- A role changed directly in the database took effect only after signing in again. Check in session 2 that a role changed under Members applies at once.
- A receiver's 429 counts as a failure and its Retry-After is not honoured (the PSA queue honours it).
- ConnectWise and Autotask are early access until run against a live account (launch checklist).

## Session 18: free tools, glossary and setup guides

Signed out, on the public site. Every page at 1440 and 390 wide, with no
sideways scroll, and its search title, description and structured data.

1. **DMARC lookup.** A domain at p=none, one at quarantine with t=y, one with no
   record, one with `pct` (shows retired), one with a web-only `rua`. The tags
   read right, the policy line stops at the published policy.
2. **SPF lookup.** A domain under 10 lookups, one over (red past ten), one with
   a void lookup, one with a loop or missing include. The tree matches what DNS
   holds; each include is its own coloured line.
3. **DKIM lookup.** A real selector with a key (size shown), a revoked one
   (gmail.com `20230601`), a wrong selector, no selector at all, and an invalid
   selector refused before sending.
4. **BIMI lookup.** A domain with a valid logo and certificate, one with a
   logo but no certificate, one with no record, one whose DMARC is too weak.
5. **DMARC generator.** Every choice changes the record; our report address
   is off until ticked and then first in `rua`; another domain's address shows
   the external-authorisation note; the record copies.
6. **Report reader.** A real Google `.zip`, a Microsoft `.xml.gz`, a pasted XML,
   a file that is not a report, a file with a DOCTYPE (refused), a file over
   50 MB (refused). Totals match the file; nothing appears in the network log.
7. **Header analyser.** Headers from Gmail and from Outlook for a passing
   message, a failing one, a forwarded one; the hops and times match the
   headers; nothing appears in the network log.
8. **Glossary and guides.** Every term's anchor works from the tools; every
   guide's steps match the provider's console today; Setup guide appears
   beside a known sender on the Senders tab.
9. **Rate limit.** More than 20 lookups a minute from one address pauses with
   the time to wait.
10. **On an agency's domain** every one of these pages goes to the portal.

### Session 18 results (8 November 2026): final

Signed out against real domains through the public scanner, with the dev API
and web servers. Files for the report reader and header analyser are in
`.shots/s18/`.

| # | Item | Result |
|---|---|---|
| 1 | DMARC lookup | **Pass** after fixes. python.org, github.com, migadu.com (no record), webhook.site (`pct=10`, shown retired), uriports.com (`np=reject`). The policy line stops at the published policy. |
| 2 | SPF lookup | **Pass** after fixes. github.com 10 of 10, salesforce.com 4, oracle.com 10, migadu.com 5, yahoo.com with `ptr`. Each include on its own line. |
| 3 | DKIM lookup | **Pass** after a fix. github.com `google` (2048 bits), gmail.com `20230601` (revoked), mailchimp.com `k1` (1024 bits through a CNAME), a wrong selector, no selector (6 keys found), an invalid selector refused before any request. |
| 4 | BIMI lookup | **Pass** after a copy fix. paypal.com (logo and certificate), uriports.com (no certificate), proton.me (declines BIMI), github.com (no record), fastmail.com (`p=none`, too weak). |
| 5 | DMARC generator | **Pass.** Every choice changes the record; the external-address note shows; Copy says Copied; `t=y` dropped at `p=none`. |
| 6 | Report reader | **Pass** after a copy fix. The zip, the gz and pasted XML give 1,274 messages, 1,210 passing, 64 failing, 95%. DOCTYPE, not XML, XML that is not a report and a file over 50 MB are refused. No network request. |
| 7 | Header analyser | **Pass** after a copy fix. Passing Gmail, a failing spoof and a forwarded Outlook message with ARC read right; hop times match. No network request. |
| 8 | Glossary and guides | **Pass.** 189 links from the tools, glossary and guides, none broken. The Microsoft 365, Google Workspace and Mailchimp guides match the providers' pages today (the 2025 `dkim.mail.microsoft` CNAME format, Authenticate email › Generate New Record, k2 and k3). Setup guide shows beside Microsoft 365 and Google Workspace on pellowyn-clinic.example's Senders tab. |
| 9 | Rate limit | **Pass.** The 21st lookup in a minute answers 429 with Retry-After; the tool says "Too many lookups from this network just now. Wait a minute, then try again." |
| 10 | Agency domain | **Pass** with a Host header and a verified custom domain set on Wistholm IT for the test (removed after): `/tools`, all seven tools, `/glossary`, `/guides` and a guide answer 307 to `/portal`. See the open item. |

Every page has its title, description, canonical and JSON-LD (FAQPage on the
tools, HowTo on the guides). No sideways scroll at 390, 768 or 1440, at rest or
with results.

**Broken, fixed**

- A DNS timeout on a large TXT answer read as "SPF record missing" (oracle.com, pfizer.com, cisco.com). TXT lookups now get two tries of 4 seconds; a lookup that fails reads "could not be read" (`dmarc_lookup_failed`, `spf_lookup_failed`), and a monitored scan with one is stored as failed, so it never becomes the baseline the next scan is compared with.
- The DMARC reading did not know `np`, and showed `fo` as raw values.
- The SPF tool listed an include-chain problem twice, once from the tree and once from the scanner's finding.
- A domain whose only key is revoked said "No DKIM key found" beside "publishes a revoked key".

**Gap, fixed**

- BIMI with an empty `l=` said the logo was missing rather than that the domain declines BIMI.
- A refused file in the report reader did not say the previous report was still shown.
- An Authentication-Results header with no server id read as from a blank receiver.
- Tool descriptions ran past the length search results show; now 131 to 148 characters.
- In the SPF tree on a phone, long names broke inside a label ("oracle.co / m"); they now wrap after a dot.

**Open, for later sessions**

- The agency-host lookup times out after 1.5 seconds and then served our own pages for 30 seconds: on the first request for the test host, `/tools` answered 200 instead of going to the portal. **Fixed (9 November):** a failed lookup now fails closed. On a host that is not ours, the pages about us go to `/portal` (307) while the lookup cannot answer, client links still load, and the failure is remembered for 5 seconds instead of 30. Checked with the API stopped (`/tools` and `/pricing` 307, `/share/…` and `/sign-in` 200) and running (an unknown host still 200). Repeat on a real custom domain in session 14.

## Session 19: routed Slack and Teams channels

Webhook rotation, client limits and `/api/v1` webhooks moved to session 8.

1. **Several channels.** Add two Slack and two Teams channels: one for every
   client and kind, one per client, one for DNS changes only. A test message on
   each names what it is routed to.
2. **Routing.** A failing-mail alert reaches the client's channel and the
   unrouted one, not the DNS-only one; a DNS change summary lists only each
   channel's clients' domains; an expiry warning likewise.
3. **Manage.** Pause, change routing, change address, remove; the 21st channel
   is refused; a client from another workspace is refused; the audit trail
   names each change.

### Session 19 results (9 November 2026): final

Wistholm IT on Admiralty, with four real channels: Slack `dh-pellowyn`
(Pellowyn Dental, every kind), Slack `dh-dns` (DNS changes, every client),
Teams "DH Pellowyn" (everything) and Teams "DH DNS" (DNS changes and expiry,
Haskerley Law). Real alerts, DNS changes and expiry warnings on
pellowyn-clinic.example and haskerley-law.example, delivered as the scheduler
delivers them; what arrived was read in each channel.

| # | Item | Result |
|---|---|---|
| 1 | Several channels | **Pass** after a copy fix. All four connected from the settings screens; each test message names its routing ("DNS changes and domain expiry about Haskerley Law"). Teams gives a `…environment.api.powerplatform.com:443` address now, which is accepted. |
| 2 | Routing | **Pass.** Failing-mail alerts reached `dh-pellowyn` (Pellowyn only) and DH Pellowyn (both), not the DNS channels. Each DNS summary and expiry warning listed only the channel's own clients: `dh-pellowyn` Pellowyn, `dh-dns` both, DH DNS Haskerley only. Reminders followed the same routes. |
| 3 | Manage | **Pass** after fixes. Pause stopped `dh-pellowyn` getting the next summary and warning; adding expiry to `dh-dns` brought the next warning there; a new address on a channel with 14 failures reset it to 0 and the test arrived; Remove asks first and deletes. The 21st Slack channel is refused (409) and the screen says so at 20; another workspace's client, an old Teams connector address and an unknown id are refused. Every change has an audit row with its actor. |
| – | Roles and plan | **Pass.** An analyst is refused (403). On Mooring, adding, changing, resuming and testing answer 402 naming Fairway, pausing works, and nothing is posted. |

The screens have no sideways scroll at 390 and 1440.

**Broken, fixed**

- Reminders were numbered from the first notice: the first reminder said "Reminder 2 of 3". Now "Reminder 1 of 2"; the PSA note matches.
- A DNS summary or expiry warning about two domains was labelled with the first of them ("Domain: pellowyn-clinic.example") and its Teams button opened that domain.

**Gap, fixed**

- Alert posts and emails read "(FAILURE_COUNT)", "Threshold: GREATER_THAN 50" and "1440 minutes"; now the metric in words, "Fires at: more than 50 messages" and "the last 24 hours".
- "DNS changed on 2 domain(s)" is now "2 domains".
- The audit trail wrote one row for a channel added, renamed, rerouted or given a new address, and named clients by id. Rows now say what changed and name the clients; the screen calls them channels and shows "dh-dns" as typed, not "dh dns".
- The Teams steps named the template "Post to a channel when a webhook request is received"; Teams now calls it "Send webhook alerts to a channel".
- On a phone the hint beside Send test message was a one-word column.

**Open, for later sessions**

- Haskerley Law's first reminder reached nobody: the API restarted (a code edit, under `tsx watch`) while it was being sent. The alert's level had already moved on, so the email row stayed pending and the Teams post was never made, and the next reminder came at the next level. A deploy during a reminder would do the same. Look at it in the session 7 re-run: record the level after sending, so a restart sends the same reminder again.
- DNS changes and expiry warnings that happen while a workspace is on a plan without alerts are not sent after an upgrade. **Decided (9 November): kept.** A notice is about the moment; a backlog posted at upgrade would page people about changes that may be long fixed. The changes stay in the domain's DNS history, and an expiry still close after the upgrade is warned at its next rung.
- An analyst cannot read the Slack and Teams screens (403), as for PSA and webhooks in session 8.

## Session 20: Cloudflare zone import

1. A token that reads several zones lists them, marked ready, monitored here
   (with the client) or monitored by another workspace (not named).
2. Ticking zones and a client adds them, within the plan's limit, with their
   ownership records; the ones over the limit say so.
3. A token without Zone Read says what to fix. An account with more than 1,000
   zones says it listed part.

### Session 20 results (9 November 2026): final

A real token (Zone → Zone → Read and Zone → DNS → Edit, all zones) on the
Cloudflare account that holds `dmarcharbor.com`, its only zone, connected to
Wistholm IT. The code was read first to confirm that listing and importing
write nothing to Cloudflare: connecting calls `GET /user/tokens/verify`,
listing calls `GET /zones`, and importing creates domains here only. The states
the real account cannot show (several zones, more than 1,000, no Zone Read)
were run through the real service and Cloudflare client with stand-in
answers. The connection was removed after the session.

| # | Item | Result |
|---|---|---|
| 1 | Listing | **Pass** after a copy fix. The real account lists `dmarcharbor.com` as "Monitored by another workspace" (it is under Session One Test), without naming it, and the connection reads the account name. Stand-in zones read as ready, monitored here under Pellowyn Dental, and in another workspace. No sideways scroll at 390 or 1440. |
| 2 | Import | **Pass.** 15 zones chosen on Fairway with 9 domains in use: 11 added as pending with their ownership records, the 12th and 13th refused naming Fairway's 20 and Harbor's 80, `dmarcharbor.com` refused as held by another workspace, and a domain already here refused as such. The 11 were removed after. |
| 3 | Refusals | **Pass.** A token without Zone Read (403, code 9109) answers what to add and marks the connection with it; a token that sees no zones gets its own sentence; 1,250 zones read 20 pages, list 1,000 and say the list is partial. A wrong token and a Global API Key are refused when connecting. |

**Gap, fixed**

- The zone panel said "1 zones in this account", "1 zones", and offered "Choose all 0 ready to add" when nothing could be added; it now says "1 zone" and "None ready to add: every zone here is already monitored".

## Session 4: report ingestion

The first real aggregate report: Google's for `dmarcharbor.com`, 7 November
2026 (UTC), sent to our `rua` address on Migadu and read by the platform
mailbox poller. `dmarcharbor.com` is under Pellowyn Dental in Session One
Test. The mailbox was opened read-only for the checks; the attachment is in
`.shots/s4/`.

1. **Arrival.** The poller read the message, stored the report and moved the
   message to "DMARC Harbor processed"; the inbox is empty.
2. **Counts.** Every field and record matches the XML: reporter, report id,
   period, policy, records, sources, messages, results, auth results.
3. **Again.** The same message delivered a second time stores nothing.
4. **Who sent it.** The sender is named as the service that sent it, with the
   evidence; a name under the domain is the domain's own.
5. **On the domain page.** The verdict, readouts, routes, Sources, Subdomains,
   Aggregate reports and Gmail/Yahoo/Outlook read what the report says, with
   periods in UTC days. The portfolio agrees.

### Session 4 results (9 November 2026): final

| # | Item | Result |
|---|---|---|
| 1 | Arrival | **Pass.** Received 8 November 11:00 UTC, stored at 11:02, moved to the processed folder; inbox 0, processed 1. |
| 2 | Counts | **Pass** after a fix. google.com, report 13288681401065445299, 7 Nov 00:00–23:59:59 UTC, p=none sp=none adkim=r aspf=r; 7 records, 7 sources (23.251.234.51–61), 9 messages, all DKIM and SPF pass; each record's DKIM (mail.dmarcharbor.com `resend`, amazonses.com) and SPF (rsend.mail.dmarcharbor.com) results stored. `pct=100` was not stored. |
| 3 | Again | **Pass.** A second delivery answers "duplicate" with the same report id; still one report. |
| 4 | Who sent it | **Pass** after a fix. Named Resend, "Confirmed by DKIM", on the Senders tab and on every source; the evidence lists `DKIM s=resend d=mail.dmarcharbor.com (pass)`, the amazonses.com signature and the confirmed `*.smtp-out.ap-northeast-1.amazonses.com` reverse DNS. "Too little data" at 9 messages. `mail.dmarcharbor.com` is listed under Subdomains, 9 messages, 100% pass. |
| 5 | On the domain page | **Pass** after fixes. "Aligned: 9 messages aligned"; Messages observed 9, 7 Nov; SPF and DKIM 100%; one route, "Resend app mail"; Aggregate reports 7 Nov, 7 records, 9 messages, 0 failed, p=none; Gmail 9 messages, below 5,000 a day. The portfolio counts 0 messages not attributed to the domain. |

**Broken, fixed**

- The parser read the policy's `<fraction>` element, but receivers send `<pct>` (RFC 7489), so the percentage was never stored for a real report. It now reads `<pct>`, then `<fraction>`; the one stored report was given its 100.
- Mail signed as a name under the domain counted as unattributed: `mail.dmarcharbor.com` made `dmarcharbor.com` read "Unverified: 100% of volume from senders not attributed to this domain", in the domain page and in the portfolio count (`/domain-signals`).
- The same comparison labelled the route "signs as another domain".
- Resend's mail was named Amazon SES, because it also carries an amazonses.com signature, and the Setup guide pointed at the SES console. A passing DKIM signature with Resend's `resend` selector under the domain now names Resend, and a service seen with the platform it sends through is named rather than the platform.
- The Sources tab's sending domain picked between equal counts in database order and showed amazonses.com; the domain's own passing signature now wins a tie.
- Report periods were dated in the server's time zone: Google's 7 November read "7 Nov – 8 Nov" in India. Periods are now UTC days, shown as one day when they cover one.

**Open, for later sessions**

- There is no Resend setup guide, so a Resend sender has no Setup guide link. Consider one with the guides in session 17.
- The TLS reports tab formats its periods the same local way; check it in session 10. (It did; fixed in session 10.)
- `np` in `policy_published` is not stored (no column).
- The preview account (`dmarcharbor+colour`) was made an admin of Session One Test to read this domain, and removed again after session 5.

## Session 5: posture, senders, subdomains, readiness, the portfolio and domain figures

On `dmarcharbor.com` (the real report from session 4) and Wistholm IT's nine
sample domains, which hold 30 days of generated reports from 8 October to
6 November.

1. **Figures agree.** Every domain's reports, messages, failures and SPF and
   DKIM rates are the same counted from the stored records, in the portfolio
   (`/domain-signals`) and on the domain page (`/insights`), and the senders
   add up to the domain's messages.
2. **Posture.** Each verdict follows the rule and its sentence is true:
   failing mail, not attributed, stale, never measured, aligned.
3. **Senders.** Named where the evidence supports it, with the Setup guide
   beside a known service; a source that named no domain reads as its
   address.
4. **Subdomains.** Names under the domain seen as the From domain are listed
   with their figures.
5. **Readiness.** The next step and what blocks it follow the thresholds:
   1,000 messages, 30 days, 95% pass for quarantine, the reject conditions, no
   failing sender, no open alert.
6. **Screens.** The portfolio row and the domain link open the domain; no
   sideways scroll at 390 and 1440.

### Session 5 results (9 November 2026): final

| # | Item | Result |
|---|---|---|
| 1 | Figures agree | **Pass.** All 13 domains match three ways, from thrandle-build.example (750 reports, 1,572,003 messages, 127,148 failed, DKIM 91.91%, SPF 70.17%) to the four with none; each domain's senders sum to its messages and failures. |
| 2 | Posture | **Pass** after a copy fix. Four Blocking, corriwick-cafe.example Stale (no report for 9 days), three Not measured, pellowyn-smiles.example and dmarcharbor.com Aligned. |
| 3 | Senders | **Pass** after a copy fix. Setup guide beside Microsoft 365 and Google Workspace (session 18); Resend named on dmarcharbor.com (session 4). |
| 4 | Subdomains | **Pass.** `mail.dmarcharbor.com`, 9 messages, 100% pass, 7 sources. |
| 5 | Readiness | **Pass** after a fix. pellowyn-smiles.example: ready for quarantine (30 days, 7,053 messages, 100%). thrandle-build.example: held at 91.91% and by two failing senders. pellowyn-clinic.example: "none: p=reject is the strictest". dmarcharbor.com: 9 messages, 1 day. |
| 6 | Screens | **Pass.** A row click and the domain link both open the domain (a click before the page has finished compiling in dev does nothing, which is the clickthrough's "landed on /"). No sideways scroll at 390 or 1440. |

**Broken, fixed**

- Readiness counted days by rounding down: 8 October 00:00 to 6 November 23:59:59 read as 29 days, so every domain was one day short of the 30 required and none could be ready. Part days now count, on the domain page and in the portfolio report.
- The Blocking verdict said "a rejecting policy is live: mail is being denied" for domains at p=none and p=quarantine, where the failing mail was delivered or sent to spam. It now says what is true at every policy: mail sent as the domain failed DMARC.

**Gap, fixed**

- A source that named no domain appeared in readiness as "Sending service 185.234.218.12|unknown … (seen from 185.234.218.12)"; it now reads "The source at 185.234.218.12, which named no domain, fails DMARC…".
- "1 alert(s) are still open", "Only 1 days of reporting": counted in words now.

**Open, for later sessions**

- The clickthrough's portfolio-to-domain failure is a dev compile race, not a broken link; it needs a longer wait or a warmed route before the fast pass.

## Session 10: hosted BIMI, hosted MTA-STS and TLS reports

On `linkshift.in` (a domain of ours, verified as client "Linkshift (session
10 test)" under Wistholm IT on Admiralty), with `dmarcharbor.com` standing in
for the hosting zone. Cloudflare for SaaS is on that zone; a Cloudflare tunnel
carries only `/.well-known/mta-sts.txt` and `/bimi/` to the local API (every
other path answers 404 at the tunnel). The BIMI certificate is self-signed for
`linkshift.in`, because a real VMC costs money.

1. **Hosted MTA-STS.** Start, the custom hostname and its certificate, the
   public policy, edits, refusals.
2. **Hosted BIMI.** Start, the logo and certificate checks and refusals, the
   public record and files, the expiry warning.
3. **The scanner** reads both, as a receiver would.
4. **TLS reports.** A report arriving, counted once, shown on the tab in UTC
   days.
5. **Release.** BIMI after the CNAME check and at once; MTA-STS through
   `mode: none`.
6. **Roles and plan.**
7. **Screens** at 390 and 1440.

### Session 10 results (9 November 2026): final

| # | Item | Result |
|---|---|---|
| 1 | Hosted MTA-STS | **Pass.** Two CNAMEs; Cloudflare issued `mta-sts.linkshift.in`'s certificate in about 4 minutes; Active. `https://mta-sts.linkshift.in/.well-known/mta-sts.txt` answers 200 `text/plain`, `no-store`, `mode: testing`. An edit publishes a new id in the TXT; an invalid MX is refused (`INVALID_POLICY`) and a stale version answers 409 `VERSION_CHANGED`. |
| 2 | Hosted BIMI | **Pass.** An SVG failing 4 of the 7 checks, a certificate for another domain (`BIMI_CERT_WRONG_DOMAIN`) and one carrying its private key (`BIMI_CERT_HAS_PRIVATE_KEY`) are refused. With the logo and certificate uploaded, `default._bimi.linkshift.in` resolves through the CNAME to `v=BIMI1; l=…svg; a=…pem`; both files answer 200 with the sandbox CSP, an unknown file 404. The panel says "Not a mark certificate" and warns 30 days before expiry. |
| 3 | The scanner | **Pass.** MTA-STS found, policy fetched (testing, `route1.mx.cloudflare.net` covered); BIMI found, logo 7 of 7 checks, DMARC qualifies at quarantine. TLS-RPT missing on `linkshift.in`, which is true. See the open item on the office resolver. |
| 4 | TLS reports | **Pass** after a fix. A crafted RFC 8460 report (8 November, 118 sessions passed, 3 failed: `certificate-host-mismatch` 2, `starttls-not-supported` 1), mailed to the signed inbound webhook, is stored; the same message again answers "duplicate". The tab reads 121 sessions, 3 failed, 2.47%, each result type explained, per receiving server, and the report's policy string. The MTA-STS hint goes once the scan reads MTA-STS. |
| 5 | Release | **Pass** after copy fixes. BIMI: Stop hosting goes to Releasing, keeps serving, and shows the TXT to republish; Remove now deletes the TXT at once and the files answer 404 at the origin. MTA-STS: Stop hosting publishes `mode: none` under a new id (the Cloudflare write took 11 seconds) and keeps serving it until 11 November (the 1-day max_age plus a day); editing is gone. |
| 6 | Roles and plan | **Pass** after a fix. A viewer's writes answer 403; an analyst can publish (analysts have domain update). On Fairway and Mooring every write answers 402 naming Harbor; TLS reports answer 402 on Mooring naming Fairway. Reading and Check now stay open on every plan, so a downgraded workspace can still leave. |
| 7 | Screens | **Pass.** Both panels and the TLS tab at 1440 and 390, no sideways scroll; the long CNAME values wrap. |

**Broken, fixed**

- The DNS publishing limit (30 an hour per workspace) counted refused requests. A few tries at an SVG that failed the checks, a stale edit and an invalid MX locked the workspace out with "That workspace has published 30 DNS records this hour", when nothing had been published. A 4xx is now given back; a 5xx still counts, because the provider may have been called. Checked: four refused writes leave the count at 0, one real edit makes it 1.
- TLS report periods were dated in the viewer's time zone: 8 November (00:00 to 23:59:59 UTC) read "8 Nov 2026 – 9 Nov 2026" in India. They are UTC days now, one day when they cover one, as the aggregate reports were in session 4.

**Gap, fixed**

- Releasing BIMI showed the same advice twice, and the API's copy named "DMARC Harbor", which a white-label host must not show. It also showed a second Check now (with the same test id) and a Stop hosting that did nothing.
- The Remove now dialog said "nothing was delegated that we still need to serve" for a record whose CNAME is live.
- A released BIMI record offered logo and certificate uploads ("No logo yet. Nothing is published until one is uploaded"), and every upload answered 409 "This record is being released". The uploads are hidden once released, and the API says hosting has stopped.
- The MTA-STS release notice repeated the panel below it, and the panel said senders "cached the enforcing policy" for a testing one.

**Open, for later sessions**

- Gmail shows the logo only with a real VMC or CMC; the self-signed certificate proves the path, not the inbox.
- The TLS-RPT record on `dmarcharbor.com` was published on 9 November and two messages were sent from Gmail. Google's first real report (for `dmarcharbor.com`, in Session One Test) should arrive about 10 November; check it lands and reads the same.
- The office resolver (10.2.1.60) answers a TXT query at a CNAME with the CNAME alone and does not follow it, so the API's own scan read `_mta-sts` and `default._bimi` as missing. Public resolvers follow it. For this session the API ran with Node's resolvers pointed at 1.1.1.1; a production host's resolver follows CNAMEs.
- One in-app scan straight after an API restart read BIMI as missing; the next found it, and it did not happen again.
- Cloudflare's edge kept the released SVG for up to the hour the API allows, and its default browser TTL raised that to 4 hours. Added to the launch checklist: "Respect Existing Headers" on the hosting zone.
- The session 10 set-up (tunnel, test records, fallback origin, custom hostname, the hosted rows and the env block) is removed with the rest of the test data.

## Session 2: workspace, team members, roles, invitations

Owner `dmarcharbor+test1@gmail.com`. Invite `dmarcharbor+admin@gmail.com`,
`+analyst` and `+viewer`, and `dmarcharbor@outlook.com` through Microsoft
sign-in.

1. **Roles.** Each role sees and can do exactly what the FAQ and the Security
   Policy's access table say: only the owner changes the plan; an analyst does
   not see named forensic recipients; a viewer sees no forensic data.
2. **Seat limits.** Each plan's team size counts open invitations as well as
   members.
3. **Invitations.** Expiry, resend, cancel, and accepting one by email and
   password and by Microsoft sign-in.
4. **Members.** Remove a member, change a role, transfer ownership if it
   exists.
5. **Workspaces.** Switch between them, and the per-account workspace limit.

For each: the FAQ, the guide and the words on screen, compared with dmarcian
and EasyDMARC.
