# DMARC Harbor — Frontend plan (Phase 0 decision)

Decided 2026-10-01. Companion to `docs/DESIGN-SYSTEM.md` (Monolith is locked).
Status vocabulary per that document: the app is a Monolith instrument; the two
public artefacts get their own treatments (see Phase 4).

## What already exists (and what it means for the rebuild)

- `apps/api` — complete, 439 integration tests. **Not to be modified.** 26 route
  files; the contract is `GET /api/openapi.json` (generated from
  `apps/api/src/openapi.ts`). 402 body is `{ error: { code, message, feature } }`.
- `apps/web` — a Next 16.3.6 / React 19.2 / Tailwind v4 template. Fixture-driven.
  Two parts of it are **product truth and survive the rebuild**:
  1. `lib/domain.ts`'s four-posture model (`pass · block · unverified ·
     unmeasured`) with precedence `unmeasured → block → unverified → pass` —
     this is Rule One (an unmeasured state never renders as a pass) encoded as
     code.
  2. Shape-carries-meaning badges (square / diamond / hollow ring / hatch),
     volume formatting, policy ladder, evidence states for the Trust Center.
- Everything else in the template — the four brand directions
  (beacon/swell/watch/signal), `data-brand` switching, fixture payloads — is
  deleted. The brand is locked: Monolith + The Pier + Tide loader.

## Library evaluation (criteria: theming · density · accessibility · dark mode · ownership · mobile)

| Candidate | Theming | Density | A11y | Dark | Ownership | Verdict |
|---|---|---|---|---|---|---|
| **shadcn/ui (Tailwind v4 + Base UI primitives)** | Full: tokens are our CSS variables; Monolith is a token edit | Via TanStack Table + Virtual | Base UI primitives; Radix where Base UI lacks | First-class (token swap) | **Source-owned: fix any component in place** | **Chosen** |
| Mantine (+ mantine-datatable) | Good but via theme object + styles API; its own styling world, not Tailwind | Excellent (datatable) | Strong | Good | Configuration, not ownership; fixing means fighting the styles API | Rejected: ownership + Tailwind conflict |
| HeroUI | Tailwind-Variants plugin; configurable but shallow at our extremes (2px radius, hairlines, no shadows) | No real table | Very good (React Aria) | Good | Configuration | Rejected: its default aesthetic is loud and theming is shallow at the edges Monolith lives on |
| Chakra (v3) | Emphasis/color system assumes hue-as-emphasis | No real table | Good | Good | Mid | Rejected: Monolith owns no hue, so Chakra's emphasis model is a constant fight |
| Park UI (Ark/Zag) | Mid | No real table | Good | Good | Mid; smaller ecosystem | Rejected: no advantage over shadcn+Base UI |
| Base UI alone | N/A (primitives only) | N/A | Excellent | N/A | Full | Used **under** shadcn, not instead of it |
| MUI X DataGrid | Material theming pulls toward Material | Best out of the box | Good | Good | Poor; Pro paywall for grouping/export | Rejected: wrong look, paywalled density |

**Chosen stack.** Next 16 + React 19 + Tailwind v4 (already present, no churn) ·
shadcn/ui components generated on **Base UI primitives** (Radix fallback where
Base UI lacks a piece), source-owned in `components/ui/` · **TanStack Table v9**
+ **TanStack Virtual** for the portfolio grid (sorting, filtering, column
visibility, saved views) · **lucide-react** for icons (brand mark stays our own
Pier SVG) · hand-rolled SVG for all charts, continuing `charts.tsx`'s approach ·
frontend types generated from `GET /api/openapi.json` so the contract cannot
drift · session-cookie fetches from server components.

**Deliberately not added.** No chart library (Recharts/Chart.js fight Monolith's
instrument styling and our charts are bars, sparklines and small multiples). No
TanStack Query yet — server components + fetch cover the first phases; add it
when a screen demonstrably needs client polling. No react-hook-form until the
settings/alert-rule forms (Phase 3) justify it; sign-in and short forms use plain
controlled components.

**Where I differ from the obvious pick.** One library, not two (console + portal).
The portal is a small, read-only, mobile-first surface; a second component
library buys responsive convenience at the cost of two accessibility surfaces to
maintain. The portal gets a **different density treatment, not a different kit**.
Saved views persist to `localStorage` per workspace — the API has no saved-view
endpoint and I will not invent one.

## Phase plan

| Phase | Delivers | Verified by |
|---|---|---|
| **1 — Foundation + Portfolio** (the screen that matters most) | Monolith tokens in Tailwind v4; auth (sign in / sign up / session); app shell with ambient workspace switcher; portfolio grid: clients × domains, 300-row density, sort, filter, column visibility, saved views; four-posture state with `unmeasured` first-class; Tide loader | lint + typecheck + build clean; hand-clicked portfolio against the live API with seeded multi-client data |
| **2 — Evidence** | Domain detail (daily volume chart, senders with unattributed first-class, DNS presence vs posture, stale-window blackout); reports + insights | Hand-clicked per-domain walkthrough |
| **3 — Operations** | Alerts, digests, settings (members, white label, report mailbox, SSO), billing from `GET /entitlements`; 402 → upgrade prompt routed by `feature` key; money as integer minor units | Forced 402 renders the right upgrade prompt; lint/typecheck clean |
| **4 — The two artefacts** | Client portal (white-label, name/monogram only, mobile-first, never forensic data); public Trust Center (Monolith **Light**, five evidence states, zero auth); compliance pack + SHA-256 verifier (legal-artefact typography, published digest) | Trust Center opened logged-out in a fresh browser; a digest verified end to end |
| **5 — Hardening** | Empty/loading/error states everywhere; a11y pass (focus, keyboard, ARIA); 300-row performance; print stylesheet (Monolith Light) for compliance packs | Full manual walkthrough; lint/typecheck/build clean |

Each phase ends with a report and a stop, per the brief. Any API error that is
not a 402 is reported immediately, never worked around.
