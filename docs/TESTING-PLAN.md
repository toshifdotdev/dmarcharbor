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
after them (the free tools and guides, routed Slack and Teams channels with
the webhook additions, and the Cloudflare zone import). A session marked * needs
nothing new set up.

**Order from here.** First the sessions never run (4, 5, 10, 14), then the new
ones (18, 19, 20), then the sessions an earlier tester ran, again. Billing (11)
is last, once the Razorpay keys exist. Then one fast pass over all twenty,
because the redesign changed every screen after most sessions were run.

| # | Session | Set up first | State |
|---|---|---|---|
| 1 | Accounts and sign-in | nothing | run, fixed; in the fast pass |
| 2* | Workspace, team members, roles, invitations | nothing | run; again if an earlier tester ran it |
| 3* | Clients and domains: add, verify, bulk import, move, rename, delete | nothing | run, fixed; again if an earlier tester ran it |
| 4 | Report ingestion: real DMARC reports arriving and being measured | Migadu mailbox, `rua` on our `_dmarc` record, reports received | **not run**: waiting for reports |
| 5* | Domain posture, senders (with setup-guide links), subdomains, readiness, the portfolio and domain page figures | real reports from session 4 | **not run** |
| 6* | DNS monitoring, change history, expiry, Gmail, Yahoo and Microsoft checks, the home-page checker | nothing | run, fixed; again if an earlier tester ran it |
| 7 | Alerts by email, Slack and Teams (single channel) | Slack and Teams test channels | run; routing moves to 19 |
| 8 | PSA tickets and webhooks (create, test, deliveries, replay) | a PSA trial, a webhook receiver | run; rotation and client limits move to 19 |
| 9 | Publishing DNS: Cloudflare connection, hosted DMARC, managed SPF | a Cloudflare token | run; zone import moves to 20 |
| 10 | Hosted BIMI, MTA-STS, TLS reports | a BIMI origin and Cloudflare for SaaS | **not run** |
| 11 | Billing: checkout, upgrade, downgrade, failed payment, refund | Razorpay test keys, Paddle sandbox, a tunnel | **not run**: last |
| 12 | White label: logo, colours, support contact, branded client emails | S3 keys for logos | run except the logo upload (closed S3 account) |
| 13* | Client portal, approvals, share links, Trust Center, compliance packs, verifier, monthly reports, digests | sessions 2, 3 and 12 | run, fixed |
| 14 | Admiralty: custom domain, agency sending domain, single sign-on | a second domain, a full-access Resend key, an SSO provider | **not run** |
| 15* | Prospect reports, switch kit, usage export, API keys and the API | nothing | run, fixed; webhook API in 19 |
| 16* | Data export, erasure, audit trail, plan limits on every plan | nothing | run, fixed |
| 17 | Ask, public site, docs and SEO, one end-to-end run as a new MSP | an Anthropic API key | run before the free tools existed |
| 18* | Free tools, glossary and setup guides | nothing | **new** |
| 19 | Routed Slack and Teams channels, webhook rotation and client limits, webhooks through `/api/v1` | 2 Slack and 2 Teams test channels, a webhook receiver, an API key | **new** |
| 20 | Cloudflare zone import | a Cloudflare token that can read several zones | **new** |

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

## Session 19: routed channels and the webhook additions

1. **Several channels.** Add two Slack and two Teams channels: one for every
   client and kind, one per client, one for DNS changes only. A test message on
   each names what it is routed to.
2. **Routing.** A failing-mail alert reaches the client's channel and the
   unrouted one, not the DNS-only one; a DNS change summary lists only each
   channel's clients' domains; an expiry warning likewise.
3. **Manage.** Pause, change routing, change address, remove; the 21st channel
   is refused; a client from another workspace is refused; the audit trail
   names each change.
4. **Webhook rotation.** Rotate with a 1-hour overlap: deliveries carry two
   signatures and a receiver that accepts either keeps working; with none, the
   old secret stops at once.
5. **Webhook client limits.** An endpoint for one client receives only that
   client's events, plus test and workspace events.
6. **Webhooks through the API.** With a `read` key: list only. With `write`:
   add, rotate, pause, remove, replay; another workspace's endpoint is a 404.

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
