# DMARC Harbor — operator console (`apps/web`)

Next.js 16 / React 19 / Tailwind v4, on the locked Monolith design system
(`docs/DESIGN-SYSTEM.md`). Measurement and evidence — never control.

## Run it

```bash
# repo root — npm workspaces hoist deps
docker compose up -d postgres
cp apps/api/.env.example apps/api/.env   # fill DATABASE_URL + secrets
cd apps/api && npx prisma migrate deploy && npm run dev   # API on :4000
cd apps/web && npm run dev                              # web on :3100
```

## Sign in (local dev)

| | |
|---|---|
| URL | http://localhost:3100/sign-in |
| Email | `sam@example.test` |
| Password | `harbor-test-2026` |

Regenerate the seeded account and data at any time:

```bash
cd apps/web && DATABASE_URL=$(grep '^DATABASE_URL=' ../api/.env | cut -d= -f2-) node scripts/seed.mjs
```

The seed prints the credentials to stdout at the end. It creates a workspace,
6 clients, 9 domains, and 12 real DMARC aggregate reports covering all four
postures (aligned, blocking, unverified, not-measured incl. a stale feed and a
never-reported domain).

## Verify the UI

```bash
cd apps/web && node scripts/clickthrough.mjs   # drives a real Chrome, 6 checks
```

Screenshots land in `~/.capy/work/phase1-shots/`. The checks cover: sign-in form
→ portfolio navigation, all five postures visible, and **Rule Zero** — stale
and never-measured read as different facts and neither renders as a pass.

## The rules the UI will not break

1. **Rule Zero — absence is not compliance.** Five postures
   (`pass · block · unverified · stale · unmeasured`) resolve in
   `lib/posture.ts::resolvePosture` with precedence
   `unmeasured → stale → block → unverified → pass`. Never-measured outranks
   blocking: a domain that stopped reporting cannot be called blocking. A
   domain with no signals renders "Signals pending", never a posture. **Stale
   and Not measured are different facts and must never read as one**: stale
   means a measurement window exists and has aged past the threshold
   (measured, then quiet); not-measured means no measurement exists. Both stay
   out of the aligned count and out of any pass rate.
2. **Shape carries meaning, colour only echoes it.** Square = aligned,
   diamond = blocking, hollow ring = unverified, half-filled = stale,
   hatch = never measured. Every badge carries its word; nothing is colour-only.
3. **Monolith owns no hue.** The five postures are the only saturated pixels.
   Brand accent is bone, never a colour.
4. **Never hardcode plans, prices, limits or features.**
   `GET /api/workspaces/:id/entitlements` owns all of it. A 402 body is
   `{ error: { feature } }` — route the upgrade prompt by that key.
5. **The portfolio answers "what needs me today" on open.** Actionable postures
   sort to the top with a row accent; the posture counts ARE the filter chips
   (no separate stat row); column toggles live in one Columns popover. The
   logged-in screen carries no landing-page headline.
6. **A policy column must be evidence-based.** The domain row's `dmarcPolicy`
   is written only by a DNS scan, so an unscanned domain is NOT "no record".
   The column renders the policy reporters actually observed
   (`policy_published → policyP`) and says "not observed" only when no
   evidence exists at all.
5. **Money is integer minor units.** Never floating point.

## Known limitations (not defects)

- **Saved views are `localStorage`-per-workspace.** Views don't follow a team
  member across machines. Shared views are an API feature that may come later.
- **Portfolio signals are fetched per-domain with bounded concurrency** (6 at a
  time) behind `lib/api.ts::getAllDomainSignals`. When
  `GET /api/workspaces/:id/domains?include=signals` lands, collapse that one
  call site — no new screen should grow its own per-domain fan-out. Search for
  `N+1 NOTE` to find the sites.
- **Social sign-in buttons render nothing until `GET /api/auth/providers` lands**
  and reports a live provider. They are driven by that endpoint, never
  hardcoded, so no build shows dead buttons.
- **The contract is `GET /api/docs/openapi.json`** (106 paths). Types in
  `lib/types.ts` are hand-mirrored from API source because the OpenAPI document
  only exposes `ApiError` and `Page` schemas; a typecheck failure there is a
  contract change to review.

## Phases

See `docs/FRONTEND-PLAN.md` for the build order. Phase 1 (foundation +
portfolio) and Phase 2 (evidence: domain detail, senders, DNS vs posture,
reports) are complete; each phase is verified before the next depends on it.
