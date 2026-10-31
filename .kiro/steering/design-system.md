---
inclusion: always
---

# Design system: Routes

The site is drawn as a transit map. One client domain's mail is a set of lines: each service that sends as the domain is a coloured line, the checks are stations, the inbox is the terminus, and the unknown sender is a dashed red line turned away at p=reject. Everything else on the site extends that picture. It is the only design language; any older "Beacon", "Monolith" or "Chart" design text is superseded for new work.

Reference: the live home page (`apps/web/components/harbor/landing*.tsx`, `landing.module.css`) and its hero map (`landing-route-map.tsx`).

## The idea, in one line

White page, near-black type, and colour only in the lines, the way a transit map keeps it.

## Palette

| Token | Value | Use |
|---|---|---|
| ground | `#ffffff` | every page. No off-white, no cream, no tinted bands |
| ink | `#15171b` | headings, body, strokes, primary buttons |
| ink-2 | `#41454d` | running copy, leads |
| ink-3 | `#6c717a` | meta, captions, the "kind" half of a label (4.9:1) |
| app meta | `#5f646c` | labels and meta on dense app screens, where 12.5px text needs more contrast (6.0:1) |
| rule | `#e7e9ed` | hairlines, unbuilt line segments |
| rule-2 | `#c9cdd4` | closed stations, dotted "not measured" lines, field borders |
| red | `#d9342b` | forged, failed, refused. Nothing else (4.7:1 as text) |

