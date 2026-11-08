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

**Order from here.** Session 8 is done; next the sessions never run (18, 19, 20,
then 4 and 5 once reports arrive, then 10 and 14), then the re-runs (7, 9, 12,
13, 16, 17). Billing (11) is last, once the Razorpay keys exist. Then one
fast pass over every session not marked final.

| # | Session | Set up first | State |
|---|---|---|---|
| 1 | Accounts and sign-in | nothing | fast pass |
| 2* | Workspace, team members, roles, invitations | nothing | fast pass |
| 3* | Clients and domains: add, verify, bulk import, move, rename, delete | nothing | fast pass |
| 4 | Report ingestion: real DMARC reports arriving and being measured | Migadu mailbox, `rua` on our `_dmarc` record, reports received | **not run**: waiting for reports |
| 5* | Domain posture, senders (with setup-guide links), subdomains, readiness, the portfolio and domain page figures | real reports from session 4 | **not run** |
| 6* | DNS monitoring, change history, expiry, Gmail, Yahoo and Microsoft checks, the home-page checker | nothing | fast pass |
| 7 | Alerts by email, Slack and Teams (single channel) | Slack and Teams test channels | **re-run** (Gemini); routing is in 19 |
| 8 | PSA tickets and every webhook feature: endpoints, deliveries, retries, suspension, replay, rotation, client limits, `/api/v1` | a HaloPSA trial, a webhook receiver, an API key | **final** (8 November 2026); ConnectWise and Autotask wait for a live account |
| 9 | Publishing DNS: Cloudflare connection, hosted DMARC, managed SPF | a Cloudflare token | **re-run** (Gemini); zone import is in 20 |
| 10 | Hosted BIMI, MTA-STS, TLS reports | a BIMI origin and Cloudflare for SaaS | **not run** |
| 11 | Billing: checkout, upgrade, downgrade, failed payment, refund | Razorpay test keys, Paddle sandbox, a tunnel | **not run**: last |
| 12 | White label: logo, colours, support contact, branded client emails | S3 keys for logos | **re-run** (Gemini) |
| 13* | Client portal, approvals, share links, Trust Center, compliance packs, verifier, monthly reports, digests | sessions 2, 3 and 12 | **re-run** (Gemini) |
| 14 | Admiralty: custom domain, agency sending domain, single sign-on | a second domain, a full-access Resend key, an SSO provider | **not run** |
| 15* | Prospect reports, switch kit, usage export, API keys and the API | nothing | fast pass; the webhook API is in 8 |
| 16* | Data export, erasure, audit trail, plan limits on every plan | nothing | **re-run** (Gemini) |
| 17 | Ask, public site, docs and SEO, one end-to-end run as a new MSP | an Anthropic API key | **re-run** (Gemini) |
| 18* | Free tools, glossary and setup guides | nothing | **new** |
| 19 | Routed Slack and Teams channels | 2 Slack and 2 Teams test channels | **new** |
| 20 | Cloudflare zone import | a Cloudflare token that can read several zones | **new** |

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

## Session 20: Cloudflare zone import

1. A token that reads several zones lists them, marked ready, monitored here
   (with the client) or monitored by another workspace (not named).
2. Ticking zones and a client adds them, within the plan's limit, with their
   ownership records; the ones over the limit say so.
3. A token without Zone Read says what to fix. An account with more than 1,000
   zones says it listed part.

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
