#!/usr/bin/env python3
"""
Generates the DMARC Harbor brand marks.

Three directions, each drawn as real geometry so they can be compared honestly
at 16 pixels, which is where a logo either survives or turns to mush.

Every mark sits on the same 64 unit grid and shares one optical stroke weight,
so the set reads as a family. Colours are defined once and referenced, so a
palette change lands everywhere at once.

Palette rationale: deep navy ink, a teal that leans toward the sea rather than
toward generic corporate blue, and a beacon amber that does actual work. Amber
is the lamp in concept one and the focal bar in concept two, and it is the
colour a breach renders in elsewhere in the product. Most tools in this space
are blue and green or blue and purple; amber on navy is honestly maritime and
carries meaning instead of just decorating.

Run: python brand/build.py
"""

import os

ROOT = os.path.dirname(os.path.abspath(__file__))

INK = "#0B1F33"
DEEP = "#0E4A66"
TEAL = "#137A9B"
TEAL_LIGHT = "#5FB6CE"
AMBER = "#F2A33C"
AMBER_LIGHT = "#FFD79A"
FOAM = "#F5F9FB"

WORDMARK_STACK = (
    "ui-sans-serif, -apple-system, 'Segoe UI', Inter, Roboto, 'Helvetica Neue', Arial, sans-serif"
)


def svg(width, height, body, title=""):
    head = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" role="img"'
    if title:
        head += f' aria-label="{title}"'
    return head + ">\n" + body + "\n</svg>\n"


# ---------------------------------------------------------------------------
# 1. The Beacon
#
# A harbour light doing the one thing a harbour light does. The beam is a wedge
# that fades rather than a bar, because a bar reads as a graphic element and a
# fading wedge reads as light. That single change is what makes the mark
# legible as a lighthouse instead of as an orange rectangle.
#
# The tower is short and wide on purpose. A realistic slender lighthouse is
# beautiful at 200 pixels and an unreadable grey smear at 16.
# ---------------------------------------------------------------------------

BEACON_FULL = f"""
  <defs>
    <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="{AMBER}" stop-opacity="0.95"/>
      <stop offset="1" stop-color="{AMBER}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M31 13.5 56 4v21z" fill="url(#beam)"/>
    <path d="M31 20.5 50 13.5v11z" fill="url(#beam)" opacity="0.5"/>
  </g>
  <!-- lamp room -->
  <rect x="22.5" y="20" width="17" height="9" rx="2.5" fill="{AMBER}"/>
  <rect x="20" y="27" width="22" height="4.5" rx="2.2" fill="{DEEP}"/>
  <!-- tower, tapered -->
  <path d="M23.5 31.5 21 48h20l-2.5-16.5z" fill="{INK}"/>
  <path d="M31 31.5 28.8 48h4.4L31 31.5z" fill="{DEEP}" opacity="0.55"/>
  <!-- water -->
  <path d="M8 52.5c4.2-3.6 8.4-3.6 12.6 0s8.4 3.6 12.6 0 8.4-3.6 12.6 0 8.4 3.6 12.6 0"
        stroke="{TEAL}" stroke-width="5"/>
  <path d="M14 59.5c3.6-2.9 7.2-2.9 10.8 0s7.2 2.9 10.8 0 7.2-2.9 10.8 0"
        stroke="{TEAL_LIGHT}" stroke-width="3.4" opacity="0.75"/>
"""

# At 16 pixels the second wave is three pixels of noise, so it is dropped and the
# tower is widened. A favicon is not the logo shrunk, it is a redrawn logo.
BEACON_SMALL = f"""
  <defs>
    <linearGradient id="beams" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="{AMBER}" stop-opacity="0.95"/>
      <stop offset="1" stop-color="{AMBER}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <path d="M33 16 58 7v20z" fill="url(#beams)"/>
  <rect x="24" y="24" width="18" height="9" rx="2.5" fill="{AMBER}"/>
  <rect x="21" y="31" width="24" height="5" rx="2.5" fill="{DEEP}"/>
  <path d="M24 36 21.5 50h21L40 36z" fill="{INK}"/>
  <path d="M9 55c4.4-3.8 8.8-3.8 13.2 0s8.8 3.8 13.2 0 8.8-3.8 13.2 0 5 2.2 6.6 1"
        stroke="{TEAL}" stroke-width="5.5" fill="none" stroke-linecap="round"/>
"""


# ---------------------------------------------------------------------------
# 2. Swell
#
# Three bars that read as a trend, over a wave that makes them read as a sea.
# The bars alone were too close to every analytics product on the internet, and
# the wave alone was too close to every fintech. Together they are neither.
#
# The tallest bar is the amber one, so there is a focal point and the eye lands
# on the same element in every size.
# ---------------------------------------------------------------------------

