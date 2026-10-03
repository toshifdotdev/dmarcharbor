# Frontend handoff prompt

Paste everything below into the frontend agent. The section at the end marked
SELECT A THEME is the only part that is still open.

---

## Context

You are building the frontend for **DMARC Harbor**, a DMARC email-authentication
monitoring platform sold to MSPs and IT agencies. The agency manages monitoring
for many client companies, and client-facing surfaces are white-labelled to the
agency's own brand.

**This is a rebuild.** The old Vite app in `apps/web` has been emptied and is
recoverable from git history if you want to look at what existed. You are
building fresh in **Next.js**.

## Repository

- Root: `G:\dmarcharbor`
- API: `apps/api` — TypeScript, Express, Prisma, PostgreSQL. Do not modify it
  unless you find a genuine bug, and say so rather than working around it.
- Your app: create it at `apps/web`, or wherever you prefer inside the monorepo.
  It is a workspace already (`apps/*`), so it will be picked up automatically.
- Frontend conventions live in existing `apps/web` git history and in the API's
  TypeScript style: explicit types, no `any`, no non-null assertions on
  user-controlled data, comments that explain *why* rather than restate the
  code.

## The one hard rule about truth

**Never hardcode plan names, feature names, limits, or prices in the frontend.**

The backend owns all of it. Fetch `GET /api/workspaces/{organizationId}/entitlements`
and render from that. When a request comes back `402`, the body is
`{ error: { code, message, feature } }` where `feature` is the entitlement key —
use it to route the user to the right upgrade prompt rather than guessing.

This is not style advice. The ladder changed during the build: client digests
moved from Fairway to Harbor, and SSO went from "not built" to Admiralty. Any
hardcoded copy of that is already wrong.

## Authentication

Better Auth, session cookie `better-auth.session_token`. Login, logout and
session refresh all go through `/api/auth/*`.

SSO is now built and sets **the same cookie**, so nothing downstream needs a
special case. A user who arrived through SSO is an ordinary session.

- `GET /api/sso/{connectionId}` — public. Returns the workspace name and
  protocol. Use it to show "Sign in to Example Agency" so a person about to
  enter a work password can see they are in the right place.
- `GET /api/sso/{connectionId}/start` — begins the flow, redirects.
- Callback sets the cookie and redirects to `/portal`.

## API surface

`GET /api/docs/openapi.json` is generated from the code and is the contract. Read it. (The path was previously given wrong as `/api/openapi.json`.)
Every route is documented there, including why it behaves the way it does.

Start here:

| Area | Endpoints |
|---|---|
| Auth | `/api/auth/*` |
| Workspaces | `/api/workspaces`, `/api/workspaces/{id}/entitlements` |
| Clients, domains | `/api/workspaces/{id}/clients`, `/domains` |
| Reports | `/api/workspaces/{id}/domains/{domainId}/reports` |
| Insights, readiness | under the domain and client resources |
| Alerts | `/api/workspaces/{id}/alert-rules` |
| Digests | `/api/workspaces/{id}/report-digests` |
| Client portal | `/api/portal/*` — contacts, **no forensic data** |
| White label | `/api/workspaces/{id}/branding`, `/branding/logo/*`, `/branding/host` |
| Billing | `/api/workspaces/{id}/billing/*` |
| Trust Center | `/api/trust/{slug}` — public, unauthenticated |
| Compliance pack | `/api/compliance-packs/*`, verify at `/verify?reference=` |
| Email collection | `/api/workspaces/{id}/report-inbox` |
| SSO | `/api/workspaces/{id}/sso-connections`, `/api/sso/{connectionId}` |

## Things that will bite you

1. **`GET /entitlements` does not report usage.** It gives limits only. A
   workspace that downgraded below its own usage is over quota and the API will
   not tell you. This is a known gap, listed in the launch checklist. Surface
   what you are given, and do not invent a usage figure.

2. **The public Trust Center and compliance verifier take no authentication.**
   Do not add auth to them, and do not fetch them with credentials. They are
   designed to be opened by an auditor at the client company who has no account.

3. **Never render a logo URL the user typed.** External logo URLs are stored for
   reference but are filtered out of client-facing responses. If you find a way
   to render an arbitrary URL from the branding settings, that is a security
   bug, not a feature.

4. **Forensic data is plan and role gated.** Portal contacts never receive it.
   The API enforces this, but do not fetch it speculatively in a component that
   might render for a contact.

5. **Multi-currency.** Prices exist in USD and INR as integer minor units. Never
   do floating point money.

## Deliverable

A working Next.js app covering:

- Agency: sign up, workspace, clients, domains, DNS verification
- Reports, insights, readiness, with the empty and loading states done properly
- Alerts and scheduled digests
- Billing: plans, checkout, subscription state, dunning messaging
- Settings: members, white label, logo upload, report mailbox, SSO connections
- Client portal: contact-facing, white-labelled, no forensic data
- Public Trust Center and compliance pack download

Empty states, loading states and error states are not polish. They are most of
what a user sees on day one.

## Verification

The API has 409 integration tests and 144 unit tests. Before you call anything
done:

- `npm run lint` and `npm run typecheck` clean across the workspace
- The app boots and you have signed in and created a workspace by hand
- A 402 renders a sensible upgrade prompt rather than a crash

---

## SELECT A THEME — do this first, before writing any component

Three brand directions are in `brand/`. Each folder has the vector source, an app
icon, a maskable icon, favicons at several sizes, and a `preview.png`.

Look at `brand/*/preview.png` for all three side by side.

**1. `brand/01-beacon` — The Beacon**
A harbour light doing the one thing a harbour light does. The beam fades like
light rather than sitting there like a bar, which is what makes it read as a
lighthouse instead of a graphic. Strongest brand story, most distinctive.
Best if you want the product to feel like it has a point of view.

**2. `brand/02-swell` — Swell**
Tall bars over a measured baseline, with a wave beneath. The bars read as a
trend, the wave makes them a sea, and the baseline stops them floating. Clean
and safe; the most conventional of the three.
Best if you want the product to read as data and reporting first.

**3. `brand/03-watch` — The Watch**
A radar scope on a horizon, with a contact on it. The first attempt was
concentric arcs, which came out looking exactly like a wifi icon, so it became a
scope with a sweep and a blip — more maritime and more honest about what the
product actually does.
Best if you want to sell detection and vigilance rather than reporting.

**Palette** (shared by all three, in `brand/README.md`):

| Role | Hex |
|---|---|
| Ink | `#0B1F33` |
| Deep | `#0E4A66` |
| Teal | `#137A9B` |
| Teal light | `#5FB6CE` |
| Amber | `#F2A33C` |
| Foam | `#F5F9FB` |

Amber is not decoration. It is the focal point in the mark *and* the colour a
breach should render in, so use it for that and nothing else. If amber means
"important" in the logo and "problem" in the UI, the user learns to distrust it.

**The wordmark is set in a system font stack and must be outlined to paths
before it is used in print, invoices, or anywhere the font may be absent.** For
screen use the stack is fine.

**Before you start:** pick one of the three, or say you want another pass on
them. Do not blend two of them, and do not start from scratch. Once chosen, it
is the theme for the whole app.

## Build the system, not just screens

Derive tokens from the chosen direction: colour scale, type scale, spacing,
radius, elevation, and a state treatment for each of pass, warn, fail and
unknown. An unrecognised DMARC state must never render as a pass. Then build
components against those tokens so the app is consistent by construction rather
than by discipline.
