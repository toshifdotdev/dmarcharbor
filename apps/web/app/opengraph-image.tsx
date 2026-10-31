import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { rounded, type Pt } from "@/components/harbor/landing-geometry";
import { brandName } from "@/components/harbor/public-frame";
import { readHostBrand } from "@/lib/host-brand";
import { SITE_NAME } from "@/lib/seo";

/**
 * opengraph-image.tsx — the card a link turns into, in the Routes language
 * (.kiro/steering/design-system.md): a white ground, ink type, and one client
 * domain's mail drawn as the home page draws it. Five services ride their
 * coloured lines through the checks to the inbox; the unknown sender, dashed
 * red, is turned away at p=reject.
 *
 * Built with satori, so flexbox and absolute positioning only. The map is an
 * inline SVG with no text in it (satori's SVG path has no fonts); every label
 * is a positioned box over it. Colours are spelled out because satori has no
 * stylesheet to resolve tokens from.
 *
 * The face is Albert Sans, the site's one family, read from app/_og (SIL Open
 * Font License, OFL.txt beside the files). If the files cannot be read, the
 * card still renders in satori's default face rather than failing.
 *
 * On an agency's verified domain the card carries the agency's name and no
 * product mark, as every page there does.
 */

export const alt = `${SITE_NAME}: every sender, mapped. DMARC monitoring for MSPs and agencies.`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#15171b";
const INK_2 = "#41454d";
const INK_3 = "#6c717a";
const RED = "#d9342b";
const SANS = "Albert Sans";

async function loadFonts() {
  try {
    const dir = join(process.cwd(), "app", "_og");
    const [medium, bold] = await Promise.all([
      readFile(join(dir, "AlbertSans-Medium.ttf")),
      readFile(join(dir, "AlbertSans-Bold.ttf")),
    ]);
    return [
      { name: SANS, data: medium, weight: 500 as const, style: "normal" as const },
      { name: SANS, data: bold, weight: 700 as const, style: "normal" as const },
    ];
  } catch {
    return undefined;
  }
}

/* ── The map, in its own 480 × 420 box ─────────────────────────────────── */

const X0 = 18;
const END = 440;
const D = 11 * Math.SQRT2;

function bend(y0: number, yb: number, diagStart: number): Pt[] {
  const run = Math.abs(yb - y0);
  return [
    [X0, y0],
    [diagStart, y0],
    [diagStart + run, yb],
    [END, yb],
  ];
}

const LINES: Array<{ name: string; color: string; y0: number; points: Pt[]; below?: boolean }> = [
  { name: "Microsoft 365", color: "#1f5fd6", y0: 36, points: bend(36, 142, 110) },
  { name: "HubSpot", color: "#f07c1b", y0: 100, points: bend(100, 153, 110 + 64 - D) },
  { name: "Xero", color: "#13a050", y0: 164, points: [[X0, 164], [END, 164]] },
  { name: "Mailchimp", color: "#f2b705", y0: 228, points: bend(228, 175, 110 + 64 - D), below: true },
  { name: "Zendesk", color: "#8a3fd1", y0: 292, points: bend(292, 186, 110), below: true },
];

/** The unknown sender: up to run under the trunk, fails at the first station,
 *  turned away to the refused bar. */
const FORGED: Pt[] = [
  [X0, 380],
  [402 + D - 380, 380],
  [402 + D - 197, 197],
  [296, 197],
  [389, 290],
  [402, 290],
];

