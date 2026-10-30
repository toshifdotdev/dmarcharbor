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
| rule | `#e7e9ed` | hairlines, unbuilt line segments |
| rule-2 | `#c9cdd4` | closed stations, dotted "not measured" lines, field borders |
| red | `#d9342b` | forged, failed, refused. Nothing else (4.7:1 as text) |

Line colours, for senders on maps and nothing else: blue `#1f5fd6`, orange `#f07c1b`, green `#13a050`, yellow `#f2b705`, purple `#8a3fd1`, and red `#d9342b` dashed for the unknown sender. A colour names a line; it never decorates a heading, button, icon, background or chart.

State text, when a word must carry state: ok `#0f7a3b`, warn `#9a5b00`, fail = red, not measured = ink-3 with a hollow or hatched mark. State always travels with a word, never colour alone.

White label: primary buttons are ink for our own brand and the tenant's primary colour on a verified custom domain (`--hb-primary`, `--hb-primary-ink`, written by `BrandApplier`). Line colours stay, because they are data. A figure that explains white label may draw a sample agency's own line in that agency's colour (teal `#0f766e` for the sample agency); that colour appears nowhere else.

## Type

- One family: Albert Sans through `next/font/google` (`--rt-sans`). Weights 400 to 760.
- Display headline: weight 760, line height 0.96, tracking -0.035em, `text-wrap: balance`.
- Section heading (h2): weight 740, line height 1.02, tracking -0.03em, 36px on phones to about 60px at 1440.
- Lead: 19px (17px on phones), ink-2, line height 1.5, max about 34rem.
- Labels follow the map: a bold name with a lighter kind beside or below it ("**Microsoft 365** staff mail"). No uppercase tracked micro-labels, no mono eyebrows.
- Mono (`--font-hyper-mono`) only for literal DNS: records, tags, the `_dmarc.` input. Never as decoration.
- Figures are tabular where they line up.

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

- Container: max 1320px; side padding 16px (phones), 24px, 48px from 1100px.
- Section padding: about 128px top and bottom at desktop, 96px on tablets, 72px on phones. Sections are separated by space and at most one hairline, never by boxes or tinted bands.
- Two-column sections: copy at 0.74fr, figure at 1fr, from 1100px up; stacked below. Alternate the figure's side so the page does not repeat itself.
- Frames (a portal mock, a readout): 1px rule border, radius 14 to 16px, no shadow.
- Buttons are pills (radius 999px): primary ink fill with white text, 54px tall for page CTAs and 40px in the header. Secondary is text with an underline or a ghost pill.
- Breakpoints: 640, 900, 1100. Check 390, 768 and 1440 for overflow.

## Motion

- The server HTML is the still, final picture. Motion is added after mount, only when `prefers-reduced-motion` is not set, so hydration never disagrees.
- Messages ride lines with SVG `animateMotion`, paused while the drawing is off screen.
- A line may draw itself once as it scrolls into view (stroke or scale, under 900ms, ease out). Nothing loops except riding messages.
- Hover and focus transitions 120 to 150ms. No parallax, no scroll-jacking, no smooth-scroll library, no text that fades in.
- Round SVG coordinates (two decimals) and never read the clock or random numbers during render.

## Every section

- One clear idea, said in the heading. Cut anything that does not earn its place.
- The figure is drawn in the map's language, not a screenshot of a dashboard.
- Sample data uses `.example` domains and is labelled as sample in a caption.
- Sample agency and client names are invented and checked against real businesses before use (the home page uses Wistholm IT, Pellowyn Dental, Corriwick Café, Haskerley Law, Ollerbeck Vets, Thrandle Build). No Acme, Contoso, Northwind or other names a real business uses. Real products appear only as the senders they are (Microsoft 365, HubSpot, Xero and so on).
- Figures are open drawings on white with a figure head (bold name, lighter meta, hairline) and a caption, like the hero map. No framed UI mock-ups with fake buttons.
- Visible text never hard-codes "DMARC Harbor": use `brandName(await readHostBrand())`.

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
