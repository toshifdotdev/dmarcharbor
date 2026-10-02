# DMARC Harbor — Design System (locked)

**Decision: Monolith, with a light companion ("Monolith Light").** Chosen 2026-10-01.
This replaces every earlier theme and brand exploration. The old `theme-lab`,
`pricing-lab`, and `brand` folders are removed.

## The rule the system is built around

Monolith owns no hue. The accent is bone. In a product whose entire job is
signalling status, spending the colour budget on branding would destroy the
only signal on the screen: the four DMARC states are the only saturated pixels
in the product. An unrecognised DMARC state must never render as a pass.

## Monolith Dark (primary — app default)

| Token | Value | Contrast on `--bg` |
|---|---|---|
| `--bg` | `#0a0a0a` | — |
| `--surface` | `#101010` | — |
| `--raised` | `#171717` | — |
| `--elevate` | `#1e1e1e` | — |
| `--line` | `rgba(255,255,255,0.08)` | — |
| `--line-strong` | `rgba(255,255,255,0.17)` | — |
| `--ink` | `#f2f2f0` | 17.66:1 (AAA) |
| `--ink-2` | `#a0a09c` | 7.55:1 (AA) |
| `--ink-3` | `#8a8a85` | 5.71:1 (AA) — **revised from `#6e6e6a`, which failed AA at 3.87:1** |
| `--accent` (bone) | `#e6e4dd` | 15.56:1 |
| `--accent-ink` | `#0a0a0a` | — |
| `--accent-soft` | `rgba(230,228,221,0.10)` | — |
| `--pass` | `#86b76a` | 8.48:1 |
| `--warn` | `#cbb05a` | 9.33:1 |
| `--fail` | `#cf6a5e` | 5.54:1 |
| `--unknown` | `#8b8b86` | 5.78:1 |

## Monolith Light (companion — print, PDF, public Trust Center)

Used where a dark surface fails the audience or the printer: client-facing
reports, downloadable compliance packs, the public Trust Center, and any
future light-mode toggle.

| Token | Value | Contrast on `--paper` |
|---|---|---|
| `--paper` | `#f6f5f0` | — |
| `--surface` | `#fffef9` | — |
| `--raised` | `#f0eee6` | — |
| `--line` | `rgba(20,20,18,0.10)` | — |
| `--line-strong` | `rgba(20,20,18,0.22)` | — |
| `--ink` | `#141412` | 16.90:1 (AAA) |
| `--ink-2` | `#55544e` | 6.96:1 (AA) |
| `--ink-3` | `#6b6a62` | 4.98:1 (AA) |
| `--accent` | `#141412` | bone inverts to ink; the system still owns no hue |
| `--pass` | `#456e2f` | 5.46:1 |
| `--warn` | `#7d6210` | 5.30:1 |
| `--fail` | `#ad4236` | 5.33:1 |
| `--unknown` | `#67665e` | 5.29:1 |

Every state colour clears WCAG AA for normal text in both variants. Pass and
warn are darkened on light so small tabular figures stay readable — hue
relationships between states are preserved.

## Surface treatment

- Surfaces are separated by **lightness**, never by shadow. On dark, a 1px
  inset highlight (`inset 0 1px 0 rgba(255,255,255,0.045)`) does the lifting.
- A film grain at 3.5% opacity (`feTurbulence` noise) sits over dark surfaces
  to break OLED banding. Felt, not seen.
- Ink is off-white (`#f2f2f0`), never pure white. White on near-black halates.

## Type

| Role | Stack |
|---|---|
| Sans | `system-ui, -apple-system, "Segoe UI Variable Text", "Segoe UI", Roboto, sans-serif` |
| Display | `"Segoe UI Variable Display", "Helvetica Neue", Arial, sans-serif` |
| Mono (all figures, tabular) | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace` |

Display headings: weight 600, tracking `-0.035em`. Micro-labels: 11px, 600,
uppercase, tracking `0.1em`, `--ink-3`. Every numeric column is tabular.

## Geometry

- Radius: `2px` everywhere. Controls may go to `3px`; nothing rounder.
- Hairlines at `--line`; `--line-strong` only for structural boundaries.
- Spacing scale: 4 · 8 · 12 · 16 · 24 · 32 · 48 · 72.

## Wordmark

Screen use of the system font stack is fine. For print, invoices, and anywhere
the font may be absent, the wordmark must be outlined to paths first.

## Pricing page

**Decision (2026-10-01): "The Statement refit"** — locked for now, to be revisited
later if the team wants a change. The Statement's typography-as-the-design, with
one structural fix: **all four prices sit above the fold** (verified at
1440×800), side by side with USD and INR posted, and the prose moved below where
scrolling is fine. The rejection reason for the original Statement was that
visitors scrolled to compare prices; the refit fixes the information order
without touching the design.

- Template: `pricing-lab/15-the-statement-refit.html` (static, unwired)
- 14 other pricing explorations were deleted; the lab is archived outside the
  repo in case a revisit needs them
- Live page must render plan names, limits and prices from the API — never
  hardcode. 402s route to upgrade prompts via the entitlement key.

## Logo

**Decision (2026-10-01): The Pier** — an H for Harbor built as a pier: two
pilings standing in water, the crossbar drawn as the waterline between them.

| Asset | Path |
|---|---|
| Master (single-colour, `currentColor`) | `brand/pier.svg` |
| Loading icon — The Tide (same wave language as the crossbar) | `brand/tide-loader.svg` |
| Favicon (16/32/48) | `brand/favicon.ico` |
| Icons 16–512 | `brand/icons/icon-{16,32,48,180,192,512}.png` |
| Maskable icon (mark in 66% safe zone) | `brand/icons/maskable-512.png` |

The mark is single-colour and hue-free by design: bone on ink, ink on bone,
never a third colour. The loading state is the Tide — three wave strokes flowing
in phase — because its strokes are the same curve as the Pier's crossbar, so
identity and motion read as one family. `tide-loader.svg` honours
`prefers-reduced-motion`.
