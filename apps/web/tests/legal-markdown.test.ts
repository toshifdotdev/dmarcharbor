import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  INLINE_SPLIT,
  LINK_TOKEN,
  parseBlocks,
  parseImageLine,
  safeHref,
  safeImageSrc,
  slugify,
  splitEndpoint,
  uniqueIds,
  uniqueIdsAvoiding,
  type Block,
  type ListBlock,
} from "../components/harbor/legal-markdown";
import { imageSize } from "../lib/docs-registry";
import { LEGAL_DOCS } from "../lib/legal-docs";

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

/**
 * The parser as it was before fenced code, images, links and nested lists
 * were added, frozen here word for word. Every legal document must still
 * parse to what this produced, so adding the developer documents' syntax
 * cannot quietly change a published clause.
 */
interface LegacyBlock {
  type: "h2" | "h3" | "p" | "ul" | "ol" | "quote" | "table" | "hr";
  lines: string[];
}

function legacyParse(markdown: string): LegacyBlock[] {
  const blocks: LegacyBlock[] = [];
  const lines = markdown.split(/\r?\n/);
  let i = 0;
  const isRule = (l: string) => /^(-{3,}|\*{3,}|_{3,})$/.test(l.trim());
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (isRule(line)) {
      blocks.push({ type: "hr", lines: [] });
      i++;
      continue;
    }
    if (/^###\s+/.test(line)) {
      blocks.push({ type: "h3", lines: [line.replace(/^###\s+/, "")] });
      i++;
    } else if (/^##\s+/.test(line)) {
      blocks.push({ type: "h2", lines: [line.replace(/^##\s+/, "")] });
      i++;
    } else if (/^#\s+/.test(line)) {
      i++;
    } else if (/^>\s?/.test(line)) {
      const paragraphs: string[] = [];
      let current = "";
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        const text = lines[i]!.replace(/^>\s?/, "").trim();
        if (text === "") {
          if (current) paragraphs.push(current);
          current = "";
        } else current = current ? `${current} ${text}` : text;
        i++;
      }
      if (current) paragraphs.push(current);
      blocks.push({ type: "quote", lines: paragraphs });
    } else if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) {
        let item = lines[i]!.replace(/^[-*]\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!)) {
          item += ` ${lines[i]!.trim()}`;
          i++;
        }
        items.push(item);
      }
      blocks.push({ type: "ul", lines: items });
    } else if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!)) {
        let item = lines[i]!.replace(/^\d+\.\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!)) {
          item += ` ${lines[i]!.trim()}`;
          i++;
        }
        items.push(item);
      }
      blocks.push({ type: "ol", lines: items });
    } else if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1]!.trim())) {
      const rows: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i]!)) {
        rows.push(lines[i]!);
        i++;
      }
      blocks.push({ type: "table", lines: rows });
    } else {
      const para: string[] = [];
      while (
        i < lines.length &&
        lines[i]!.trim() !== "" &&
        !/^#{1,3}\s/.test(lines[i]!) &&
        !/^[-*]\s+/.test(lines[i]!) &&
        !/^\d+\.\s+/.test(lines[i]!) &&
        !/^>\s?/.test(lines[i]!) &&
        !/^\|/.test(lines[i]!) &&
        !isRule(lines[i]!)
      ) {
        para.push(lines[i]!.trim());
        i++;
      }
      blocks.push({ type: "p", lines: para });
    }
  }
  return blocks;
}

/** A nested list as the old parser saw it: its lines joined onto the item. */
function flattenItem(text: string, child: ListBlock | null): string {
  if (!child) return text;
  return child.lines.reduce(
    (acc, item, j) => `${acc} ${child.type === "ul" ? "-" : `${j + 1}.`} ${flattenItem(item, child.children[j] ?? null)}`,
    text,
  );
}

function asLegacy(blocks: Block[]): LegacyBlock[] {
  return blocks.map((block) => {
    if (block.type === "code") {
      throw new Error(`A legal document now parses a ${block.type} block it never had.`);
    }
    // The setup guide and the FAQ carry screenshots on purpose. The old parser
    // read such a line as a paragraph of its own, which is what it is compared
    // with; everything around it must still parse exactly as it did.
    if (block.type === "image") return { type: "p", lines: block.lines };
    if (block.type === "ul" || block.type === "ol") {
      return { type: block.type, lines: block.lines.map((text, j) => flattenItem(text, block.children[j] ?? null)) };
    }
    return { type: block.type, lines: block.lines };
  });
}

