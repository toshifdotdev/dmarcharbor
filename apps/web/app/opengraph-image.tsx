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
const BLOCKING = "#c8442c";

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
        {/* The mark, repeated from app/icon.svg at card scale. */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 34,
              height: 34,
              background: BLOCKING,
              transform: "rotate(45deg)",
            }}
          />
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
