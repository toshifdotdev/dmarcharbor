import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { contrastInk, HEX } from "@/lib/brand-vars";
import { readHostBrand } from "@/lib/host-brand";

export const dynamic = "force-dynamic";

/**
 * The tab and app icons on an agency's verified domain.
 *
 * The favicon, the iOS icon and the install icons are static files, and they
 * are our Pier mark, so a client on the agency's own address saw our H in the
 * browser tab and on a home screen: the one place the custom domain still
 * named the vendor. proxy.ts sends those requests here on a verified agency
 * host only; our own host and unverified hosts keep the static files.
 *
 * The icon is the agency's initial on a tile in its brand colour, with the
 * text colour it chose (or black or white, whichever reads), the same pair the
 * portal's buttons use. Never the uploaded logo: a logo is rarely square and
 * is unreadable at 16 pixels, and an initial is what every tab bar expects.
 * A name with no Latin letter or digit to take gets the plain tile.
 *
 * The shape is in the path, /brand-icon/<size>-<shape>-<format>, because a
 * route reached through a proxy rewrite does not see the rewrite's query
 * string (the first version read ?size= and drew every icon at 32 pixels):
 *
 *   size     16 to 512
 *   shape    tab: rounded, as the browser tab icon is; bleed: full bleed,
 *            because launchers apply their own mask; mask: full bleed with
 *            the initial inside Android's round safe zone
 *   format   png, or svg: an SVG wrapping the image, for /icon.svg
 */

const INK = "#15171b";

let font: Promise<Buffer | null> | null = null;
function albertSansBold(): Promise<Buffer | null> {
  font ??= readFile(join(process.cwd(), "app", "_og", "AlbertSans-Bold.ttf")).catch(() => null);
  return font;
}

function initialOf(name: string): string | null {
  const match = /[A-Za-z0-9]/.exec(name);
  return match ? match[0].toUpperCase() : null;
}

async function render(size: number, options: { tab: boolean; maskable: boolean; tile: string; ink: string; letter: string | null }) {
  const data = await albertSansBold();
  const fontSize = Math.round(size * (options.maskable ? 0.42 : 0.62));
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: options.tile,
          borderRadius: options.tab ? Math.round(size * 0.14) : 0,
          color: options.ink,
          fontFamily: "Albert Sans",
          fontWeight: 700,
          fontSize,
          // Optical centring: capitals sit high in their line box.
          paddingTop: Math.round(fontSize * 0.04),
        }}
      >
        {options.letter ?? ""}
      </div>
    ),
    {
      width: size,
      height: size,
      fonts: data ? [{ name: "Albert Sans", data, weight: 700, style: "normal" }] : undefined,
    },
  );
}

const SPEC = /^(\d{2,3})-(tab|bleed|mask)-(png|svg)$/;

export async function GET(_request: Request, context: { params: Promise<{ spec: string }> }): Promise<Response> {
  const brand = await readHostBrand();
  const spec = SPEC.exec((await context.params).spec);
  // Reached through proxy.ts on a verified agency host. Anywhere else there is
  // no agency to draw, and the static files are the icon.
  if (brand.state !== "verified" || !spec) return new Response(null, { status: 404 });

  const size = Math.min(512, Math.max(16, Number(spec[1])));
  const tab = spec[2] === "tab";
  const maskable = spec[2] === "mask";
  const svgFormat = spec[3] === "svg";

  const tile = brand.primaryColor && HEX.test(brand.primaryColor) ? brand.primaryColor : INK;
  const ink = brand.accentColor && HEX.test(brand.accentColor) ? brand.accentColor : contrastInk(tile);
  const options = { tab, maskable, tile, ink, letter: initialOf(brand.workspaceName) };

  const headers = {
    // A new brand colour shows within the hour; each host is its own address,
    // so a cache never hands one agency's icon to another.
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff",
  };

  if (svgFormat) {
    // The page links /icon.svg as image/svg+xml, so the answer there is an SVG.
    // The initial is set in the product's face, which an SVG favicon cannot
    // load, so the SVG carries the rendered image.
    const png = Buffer.from(await (await render(128, options)).arrayBuffer()).toString("base64");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128"><image href="data:image/png;base64,${png}" width="128" height="128"/></svg>`;
    return new Response(svg, { headers: { ...headers, "content-type": "image/svg+xml" } });
  }

  const image = await render(size, options);
  return new Response(image.body, { headers: { ...headers, "content-type": "image/png" } });
}
