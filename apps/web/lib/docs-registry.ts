/**
 * docs-registry.ts — the developer documents published under /docs.
 *
 * Kept apart from legal-docs.ts on purpose. A legal document carries the legal
 * set's version and effective date, because an acceptance record points at
 * it; the API reference carries an API version and changes whenever the API
 * gains a route. Mixing the two would put an effective date on the API
 * reference and an API version on the DPA.
 *
 * The body of each document is a FILE under docs/, exactly like the legal set,
 * so the published page and the file in the repository are one text. A file
 * that cannot be read throws rather than rendering a placeholder: a reference
 * page that silently says nothing is worse than a failed build.
 *
 * IMAGES. A document can show a screenshot with a line of its own:
 *
 *   ![The API keys screen with one live key](/docs-media/api-keys.png "Settings, API keys")
 *
 * The quoted title is the caption (the alt text is, when there is no title).
 * Put the file under apps/web/public and write its path from the site root.
 * Its width and height are read from the file here (PNG, JPEG, GIF and WebP),
 * so the page reserves the right height before it loads. An SVG, a remote
 * image or a file that cannot be read can state its size instead:
 * `{width=1440 height=900}` straight after the closing bracket. Without
 * either, the image sits in a fixed 16:10 frame, so nothing below it moves.
 *
 * No imports through the "@/" alias, so the unit tests can load this file.
 */

import { readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { imageSources } from "../components/harbor/legal-markdown";

export interface ImageSize {
  width: number;
  height: number;
}

export interface DeveloperDoc {
  slug: string;
  /** The page's address. */
  path: string;
  title: string;
  /** File under docs/ whose markdown is the body. */
  sourceFile: string;
  /** One sentence, for the description tag. */
  summary: string;
  /** The API version the document describes. */
  version: string;
  /** The path every request starts with. */
  basePath: string;
}

export const DEVELOPER_DOCS: DeveloperDoc[] = [
  {
    slug: "api",
    path: "/docs/api",
    title: "API reference",
    sourceFile: "API.md",
    summary:
      "The /api/v1 reference for MSPs and agencies: keys, rate limits, errors, every endpoint with examples, signed webhooks and recipes for PSA and billing automation.",
    version: "v1",
    basePath: "/api/v1",
  },
];

/** What sits beside a developer document in its index: the reference, and the
 *  public pages an integrator reads with it. */
export const DEVELOPER_INDEX: Array<{ href: string; title: string }> = [
  ...DEVELOPER_DOCS.map((d) => ({ href: d.path, title: d.title })),
  { href: "/guide", title: "Setup guide" },
  { href: "/faq", title: "Frequently Asked Questions" },
  { href: "/support", title: "Support and contact" },
];

export const DEVELOPER_BY_SLUG = new Map(DEVELOPER_DOCS.map((d) => [d.slug, d]));

export function developerDoc(slug: string): DeveloperDoc | undefined {
  return DEVELOPER_BY_SLUG.get(slug);
}

function docsDir(): string {
  return join(process.cwd(), "..", "..", "docs");
}

function publicDir(): string {
  return join(process.cwd(), "public");
}

/** The markdown, and the intrinsic size of every local image it shows. */
export function developerDocBody(doc: DeveloperDoc): { text: string; images: Record<string, ImageSize> } {
  const file = join(docsDir(), doc.sourceFile);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    throw new Error(
      `Developer document "${doc.slug}" declares sourceFile "${doc.sourceFile}" and it could not be read ` +
        `(looked in ${file}). Ship docs/ with the build.`,
      { cause },
    );
  }

  return { text, images: localImageSizes(text) };
}

/** The intrinsic size of every local image a markdown text shows. Used for the
 *  legal set too (the setup guide and the FAQ carry screenshots). */
export function localImageSizes(text: string): Record<string, ImageSize> {
  const images: Record<string, ImageSize> = {};
  for (const src of imageSources(text)) {
    const size = localImageSize(src);
    if (size) images[src] = size;
  }
  return images;
}

/** The size of an image under public/, or null when it is not one we can read. */
function localImageSize(src: string): ImageSize | null {
  if (!/^\/(?!\/)/.test(src)) return null;
  const root = publicDir();
  try {
    const path = normalize(join(root, decodeURIComponent(src.split(/[?#]/)[0]!)));
    // Never read outside public/, whatever the markdown says.
    if (!path.startsWith(root + sep)) return null;
    return imageSize(readFileSync(path));
  } catch {
    return null;
  }
}

/**
 * Width and height from an image file's header, for PNG, GIF, JPEG and WebP.
 * Reads only the header bytes; anything else answers null.
 */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ok = (width: number, height: number): ImageSize | null =>
    width > 0 && height > 0 ? { width, height } : null;

  // PNG: the IHDR chunk follows the 8-byte signature.
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("ascii", 12, 16) === "IHDR") {
    return ok(b.readUInt32BE(16), b.readUInt32BE(20));
  }

  // GIF: logical screen size, little-endian.
  if (b.length >= 10 && (b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a")) {
    return ok(b.readUInt16LE(6), b.readUInt16LE(8));
  }

  // WebP: RIFF....WEBP, then a VP8, VP8L or VP8X chunk.
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    if (chunk === "VP8L") {
      const b0 = b[21]!;
      const b1 = b[22]!;
      const b2 = b[23]!;
      const b3 = b[24]!;
      return ok(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
    }
    if (chunk === "VP8X") return ok(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
    return null;
  }

  // JPEG: walk the segments to the first start-of-frame marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1]!;
      // Fill bytes, and markers that stand alone with no length.
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return ok(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
      i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  }

  return null;
}