describe("legal documents parse as they did", () => {
  const files = LEGAL_DOCS.map((d) => d.sourceFile).filter((f): f is string => Boolean(f));

  for (const file of files) {
    const path = repo(`docs/${file}`);
    it.runIf(existsSync(path))(`${file} keeps its blocks and section ids`, () => {
      const text = readFileSync(path, "utf8");
      const blocks = parseBlocks(text);
      expect(asLegacy(blocks)).toEqual(legacyParse(text));
      // Numbered lists were always drawn from 1; a legal list starting elsewhere
      // would now be drawn from its own number.
      for (const block of blocks) if (block.type === "ol") expect(block.start).toBe(1);

      const h2 = (list: Array<{ type: string; lines: string[] }>) => list.filter((b) => b.type === "h2").map((b) => b.lines[0]!);
      expect(uniqueIds(h2(blocks))).toEqual(uniqueIds(h2(legacyParse(text))));
    });
  }

  it("the setup guide's indented bullets are now a list inside the item", () => {
    const text = readFileSync(repo("docs/GUIDE.md"), "utf8");
    const nested = parseBlocks(text).find(
      (b): b is ListBlock => (b.type === "ol" || b.type === "ul") && b.children.some(Boolean),
    );
    expect(nested).toBeDefined();
    const child = nested!.children.find(Boolean)!;
    expect(child.type).toBe("ul");
    expect(child.lines.length).toBeGreaterThanOrEqual(2);
  });
});

describe("developer document syntax", () => {
  it("keeps a fenced block verbatim, markdown-looking lines included", () => {
    const blocks = parseBlocks(["Before.", "```bash", "## not a heading", "| not | a table |", "  indented", "```", "After."].join("\n"));
    expect(blocks.map((b) => b.type)).toEqual(["p", "code", "p"]);
    const code = blocks[1] as Extract<Block, { type: "code" }>;
    expect(code.lang).toBe("bash");
    expect(code.lines).toEqual(["## not a heading", "| not | a table |", "  indented"]);
  });

  it("keeps counting numbered steps split by a code block", () => {
    const blocks = parseBlocks(["1. Create it:", "", "```bash", "curl ...", "```", "", "2. Store the ids.", "3. Wait."].join("\n"));
    expect(blocks.map((b) => b.type)).toEqual(["ol", "code", "ol"]);
    expect((blocks[0] as ListBlock).start).toBe(1);
    expect((blocks[2] as ListBlock).start).toBe(2);
  });

  it("reads an image line with its caption and size", () => {
    expect(parseImageLine('![The API keys screen](/docs-media/keys.png "Settings, API keys"){width=1440 height=900}')).toEqual({
      alt: "The API keys screen",
      src: "/docs-media/keys.png",
      title: "Settings, API keys",
      width: 1440,
      height: 900,
    });
    expect(parseImageLine("![Only alt](/a.png)")).toMatchObject({ alt: "Only alt", title: null, width: null, height: null });
    expect(parseImageLine("Text with ![an image](/a.png) inside")).toBeNull();
    const blocks = parseBlocks("Intro line\n![Shot](/a.png)\nMore text");
    expect(blocks.map((b) => b.type)).toEqual(["p", "image", "p"]);
  });

  it("nests lists two levels deep and keeps continuation text on its item", () => {
    const blocks = parseBlocks(["- One", "  continued", "  - Inner A", "  - Inner B", "    1. Deeper", "- Two"].join("\n"));
    expect(blocks).toHaveLength(1);
    const list = blocks[0] as ListBlock;
    expect(list.lines).toEqual(["One continued", "Two"]);
    const inner = list.children[0]!;
    expect(inner.type).toBe("ul");
    expect(inner.lines).toEqual(["Inner A", "Inner B"]);
    expect(inner.children[1]).toMatchObject({ type: "ol", lines: ["Deeper"] });
    expect(list.children[1]).toBeNull();
  });

  it("splits links out of running text, and refuses unsafe targets", () => {
    const parts = "See [Errors](#errors) and **bold** with `code`.".split(INLINE_SPLIT);
    expect(parts).toEqual(["See ", "[Errors](#errors)", " and ", "**bold**", " with ", "`code`", "."]);
    expect(LINK_TOKEN.exec("[Errors](#errors)")?.slice(1, 3)).toEqual(["Errors", "#errors"]);
    // A bracketed pending token is not a link.
    expect("[legal entity name: supplied by the business before launch]".split(INLINE_SPLIT)).toHaveLength(1);
    expect(safeHref("#errors")).toBe("#errors");
    expect(safeHref("/guide")).toBe("/guide");
    expect(safeHref("https://example.com/x")).toBe("https://example.com/x");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("//evil.example/x")).toBeNull();
    expect(safeImageSrc("http://example.com/a.png")).toBeNull();
    expect(safeImageSrc("/docs-media/a.png")).toBe("/docs-media/a.png");
  });

  it("gives sub-headings ids that never take a section's id", () => {
    expect(uniqueIdsAvoiding(["Errors", "Errors", "GET /api/v1/me"], ["errors", "errors-2"])).toEqual([
      "errors-3",
      "errors-4",
      "get-api-v1-me",
    ]);
    expect(splitEndpoint("POST /api/v1/domains/{domainId}/verify")).toEqual(["POST", "/api/v1/domains/{domainId}/verify"]);
    expect(splitEndpoint("Registering an endpoint")).toBeNull();
  });
});

