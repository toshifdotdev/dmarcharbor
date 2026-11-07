/**
 * build-icons.mjs — every favicon and app icon, drawn from the one Pier mark.
 *
 *   node brand/build-icons.mjs        (from the repository root)
 *
 * The icons used to be exported by hand from the old dark theme: a #0a0a0a
 * tile, and two different off-whites for the mark (#e6e4dd in the SVG and the
 * .ico, #f2f2f0 in the PNGs). The 180px icon (iOS "Add to Home Screen") was a
 * plain black square with no mark at all. They are now one script, in the
 * Routes palette: an ink tile (#15171b, the ink of every page), the two
 * pilings in two of the map's line colours (blue #1f5fd6 and green #13a050),
 * and the waterline in white. The tile stays dark on purpose: a white tile
 * vanishes in a light browser tab bar, and ink reads in light and dark ones.
 *
 * Geometry is the Pier exactly as brand/pier.svg and components/mark.tsx draw
 * it; on the white page the mark's waterline is ink instead of white. The
 * browser tab icon keeps its rounded tile; the PNGs are full bleed, because
 * every launcher applies its own mask. The maskable icon carries the mark at
 * 0.655 about the centre, inside Android's round safe zone.
 *
 * Writes brand/icons/*, brand/favicon.ico, and the copies the web app serves:
 * apps/web/public/icons/*, apps/web/app/{icon.svg,favicon.ico,apple-icon.png}.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INK = "#15171b";
const WATERLINE = "#ffffff";
const LEFT_PILING = "#1f5fd6";
const RIGHT_PILING = "#13a050";

/** The Pier, in the 512 unit box. */
const PIER = `<rect x="120" y="88" width="84" height="336" rx="18" fill="${LEFT_PILING}"/>
  <rect x="308" y="88" width="84" height="336" rx="18" fill="${RIGHT_PILING}"/>
  <path d="M162 252 C 196 206, 236 206, 256 252 C 276 298, 316 298, 350 252" fill="none" stroke="${WATERLINE}" stroke-width="44" stroke-linecap="round"/>`;

function svg({ rounded, maskable }) {
  const tile = rounded
    ? `<rect width="512" height="512" rx="72" fill="${INK}"/>`
    : `<rect width="512" height="512" fill="${INK}"/>`;
  const mark = maskable ? `<g transform="translate(256 256) scale(0.655) translate(-256 -256)">\n  ${PIER}\n  </g>` : PIER;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">
  <title>DMARC Harbor</title>
  ${tile}
  ${mark}
</svg>
`;
}

async function png(source, size) {
  return sharp(Buffer.from(source), { density: Math.max(72, Math.ceil((72 * size) / 512) * 4) })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** A .ico holding PNG images, which every current browser reads. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

function write(relative, data) {
  const path = join(ROOT, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.log(`wrote ${relative} (${data.length} bytes)`);
}

const tab = svg({ rounded: true, maskable: false });
const bleed = svg({ rounded: false, maskable: false });
const maskable = svg({ rounded: false, maskable: true });

const sizes = [16, 32, 48, 180, 192, 512];
const pngs = {};
for (const size of sizes) pngs[size] = await png(bleed, size);
const maskablePng = await png(maskable, 512);
// The tab icon's own rasters, rounded like the SVG, for the .ico.
const tabPngs = await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(tab, size) })));
const favicon = ico(tabPngs);

for (const dir of ["brand/icons", "apps/web/public/icons"]) {
  for (const size of sizes) write(`${dir}/icon-${size}.png`, pngs[size]);
  write(`${dir}/maskable-512.png`, maskablePng);
}
write("brand/favicon.ico", favicon);
write("apps/web/app/favicon.ico", favicon);
write("apps/web/app/icon.svg", Buffer.from(tab));
write("apps/web/app/apple-icon.png", pngs[180]);