In code (`apps/web/app/globals.css`) the tokens keep their older names, so no screen needs class renames: ground = `paper` (`paper-3` #f3f4f6 is the one recessed well, for code, hover and disabled), ink = `fg`, ink-2 = `fg-2`, app meta = `fg-3`, ink-3 = `fg-4`, rule = `rule` and `rule-2`, red = `fail`. Line colours are `route-blue`, `route-orange`, `route-green`, `route-yellow`, `route-purple`, `route-red`. State: `ok`, `warn`, `warn-mark` (shapes only, never text), `fail`, `crit`, `void`, and their `*-wash` fills, used only behind a state notice. `act` is the accent for links, focus and selected states; `cta` is the primary button. Both are ink until a verified tenant domain recolours them.

Line colours, for senders on maps and nothing else: blue `#1f5fd6`, orange `#f07c1b`, green `#13a050`, yellow `#f2b705`, purple `#8a3fd1`, and red `#d9342b` dashed for the unknown sender. A colour names a line; it never decorates a heading, button, icon, background or chart.

State text, when a word must carry state: ok `#0f7a3b`, warn `#9a5b00`, fail = red, not measured = ink-3 with a hollow or hatched mark. State always travels with a word, never colour alone.

White label: primary buttons are ink for our own brand and the tenant's primary colour on a verified custom domain (`--hb-primary`, `--hb-primary-ink`, written by `BrandApplier`). Line colours stay, because they are data. A figure that explains white label may draw a sample agency's own line in that agency's colour (teal `#0f766e` for the sample agency); that colour appears nowhere else.

## Type

- One family: Albert Sans, loaded once in the root layout through `next/font/google` as `--font-routes` (Tailwind `font-ui`; `font-sans` points at it too; the home page's `--rt-sans` is the same face). Weights 400 to 760.
- Display headline: weight 760, line height 0.96, tracking -0.035em, `text-wrap: balance`.
- Section heading (h2): weight 740, line height 1.02, tracking -0.03em, 36px on phones to about 60px at 1440.
- Lead: 19px (17px on phones), ink-2, line height 1.5, max about 34rem.
- Labels follow the map: a bold name with a lighter kind beside or below it ("**Microsoft 365** staff mail"). No uppercase tracked micro-labels, no mono eyebrows.
- Mono (`--font-hyper-mono`, the `data` utility) only for literal DNS and the identifiers an operator copies exactly: domains, records, tags, IPs, tokens, selectors, the `_dmarc.` input. Never as decoration.
- Figures are tabular where they line up (`tnum`).
- App screens use the type scale in `globals.css`: `text-meta` 12.5px, `text-ui` 13.5px, `text-body` 14.5px, `text-lead` 16.5px, `text-h3` 17px, `text-h2` 22px, `text-h1` 30px, `text-d2` 44px. The sizes above are for public pages.
- Utilities: `legend` is a label in sentence case (12.5px, semibold, app meta colour), never capitals; `display` sets a heading (weight 740, tracking -0.03em); `wide` and `narrow` do nothing now and are only kept so old markup compiles.

## Motifs

- **Line:** stroke 7 on full maps, 5 to 6 on smaller diagrams, round caps, 45 degree bends with a 14 unit corner radius, parallel lines 11 apart.
- **Origin:** a white circle with a 3px ink stroke where a line starts (red stroke for the forged line).
- **Station:** a white capsule with a 3px ink stroke across every line that stops there. Label above or beside: bold name, lighter kind.
- **Terminus:** a larger capsule where mail is delivered; a short red bar where it is refused.
- **Message:** a white dot with a 2.5px stroke in its line's colour, riding the line.
- **Planned segment:** a dashed ink line, for a step that is ready but not taken (the transit convention for a line under construction).
- **Closed station:** hollow and grey, for something absent or not measured.
- **Strip map:** for lists (portfolio rows), a thin version: 5px line, small stations at fixed positions for p=none, p=quarantine, p=reject.

## Layout and spacing

- Container: max 1320px; side padding 16px (phones), 24px, 48px from 1100px. This is the `page-wrap` utility; every public page uses it, so the header, the content and the footer share one edge.
- Section padding: about 128px top and bottom at desktop, 96px on tablets, 72px on phones. Sections are separated by space and at most one hairline, never by boxes or tinted bands.
- Two-column sections: copy at 0.74fr, figure at 1fr, from 1100px up; stacked below. Alternate the figure's side so the page does not repeat itself.
- Frames (a portal mock, a readout): 1px rule border, radius 14 to 16px, no shadow.
- Buttons are pills (radius 999px): primary ink fill with white text, 54px tall for page CTAs and 40px in the header. Secondary is text with an underline or a ghost pill.
- Breakpoints: 640, 900, 1100. Check 390, 768 and 1440 for overflow.

## Motion

- The server HTML is the still, final picture. Motion is added after mount, only when `prefers-reduced-motion` is not set, so hydration never disagrees.
- Messages ride lines with SVG `animateMotion`, paused while the drawing is off screen.
- A drawing plays forward as it scrolls into view (stroke or scale, under 900ms, ease out), and plays again the next time it returns after leaving the window. It never runs backwards and never follows the scroll position. Nothing loops except riding messages and the loading mark.
- Hover and focus transitions 120 to 150ms. No parallax, no scroll-jacking, no smooth-scroll library, no text that fades in.
- Round SVG coordinates (two decimals) and never read the clock or random numbers during render.

## Every section

- One clear idea, said in the heading. Cut anything that does not earn its place.
- The figure is drawn in the map's language, not a screenshot of a dashboard.
- Sample data uses `.example` domains and is labelled as sample in a caption.
- Sample agency and client names are invented and checked against real businesses before use (the home page uses Wistholm IT, Pellowyn Dental, Corriwick Café, Haskerley Law, Ollerbeck Vets, Thrandle Build). No Acme, Contoso, Northwind or other names a real business uses. Real products appear only as the senders they are (Microsoft 365, HubSpot, Xero and so on).
- Figures are open drawings on white with a figure head (bold name, lighter meta, hairline) and a caption, like the hero map. No framed UI mock-ups with fake buttons.
- Visible text never hard-codes "DMARC Harbor": use `brandName(await readHostBrand())` (`brandName` is exported from `components/harbor/public-frame.tsx`, `readHostBrand` from `lib/host-brand.ts`). `hostBrand.workspaceName` alone is wrong: on an unverified host it can hold an agency name the page must not show.

## App screens

The signed-in app is the same language at working density: white, hairlines, ink type, state words with their marks, no cards and no shadows on the page. Build screens from the shared parts and do not restyle them locally.

- **Frames.** Public pages: `PublicHeader` and `PublicFooter` (`components/harbor/public-frame.tsx`). Signed-in app: `AppShell` with `PageHeader` (a white sticky bar, the section nav marked by a 3px rounded line under the current section). Sign-in, sign-up and first setup: `AuthFrame`. Documents that leave the product: `ArtefactFrame`. Client portal: `PortalFrame`.
- **Buttons** (`components/ui/button.tsx`) are pills: `sm` 30px for tables and toolbars, `md` 36px by default, `lg` 44px for a form's submit. `primary` is ink (or the tenant colour), one per region; `secondary` is white on a hairline; `ghost` is text that takes a pill on hover; `danger` is red and only behind a confirmation.
- **Inputs** (`field.tsx`, `choice.tsx`) are 30, 36 or 44px with an 8px radius and a `rule-2` border; focus is an ink border and a soft ring. `SearchInput` is a pill. `Segmented` is a pill track with the chosen option filled ink. A setting that applies at once is a `Switch`; one that waits for Save is a `Checkbox`.
- **Tables** (`table.tsx`) read like a timetable: sentence-case column labels, hairlines between rows, no vertical rules, no zebra, no card. Figures right-aligned in tabular numerals; a missing value is `Nil`, never a zero. Below its minimum width a table scrolls inside itself; the page never scrolls sideways.
- **State** (`badge.tsx`): a word in its state colour with its shape. Filled square aligned, diamond blocking, ring unverified, half-filled square stale, hatched square not measured. Never a filled pill in a table column.
- **Other states** (`states.tsx`, `notice.tsx`): `LoadingState`, `EmptyState` (its steps are stations on one line), `ErrorState`, `PermissionState`, `UpgradeNotice`, `PartialNotice` and `Notice`. A failed request is never shown as empty.
- **Waiting** is the riding mark (`TideMark` in `tide.tsx`): a message riding from an origin to a terminus. No spinners and no shimmer. Inside a button, `busy` shows three dots and keeps the button's width.
- **Overlays** (menus, toasts, dialogs) are the only things that cast a shadow (`shadow-float`). Panels and dialogs use `rounded-sheet` (14px) and a hairline.
- **Focus** stays visible: buttons and links get a 2px outline in the accent, inputs the ink border and ring.

## Working on a screen

- A redesign changes how a screen looks, not what it does. Keep every `data-testid`, `data-*` attribute, role, accessible name and visible label that `apps/web/scripts/clickthrough.mjs` reads, and keep the behaviour behind them.
- When several agents redesign at once, each edits only the files it was given. The shared files belong to the conductor: `apps/web/app/globals.css`, `apps/web/app/layout.tsx`, `apps/web/components/ui/*`, `public-frame.tsx`, the app shell (`app-shell.tsx` and the parts it renders), `apps/web/lib/*` and `.kiro/steering/*`. Ask the conductor for a change to one of them instead of making it. Agents do not commit or push; the conductor integrates, commits and pushes once.

## Do

- Let white space separate things.
- Use the five sender colours with the same meaning everywhere: one colour, one service.
- Keep red for forged and failed mail only.
- Write plainly for MSPs and agencies: clients, client domains, tickets, approvals, your brand.

## Don't

- Dark navy with yellow glow, gradients, glows, glass, drop shadows, floating cards.
- Oversized headlines paired with mono micro-labels.
- Generic product-dashboard heroes or UI screenshots as decoration.
- Cream or paper textures, stock photos, any photograph, illustrations of people.
- Fake logos, testimonials, trust badges or invented figures.
- Icon grids of features.