SWELL_FULL = f"""
  <!-- a baseline, so the bars read as measured against something rather than floating -->
  <path d="M8 44.5h48" stroke="{INK}" stroke-width="3" stroke-linecap="round" opacity="0.85"/>
  <g stroke-linecap="round" fill="none">
    <path d="M16 42V30" stroke="{TEAL}" stroke-width="8.5"/>
    <path d="M32 42V19" stroke="{DEEP}" stroke-width="8.5"/>
    <path d="M48 42V8" stroke="{AMBER}" stroke-width="8.5"/>
  </g>
  <path d="M6 51c5-4 10-4 15 0s10 4 15 0 10-4 15 0"
        stroke="{TEAL}" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.55"/>
  <path d="M12 58c4.2-3.2 8.4-3.2 12.6 0s8.4 3.2 12.6 0 8.4-3.2 12.6 0"
        stroke="{TEAL_LIGHT}" stroke-width="3.2" fill="none" stroke-linecap="round" opacity="0.85"/>
"""

SWELL_SMALL = f"""
  <path d="M7 39h50" stroke="{INK}" stroke-width="3.5" stroke-linecap="round"/>
  <g stroke-linecap="round" fill="none">
    <path d="M15 37V27" stroke="{TEAL}" stroke-width="9"/>
    <path d="M32 37V18" stroke="{DEEP}" stroke-width="9"/>
    <path d="M49 37V8" stroke="{AMBER}" stroke-width="9"/>
  </g>
  <path d="M6 47c5-4 10-4 15 0s10 4 15 0 10-4 15 0"
        stroke="{TEAL_LIGHT}" stroke-width="4.5" fill="none" stroke-linecap="round" opacity="0.9"/>
"""


# ---------------------------------------------------------------------------
# 3. The Watch
#
# A sweep going out over a horizon. This is the monitoring half of the product
# stated as a picture: something is out there, something is watching for it, and
# what it finds is worth surfacing.
#
# The arcs are open on the right and the solid is on the left, so the mark has a
# direction of travel, which is what stops it reading as a wifi symbol.
# ---------------------------------------------------------------------------

WATCH_FULL = f"""
  <defs>
    <linearGradient id="sweep" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="{AMBER}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="{AMBER}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <!-- the scope -->
  <circle cx="32" cy="27" r="20" fill="none" stroke="{TEAL}" stroke-width="4.5" opacity="0.9"/>
  <!-- the sweep, trailing behind the leading edge -->
  <path d="M32 27 48.4 15.5A20 20 0 0 1 41.4 9.3z" fill="url(#sweep)"/>
  <path d="M32 27 48.4 15.5" stroke="{AMBER}" stroke-width="4.5" stroke-linecap="round"/>
  <!-- a contact, which is the entire point of a scope -->
  <circle cx="44.1" cy="20" r="4.5" fill="{AMBER}"/>
  <!-- horizon, so the scope is sitting on the sea rather than in a void -->
  <path d="M6 56h52" stroke="{INK}" stroke-width="5" stroke-linecap="round"/>
  <path d="M13 62c4-3.2 8-3.2 12 0s8 3.2 12 0 8-3.2 12 0"
        stroke="{TEAL_LIGHT}" stroke-width="3.2" fill="none" stroke-linecap="round" opacity="0.8"/>
"""

WATCH_SMALL = f"""
  <defs>
    <linearGradient id="sweeps" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="{AMBER}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="{AMBER}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <circle cx="32" cy="27" r="20" fill="none" stroke="{TEAL}" stroke-width="5"/>
  <path d="M32 27 48.4 15.5A20 20 0 0 1 41.4 9.3z" fill="url(#sweeps)"/>
  <path d="M32 27 48.4 15.5" stroke="{AMBER}" stroke-width="5" stroke-linecap="round"/>
  <circle cx="44.1" cy="20" r="5" fill="{AMBER}"/>
  <path d="M6 55h52" stroke="{INK}" stroke-width="5.5" stroke-linecap="round"/>
"""


CONCEPTS = {
    "01-beacon": {
        "title": "The Beacon",
        "mark": BEACON_FULL,
        "mark_small": BEACON_SMALL,
        "tag": "Maritime, distinctive",
        "note": "A harbour light doing the one thing a harbour light does. The beam fades like light rather than sitting there like a bar.",
        "for": "Wants the brand to feel like a product with a point of view, not a utility.",
    },
    "02-swell": {
        "title": "Swell",
        "mark": SWELL_FULL,
        "mark_small": SWELL_SMALL,
        "tag": "Analytical, clean",
        "note": "Tall bars over a measured baseline, with a wave under them. Bars alone read as a trend, the wave alone reads as a sea, and the baseline stops them floating. Either half on its own would be generic.",
        "for": "Wants the product to read as data and reporting first.",
    },
    "03-watch": {
        "title": "The Watch",
        "mark": WATCH_FULL,
        "mark_small": WATCH_SMALL,
        "tag": "Monitoring, active",
        "note": "A radar scope on a horizon, with a contact on it. The first attempt was concentric arcs, which came out looking exactly like a wifi icon, so it became a scope with a sweep and a blip, which is both more maritime and more honest about what the product does.",
        "for": "Wants to sell detection and vigilance rather than reporting.",
    },
}