function RouteMap() {
  return (
    <div style={{ position: "relative", display: "flex", width: 480, height: 420 }}>
      <svg width="480" height="420" viewBox="0 0 480 420" fill="none">
        {LINES.map((l) => (
          <path key={l.name} d={rounded(l.points, 14)} stroke={l.color} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        <path d={rounded(FORGED, 14)} stroke={RED} strokeWidth={7} strokeDasharray="10 7" strokeLinejoin="round" />
        {LINES.map((l) => (
          <circle key={`o-${l.name}`} cx={X0} cy={l.y0} r={6.5} fill="#ffffff" stroke={INK} strokeWidth={3} />
        ))}
        <circle cx={X0} cy={380} r={6.5} fill="#ffffff" stroke={RED} strokeWidth={3} />
        {/* Stations across every line that stops there, and the inbox. */}
        <rect x={268} y={128} width={24} height={82} rx={12} fill="#ffffff" stroke={INK} strokeWidth={3} />
        <rect x={348} y={128} width={24} height={72} rx={12} fill="#ffffff" stroke={INK} strokeWidth={3} />
        <rect x={424} y={124} width={32} height={80} rx={16} fill="#ffffff" stroke={INK} strokeWidth={3} />
        <path d="M275.5 192.5 L284.5 201.5 M284.5 192.5 L275.5 201.5" stroke={RED} strokeWidth={2.6} strokeLinecap="round" />
        <rect x={404} y={277} width={5} height={26} rx={1.5} fill={RED} />
      </svg>

      {LINES.map((l) => (
        <Label key={`t-${l.name}`} left={4} top={l.below ? l.y0 + 14 : l.y0 - 34} name={l.name} />
      ))}
      <Label left={4} top={394} name="Unknown sender" red />
      <Label left={230} top={96} width={100} center name="SPF · DKIM" />
      <Label left={310} top={96} width={100} center name="Aligned" />
      <Label left={390} top={96} width={100} center name="Inbox" />
      <div style={{ position: "absolute", left: 420, top: 274, display: "flex", flexDirection: "column" }}>
        <span style={{ color: RED, fontSize: 16, fontWeight: 700, fontFamily: SANS }}>Rejected</span>
        <span style={{ color: INK_3, fontSize: 14, fontWeight: 500, fontFamily: SANS }}>at p=reject</span>
      </div>
    </div>
  );
}

function Label({
  left,
  top,
  name,
  width,
  center,
  red,
}: {
  left: number;
  top: number;
  name: string;
  width?: number;
  center?: boolean;
  red?: boolean;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        // satori rejects a style value of undefined, so width is only set when given.
        ...(width ? { width } : {}),
        display: "flex",
        justifyContent: center ? "center" : "flex-start",
        color: red ? RED : INK,
        fontSize: 16,
        fontWeight: 700,
        fontFamily: SANS,
      }}
    >
      {name}
    </div>
  );
}

export default async function OpengraphImage() {
  const [fonts, brand] = await Promise.all([loadFonts(), readHostBrand()]);
  const name = brandName(brand);
  const showMark = brand.state !== "verified";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "stretch",
          justifyContent: "space-between",
          background: "#ffffff",
          padding: "60px 64px 56px 72px",
          fontFamily: SANS,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 540 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, color: INK }}>
            {showMark ? (
              <svg width="34" height="34" viewBox="0 0 512 512" fill="none">
                <rect x="120" y="88" width="84" height="336" rx="18" fill={INK} />
                <rect x="308" y="88" width="84" height="336" rx="18" fill={INK} />
                <path
                  d="M162 252 C 196 206, 236 206, 256 252 C 276 298, 316 298, 350 252"
                  stroke={INK}
                  strokeWidth="44"
                  strokeLinecap="round"
                />
              </svg>
            ) : null}
            <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: -0.3 }}>{name}</span>
          </div>

          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ color: INK, fontSize: 76, fontWeight: 700, lineHeight: 0.98, letterSpacing: -2.6 }}>
              Every sender, mapped.
            </div>
            <div style={{ marginTop: 26, color: INK_2, fontSize: 25, fontWeight: 500, lineHeight: 1.42, maxWidth: 520 }}>
              DMARC monitoring for MSPs and agencies. Name the real senders; the rest is turned away at p=reject.
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-start" }}>
          <RouteMap />
          <div style={{ marginTop: 18, color: INK_3, fontSize: 15, fontWeight: 500 }}>Sample routes for one client domain</div>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