describe("the API reference", () => {
  const text = readFileSync(repo("docs/API.md"), "utf8");
  const blocks = parseBlocks(text);
  const h2 = blocks.filter((b) => b.type === "h2").map((b) => b.lines[0]!);
  const h3 = blocks.filter((b) => b.type === "h3").map((b) => b.lines[0]!);
  const h2Ids = uniqueIds(h2);
  const ids = new Set([...h2Ids, ...uniqueIdsAvoiding(h3, h2Ids)]);

  it("documents every route registered under /api/v1", () => {
    const routes = readFileSync(repo("apps/api/src/routes/api-v1.routes.ts"), "utf8");
    const registered = [...routes.matchAll(/apiV1Router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map(
      ([, method, path]) => `${method!.toUpperCase()} /api/v1${path!.replace(/:(\w+)/g, "{$1}")}`,
    );
    expect(registered.length).toBeGreaterThan(0);
    const documented = h3.filter((t) => splitEndpoint(t));
    expect(new Set(documented).size, "an endpoint is documented twice").toBe(documented.length);
    for (const route of registered) expect(documented, `${route} has no section in docs/API.md`).toContain(route);
    for (const heading of documented) expect(registered, `${heading} is documented but not registered`).toContain(heading);
  });

  it("links only to sections that exist", () => {
    const targets = [...text.matchAll(/\]\(#([\w-]+)\)/g)].map((m) => m[1]!);
    expect(targets.length).toBeGreaterThan(0);
    const known = [...ids];
    for (const target of targets) expect(known, `#${target}`).toContain(target);
  });

  it("closes every code block", () => {
    expect((text.match(/^```/gm) ?? []).length % 2).toBe(0);
  });

  it("uses the slug the renderer gives each endpoint", () => {
    expect(slugify("GET /api/v1/domains/{domain}/tls-reports/summary")).toBe("get-api-v1-domains-domain-tls-reports-summary");
  });
});

describe("image sizes from file headers", () => {
  it("reads a PNG", () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(1440, 16);
    png.writeUInt32BE(900, 20);
    expect(imageSize(png)).toEqual({ width: 1440, height: 900 });
  });

  it("reads a GIF", () => {
    const gif = Buffer.alloc(10);
    gif.write("GIF89a", 0, "ascii");
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(200, 8);
    expect(imageSize(gif)).toEqual({ width: 320, height: 200 });
  });

  it("reads a JPEG past an APP0 segment", () => {
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x00, 0x00, 0x00,
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 800, height: 600 });
  });

  it("reads a WebP (VP8X)", () => {
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBP", 8, "ascii");
    webp.write("VP8X", 12, "ascii");
    webp.writeUIntLE(1279, 24, 3);
    webp.writeUIntLE(719, 27, 3);
    expect(imageSize(webp)).toEqual({ width: 1280, height: 720 });
  });

  it("answers null for anything else", () => {
    expect(imageSize(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(imageSize(Buffer.alloc(0))).toBeNull();
  });
});
