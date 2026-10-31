# Basic operations: what an MSP can do, where

An audit of the everyday operations an MSP needs on everything the product manages, in the web app (UI) and in the API. Written 31 October 2026 from the code in `apps/api/src/routes`, `apps/web/app` and `apps/web/components/harbor`.

How to read a cell:

- **both**: the screen has a control and the API has a route.
- **API**: the route exists but no screen calls it.
- **UI**: the screen does it through a route the browser can call but which is not a documented route of ours (Better Auth's organization plugin).
- **missing**: neither has it.
- **n/a**: the operation does not make sense for this thing.
- **(new)**: added in this round.

Paths start at `/api`. `W` stands for `/api/workspaces/:organizationId`, and `v1` for `/api/v1` (API key, documented in the OpenAPI contract). Screens are named by their URL.

## The table

| Entity | Create | View / list | Edit / rename | Delete / archive | Undo / restore | Bulk | Export | Search / filter |
|---|---|---|---|---|---|---|---|---|
| Clients | both: `POST W/clients`, `POST v1/clients` · /clients form, first setup | both: `GET W/clients`, `GET v1/clients` · /clients | both (new): `POST W/clients/:id/rename` (name and slug) · /clients "Rename" | both: `DELETE W/clients/:id` with preview `GET W/deletion-preview?clientId=` · /clients "Delete", typed name. Archive: missing | missing (delete is final) | create: API `POST v1/clients/bulk`. Delete: missing | both (new): `GET W/clients/export` (CSV) · /clients "Client book CSV". Usage CSV: both, `GET W/usage` | UI: /clients filter box and "Needs DNS work" (client side) |
| Domains | both: `POST W/clients/:id/domains`, `…/domains/bulk`, `POST W/clients/:id/switch-kit`, `POST v1/domains`, `v1/domains/bulk` · /clients "Add domains" | both: `GET W/clients/:id/domains`, `GET v1/domains`, `GET v1/domains/:domain` · /domains/:id, /onboarding/:id | rename n/a (the name is the DNS name). Move to another client: both (new): `POST W/domains/:id/move`, preview `GET W/domains/:id/move-preview`, `POST v1/domains/:id/move` · /clients "Move", /onboarding/:id "Move to another client" | both: `DELETE W/domains/:id` · /onboarding/:id, typed name. Pause monitoring: missing | missing (delete is final); a move is undone by moving back | create: both. Delete or move: missing | both: `POST W/exports` (scope DOMAIN) · /settings/export | UI: client book filter |
| Members and roles | UI: Better Auth `invite-member` · /settings/members | both: `GET W/members` · /settings/members | UI: `update-member-role` · /settings/members, with what they gain and lose | UI: `remove-member` · /settings/members | missing (re-invite) | missing | missing | missing |
| Invitations | UI: `invite-member` | UI: `list-invitations` · /settings/members "Waiting to be accepted" | n/a | UI: `cancel-invitation` · "Withdraw" | resend: UI (new): `invite-member` with `resend: true` · "Resend" | missing | n/a | n/a |
| Workspace ownership | n/a | both: role shown on /settings/members | transfer: missing (Better Auth allows it; no screen) | leave: missing (Better Auth `leave`, no screen) | n/a | n/a | n/a | n/a |
| Alert rules | both: `POST W/alert-rules` · /alerts | both: `GET W/alert-rules` · /alerts | both: `PATCH W/alert-rules/:id` · /alerts "Edit" | both: `DELETE W/alert-rules/:id` · /alerts | both: pause and re-enable with `PATCH {enabled}` · row switch | missing | missing | missing |
| Alert events | n/a (rules fire them) | both: `GET W/alerts`, `GET v1/alerts` · /alerts | acknowledge: both: `POST W/alerts/:id/acknowledge`, `POST v1/alerts/:id/acknowledge` · "Acknowledge" | n/a (kept as history) | un-acknowledge: missing | both (new): `POST W/alerts/acknowledge` (up to 100) · /alerts "Acknowledge all open" | missing | UI: open, acknowledged, resolved (client side). API: `?domainId=` |
| Digests | both: `POST W/report-digests` · /digests | both: `GET W/report-digests` · /digests | both: `PATCH W/report-digests/:id` · "Edit" | both: `DELETE W/report-digests/:id` | both: pause and resume with `PATCH {enabled}` | send all: both: `POST W/report-digests/run` | n/a | missing |
| Monthly client reports | both: `POST W/clients/:id/monthly-reports` · /clients/reports | both: `GET W/clients/:id/monthly-reports` | n/a (issued documents are evidence) | missing (by design) | n/a | missing | both: `GET …/monthly-reports/:id/download` (PDF) | UI: client picker |
| Monthly report schedules | both: `PUT W/clients/:id/monthly-report-schedule` · /clients/reports | both: `GET …/monthly-report-schedule` | both: same `PUT` | both: `DELETE …/monthly-report-schedule` · "Remove" | both: `PUT {enabled}` | missing | n/a | n/a |
| Share links | both: `POST W/report-shares` · /onboarding/:id "Share the report" | both: `GET W/report-shares` | n/a | revoke: both: `DELETE W/report-shares/:id`. Remove a revoked row: both: `DELETE …/:id/permanent` | missing (make a new link) | revoke: both (new): `POST W/report-shares/revoke` · "Revoke N live". Remove revoked: both: `DELETE W/report-shares/revoked` | n/a | missing |
| Prospect reports | both: `POST W/prospect-reports` · /prospects | both: `GET W/prospect-reports` | missing | revoke: both: `POST …/:id/revoke`. Remove: both: `DELETE …/:id` | missing | missing | n/a | missing |
| API keys | both: `POST W/api-keys` · /settings/api-keys | both: `GET W/api-keys` | rename or rotate: missing | revoke: both: `DELETE W/api-keys/:id`. Remove a revoked row: both | missing | remove revoked: both: `DELETE W/api-keys/revoked` | n/a | n/a |
| Slack | both: `PUT W/slack-destination` · /settings/slack | both: `GET` | both: same `PUT` | both: `DELETE` | both: `PATCH {enabled}` | n/a | n/a | n/a |
| Teams | both: `PUT W/teams-destination` · /settings/teams | both: `GET` | both: `PUT` | both: `DELETE` | both: `PATCH {enabled}`; test: both `POST …/test` | n/a | n/a | n/a |
| Webhooks | both: `POST W/webhooks` · /settings/webhooks | both: `GET W/webhooks`, `GET W/webhook-deliveries` | name, URL and events: API `PATCH W/webhooks/:id` (the screen only pauses and resumes) | both: `DELETE W/webhooks/:id` | both: resume with `PATCH {active}`; replay a delivery: both `POST …/replay` | missing | n/a | API: deliveries `?endpointId=` |
| PSA | both: `PUT W/psa` · /settings/psa | both: `GET W/psa`, `…/mappings`, `…/jobs` | both: `PATCH W/psa`; mappings `PUT …/mappings/:clientId` | both: `DELETE W/psa`; mapping `DELETE …/mappings/:clientId` | both: pause and resume `PATCH {enabled}`; retry a job `POST …/jobs/:id/retry` | missing | n/a | both: company search `GET …/companies?search=` |
| DNS publishing (Cloudflare) | both: `POST W/dns-connections` · /settings/dns | both: `GET W/dns-connections` | token rotation: missing (remove and add) | both: `DELETE W/dns-connections/:id` | publish undo: both: `POST W/dns-publications/:id/restore` | n/a | n/a | n/a |
| Report mailbox | both: `PUT W/report-inbox` · /settings/mailbox | both: `GET` | both: `PUT` | both: `DELETE` | n/a; collect now: both `POST …/poll` | n/a | n/a | n/a |
| SSO connections | both: `POST W/sso-connections` · /settings/sso | both: `GET` | both: `PATCH …/:id` (label, domains, role) | both: `DELETE …/:id` | both: `PATCH {enabled}` | n/a | n/a | n/a |
| Branding and custom domain | n/a | both: `GET W/branding`, `…/resolved` · /settings/branding | both: `PATCH W/branding`, logo `POST …/logo/store`, `PUT …/custom-domain`, verify `POST …/verify` | both: remove logo and custom domain | missing | n/a | n/a | n/a |
| Portal contacts | both: `POST W/clients/:id/portal-access` · /settings/portal | both: `GET W/portal-access` | missing | revoke: both `DELETE …/:id`; remove a revoked row: both | missing (grant again) | remove revoked: both `DELETE W/portal-access/revoked` | n/a | missing |
| Policy proposals | both: `POST W/domains/:id/policy-proposals` · domain page | both: `GET …/policy-proposals` | n/a | withdraw: both `POST W/policy-proposals/:id/withdraw` | retry the change: both `POST …/retry` | n/a | n/a | n/a |
| Forensic samples | both: `POST W/domains/:id/forensics` (store one) · /settings/forensics | both: `GET W/domains/:id/forensics`, `GET W/forensics/:id` | collection and name retention: both `PATCH …/forensics`, `…/identities` | both: `DELETE W/forensics/:id` | missing (final) | delete all for a domain: both `DELETE W/domains/:id/forensics` | both: workspace export | missing |
| DNS changes | n/a (scans find them) | both: `GET W/domains/:id/dns-changes`, `GET v1/dns-changes` · domain page | acknowledge: both `POST …/dns-changes/:id/acknowledge`, `POST v1/dns-changes/:id/acknowledge` | n/a | missing | missing | missing | both: severity; API: `?acknowledged=` |
| Sender reviews | n/a | both: `GET W/domains/:id/senders` · domain page | both: `PUT …/senders/review`, `PUT …/senders/owner` | n/a | both: set back to unreviewed | per client: API `PUT W/clients/:id/senders/review` | n/a | missing |
| Workspace | both: `POST /api/workspaces` · first setup | both: `GET /api/workspaces` · /settings/workspace | both (new): `POST W/rename` · /settings/workspace "Rename the workspace" | both: `DELETE W` with preview `GET W/deletion-preview` · typed slug, owner only | erasure: both, with a grace period and `POST W/erasures/:id/cancel` · /settings/erasure | n/a | both: `POST W/exports` (JSON or CSV) · /settings/export | n/a |
| Audit trail | n/a (written by the product) | both: `GET W/audit-events` · /settings/audit | n/a (cannot be edited, by design) | n/a | n/a | n/a | missing | both: action, domain, time window; UI: refused only |

## Coverage in short

- Fully covered for what an MSP needs: Slack, Teams, report mailbox, SSO connections, digests, alert rules, monthly report schedules, policy proposals, PSA, branding.
- Covered with a gap left: clients (no archive, no bulk delete), domains (no pause, no bulk move or delete), members (no ownership transfer, no leave, nothing audited), alert events (no export), webhooks (edit is API only), API keys (no rename or rotate), prospects, portal contacts, DNS changes (no bulk acknowledge), forensic samples, audit trail (no export).

## Gaps fixed in this round

1. **Rename a client and change its slug.** `POST W/clients/:id/rename`, owner or admin. The report address, Trust Center link and domains stay. Audited as `CLIENT_UPDATED` with the old and new values. Screen: "Rename" on each client in /clients.
2. **Move a domain to another client.** `GET W/domains/:id/move-preview`, `POST W/domains/:id/move` and `POST v1/domains/:id/move` (with Idempotency-Key), owner or admin. The domain's reports, scans, alerts, digests and share links move with it. The confirmation names what changes hands: portal contacts, pending approval requests (withdrawn), the next monthly report, PSA tickets, digest recipients, and the DMARC record if it still names the previous client's report address. Refused while a provider switch is under way. Audited as `DOMAIN_MOVED`. Screens: "Move" on each domain in /clients, and "Move to another client" on /onboarding/:id.
3. **Export the client book.** `GET W/clients/export`, every staff role. CSV with one row per domain, ids and report addresses, and cells a spreadsheet would run as formulas defused. Audited as `EXPORT_DOWNLOADED`. Screen: "Client book CSV" on /clients.
4. **Acknowledge many alerts at once.** `POST W/alerts/acknowledge` (up to 100), the same right and per-alert behaviour as acknowledging one. Screen: "Acknowledge all open" on /alerts, confirmed with the count.
5. **Revoke many share links at once.** `POST W/report-shares/revoke` (up to 100). Screen: "Revoke N live" under the domain's share links, confirmed with the count and their views.
6. **Resend a pending invitation.** Better Auth's own `resend: true` (same invitation, new expiry, new email). Screen: "Resend" beside "Withdraw" on /settings/members.
7. **Rename the workspace.** `POST W/rename`, owner or admin; the slug and id stay. Audited as `WORKSPACE_UPDATED`. Screen: /settings/workspace.

Each new route has zod validation, the workspace scope, the role check the neighbouring routes use, an audit row, a 404 for anything in another workspace, an OpenAPI entry (`apps/api/src/openapi-paths/operations.ts`) and integration tests (`apps/api/tests/basic-operations.integration.test.ts`). The three new audit actions are added by an expand-only migration (`20261202124500_add_operations_audit_actions`).

## Gaps left on purpose

| Gap | Why it is left |
|---|---|
| Archive a client, pause monitoring of a domain | Needs a new column and decisions on what "paused" means for report intake, the DNS monitor, alerts, digests and the plan's domain count. Product decision and schema change. |
| A grace period or undo for deleting a domain or client | Needs soft-delete state and a purge job; the workspace already has this through erasure. Too large for this round. |
| Transfer workspace ownership, leave a workspace | Better Auth supports both, but who holds billing, how many owners a workspace may have, and the last-owner rules are product decisions. |
| Audit rows for invite, role change, remove and withdraw | These run inside Better Auth; the hook belongs in `apps/api/src/auth/auth.config.ts`, which this round does not own. Requested from the conductor. |
| Bulk delete or bulk move of domains | Destructive at scale; one domain at a time with its own confirmation, or deleting the client, covers the real cases. |
| Bulk acknowledge DNS changes, bulk revoke prospect links | Lower value than alerts and share links; the same pattern applies when wanted. |
| Edit a webhook's URL and events on screen | The API already accepts it (`PATCH W/webhooks/:id`); a screen change only, left for the next settings pass. |
| Rename or rotate an API key | No API for it; revoke and issue a new key. |
| Export alert events and the audit trail as CSV | Not asked for by any screen yet; the workspace export covers the data. |
| Un-acknowledge an alert, restore a revoked link or grant | Revoking is meant to be final; a new link or grant is the way back, and an alert that fires again opens a new event. |
| `/api/v1` routes for renaming clients, deleting domains, digests and alert rules | Additive and easy later; moving a domain was the one a PSA sync needs now. |
