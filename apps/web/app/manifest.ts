import type { MetadataRoute } from "next";

/**
 * manifest.ts — the install surface.
 *
 * The icons are the brand's own files, copied verbatim into public/icons/ rather
 * than redrawn. `brand/icons/` ships a real set at 16, 32, 48, 180, 192, 512 and
 * a maskable 512, and the tab icon (`app/icon.svg`) is already the Pier mark, so
 * the only thing missing was a manifest pointing at them. Redrawing any of them
 * here would create a second mark, which is the mistake this repo has already
 * made once.
 *
 * The maskable entry is separate and deliberate. Android crops a maskable icon
 * to whatever shape the device's launcher uses, so it needs its own safe zone;
 * pointing the launcher at the plain 512 makes the Pier's pilings fall outside
 * the crop on a circular launcher.
 *
 * Absolute paths, not URLs. public/ is served by the same build on the product
 * domain and on every agency's custom domain, so `/icons/...` resolves against
 * whichever host installed it. An absolute URL would claim a single host.
 *
 * `theme_color` is the Monolith ground (#0a0a0a, `--color-bg` in
 * app/globals.css), not the accent hue: it colours the status bar and splash,
 * and the product's own rule is that Monolith owns no hue.
 */

const BONE = "#0a0a0a";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "DMARC Harbor",
    short_name: "DMARC",
    description:
      "Per-domain DMARC posture, compliance packs with a published fingerprint, and a client portal in your brand. Measurement and evidence, never control.",
    // The marketing route, not /sign-in. An install opens the product and finds
    // its own way to a session, the same way a browser does.
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: BONE,
    theme_color: BONE,
    // Autorotate rather than portrait: this is read on a desktop as often as a
    // phone, and a portrait lock on a desktop install is a broken window.
    orientation: "any",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        // Its own safe zone, as described above.
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    // No shortcuts. Every route they would open is behind a session, so a
    // shortcut that lands on a login is worse than no shortcut at all.
    categories: ["business", "security", "productivity"],
  };
}
