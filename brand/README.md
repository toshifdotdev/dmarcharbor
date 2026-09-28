# DMARC Harbor brand directions

Three directions. Each folder is self contained: vector source, app icon,
maskable icon, favicon in several sizes, and a preview strip.

`build.py` is the source of truth for the geometry. `rasterize.mjs` derives
the PNG and ICO fallbacks from the SVG. Edit the paths in `build.py`, not
the generated files.

## 01-beacon The Beacon — Maritime, distinctive

A harbour light doing the one thing a harbour light does. The beam fades like light rather than sitting there like a bar.

**Best when:** Wants the brand to feel like a product with a point of view, not a utility.

## 02-swell Swell — Analytical, clean

Tall bars over a measured baseline, with a wave under them. Bars alone read as a trend, the wave alone reads as a sea, and the baseline stops them floating. Either half on its own would be generic.

**Best when:** Wants the product to read as data and reporting first.

## 03-watch The Watch — Monitoring, active

A radar scope on a horizon, with a contact on it. The first attempt was concentric arcs, which came out looking exactly like a wifi icon, so it became a scope with a sweep and a blip, which is both more maritime and more honest about what the product does.

**Best when:** Wants to sell detection and vigilance rather than reporting.

## Palette

| Role | Hex | Used for |
|---|---|---|
| Ink | `#0B1F33` | Wordmark, tower, horizon |
| Deep | `#0E4A66` | Secondary mark colour, gradients |
| Teal | `#137A9B` | Primary accent, water |
| Teal light | `#5FB6CE` | Water highlight, weakest arc |
| Amber | `#F2A33C` | Focal point, and breach state in the product |
| Foam | `#F5F9FB` | Surfaces |

## Still to do before this is final

- The wordmark is set in a system font stack. It must be outlined to paths
  before it goes on anything that cannot rely on the font being present.
- Dark mode mark, where amber and teal both need a contrast check.
- A one colour variant for fax, invoices and any single ink print.