def lockup(mark_body, label):
    """Mark and wordmark, for headers, documents and email signatures."""
    text_w = int(len(label) * 20.5) + 24
    width = 64 + 20 + text_w
    return width, 64, f"""
  <g>{mark_body}  </g>
  <text x="84" y="40" font-family="{WORDMARK_STACK}" font-size="30" font-weight="650"
        letter-spacing="-0.6" fill="{INK}">{label}</text>
  <text x="85" y="53" font-family="{WORDMARK_STACK}" font-size="10" font-weight="600"
        letter-spacing="3.2" fill="{TEAL}">DMARC MONITORING</text>
"""


def app_icon(mark_body):
    """The mark on a rounded navy tile, which is how it appears installed."""
    return f"""
  <rect width="512" height="512" rx="116" fill="{INK}"/>
  <g transform="translate(140 140) scale(3.62)">{mark_body}</g>
"""


def maskable_icon(mark_body):
    """
    The safe zone variant.

    A maskable icon is cropped to a circle by the platform, so the mark is scaled
    into the middle 80 percent. Without this the beacon loses its water on an
    Android home screen.
    """
    return f"""
  <rect width="512" height="512" fill="{INK}"/>
  <g transform="translate(158 158) scale(3.06)">{mark_body}</g>
"""


def write(path, content):
    full = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)


def main():
    for folder, spec in CONCEPTS.items():
        write(f"{folder}/mark.svg", svg(64, 64, spec["mark"], spec["title"]))
        write(f"{folder}/mark-small.svg", svg(64, 64, spec["mark_small"], spec["title"]))
        write(f"{folder}/favicon.svg", svg(64, 64, spec["mark_small"], spec["title"]))

        w, h, body = lockup(spec["mark"], "DMARC Harbor")
        write(f"{folder}/logo-horizontal.svg", svg(w, h, body, "DMARC Harbor"))

        w2, h2, body2 = lockup(spec["mark_small"], "DMARC Harbor")
        write(f"{folder}/logo-horizontal-compact.svg", svg(w2, h2, body2, "DMARC Harbor"))

        write(f"{folder}/icon.svg", svg(512, 512, app_icon(spec["mark"]), "DMARC Harbor"))
        write(f"{folder}/icon-maskable.svg", svg(512, 512, maskable_icon(spec["mark"]), "DMARC Harbor"))

    readme = ["# DMARC Harbor brand directions", ""]
    readme.append("Three directions. Each folder is self contained: vector source, app icon,")
    readme.append("maskable icon, favicon in several sizes, and a preview strip.")
    readme.append("")
    readme.append("`build.py` is the source of truth for the geometry. `rasterize.mjs` derives")
    readme.append("the PNG and ICO fallbacks from the SVG. Edit the paths in `build.py`, not")
    readme.append("the generated files.")
    readme.append("")
    for folder, spec in CONCEPTS.items():
        readme.append(f"## {folder} {spec['title']} — {spec['tag']}")
        readme.append("")
        readme.append(spec["note"])
        readme.append("")
        readme.append(f"**Best when:** {spec['for']}")
        readme.append("")

    readme.append("## Palette")
    readme.append("")
    readme.append("| Role | Hex | Used for |")
    readme.append("|---|---|---|")
    readme.append(f"| Ink | `{INK}` | Wordmark, tower, horizon |")
    readme.append(f"| Deep | `{DEEP}` | Secondary mark colour, gradients |")
    readme.append(f"| Teal | `{TEAL}` | Primary accent, water |")
    readme.append(f"| Teal light | `{TEAL_LIGHT}` | Water highlight, weakest arc |")
    readme.append(f"| Amber | `{AMBER}` | Focal point, and breach state in the product |")
    readme.append(f"| Foam | `{FOAM}` | Surfaces |")
    readme.append("")
    readme.append("## Still to do before this is final")
    readme.append("")
    readme.append("- The wordmark is set in a system font stack. It must be outlined to paths")
    readme.append("  before it goes on anything that cannot rely on the font being present.")
    readme.append("- Dark mode mark, where amber and teal both need a contrast check.")
    readme.append("- A one colour variant for fax, invoices and any single ink print.")
    readme.append("")

    write("README.md", "\n".join(readme))
    print("wrote", ", ".join(CONCEPTS), "and README.md")


if __name__ == "__main__":
    main()
