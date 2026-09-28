/**
 * Rasterises the brand SVGs into the formats a browser and an operating system
 * actually ask for.
 *
 * SVG is the source of truth, but a favicon is still requested as .ico by some
 * clients, Apple touch icons must be PNG, and nothing in a Next.js app should
 * depend on a browser resolving an SVG favicon correctly. So the vector files
 * are authored by hand and these are derived from them, rather than the other
 * way round, which would leave the real logo trapped in a build step.
 *
 * Run with: node brand/rasterize.mjs
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.dirname(fileURLToPath(import.meta.url));

// Sizes that are genuinely requested. 16 and 32 for the tab, 180 for an iOS home
// screen, 192 and 512 for PWA manifest and Android.
const SIZES = [16, 32, 48, 180, 192, 512];

async function png(svgPath, outPath, size) {
  await sharp(svgPath, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
}

/**
 * Builds a .ico by hand.
 *
 * The format is a six byte header, a sixteen byte directory entry per image,
 * then the PNG payloads. Only the sizes Windows and browsers ask for are
 * included; a 512 pixel icon in a favicon is wasted bytes, and the .ico
 * container has a hard practical ceiling.
 */
async function ico(svgPath, outPath) {
  const sizes = [16, 32, 48];
  const payloads = [];

  for (const size of sizes) {
    payloads.push(
      await sharp(svgPath, { density: 384 })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer(),
    );
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);

  const directory = Buffer.alloc(16 * sizes.length);
  let offset = header.length + directory.length;

  sizes.forEach((size, index) => {
    const at = index * 16;
    // 256 is encoded as 0, which is why a 256px entry would need care here.
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2); // palette size
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(payloads[index].length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += payloads[index].length;
  });

  await writeFile(outPath, Buffer.concat([header, directory, ...payloads]));
}

const concepts = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d\d-/.test(entry.name))
  .map((entry) => entry.name);

for (const concept of concepts) {
  const dir = path.join(root, concept);
  const favicon = path.join(dir, 'favicon.svg');
  const icon = path.join(dir, 'icon.svg');
  const maskable = path.join(dir, 'icon-maskable.svg');

  for (const size of SIZES) {
    await png(favicon, path.join(dir, `favicon-${size}.png`), size);
  }

  await ico(favicon, path.join(dir, 'favicon.ico'));
  await png(icon, path.join(dir, 'icon-512.png'), 512);
  await png(icon, path.join(dir, 'icon-192.png'), 192);
  await png(maskable, path.join(dir, 'icon-maskable-512.png'), 512);

  // A preview strip so the three can be compared side by side at real size.
  if (existsSync(path.join(dir, 'mark.svg'))) {
    await sharp(path.join(dir, 'logo-horizontal.svg'), { density: 300 })
      .resize({ width: 720 })
      .png()
      .toFile(path.join(dir, 'preview.png'));
  }

  console.log('rasterised', concept);
}

console.log('done');
