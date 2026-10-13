import { ImageResponse } from "next/og";
import { SITE_OG_DESCRIPTION, SITE_NAME } from "@/lib/seo";

/**
 * opengraph-image.tsx — the card a link turns into.
 *
 * Every route that does not declare its own gets this one, which is what makes
 * a pasted link in Slack or a search result preview into something rather than
 * a blank rectangle.
 *
 * Built with satori, which means flexbox only and no CSS grid: the layout is
 * one column because that is what the renderer can do, not because a card
 * cannot hold two columns of type.
 *
 * The colours are the Monolith tokens spelled out rather than referenced.
 * Satori resolves CSS custom properties from the document it is given, and this
 * document is a React tree with no stylesheet behind it.
 */

export const alt = `${SITE_NAME} — DMARC email-authentication monitoring`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Bone, ink and the one saturated hue, from app/globals.css.
const BONE = "#f2f2f0";
const INK = "#0a0a0a";
const INK_2 = "#a3a3a1";
// The elevated-surface token from app/globals.css: the square the mark sits in
// is the same surface a card uses everywhere else in the product.
const ELEVATE = "#161616";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const SANS = "system-ui, -apple-system, Segoe UI, sans-serif";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: INK,
          padding: "72px 80px",
        }}
      >
        {/* The brand mark, in the treatment the brand assets actually specify:
            the Pier inside a rounded square, not a bare H. app/icon.svg and
            brand/pier.svg agree on that, and a mark on transparent reads as a
            different mark — it looked like a bare H, which is what it is drawn
            as but not what it is shipped as. */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 9,
              background: ELEVATE,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="34" height="34" viewBox="0 0 512 512" fill="none">
              <rect x="120" y="88" width="84" height="336" rx="18" fill={BONE} />
              <rect x="308" y="88" width="84" height="336" rx="18" fill={BONE} />
              <path
                d="M162 252 C 196 206, 236 206, 256 252 C 276 298, 316 298, 350 252"
                stroke={BONE}
                strokeWidth="44"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div style={{ color: BONE, fontSize: 22, fontWeight: 600, letterSpacing: "0.14em", fontFamily: MONO }}>
            DMARC HARBOR
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              color: BONE,
              fontSize: 68,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: "-0.03em",
              fontFamily: SANS,
              maxWidth: 900,
            }}
          >
            Measurement and evidence, never control.
          </div>
          <div
            style={{
              color: INK_2,
              fontSize: 28,
              lineHeight: 1.4,
              fontFamily: SANS,
              maxWidth: 860,
            }}
          >
            {SITE_OG_DESCRIPTION}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
