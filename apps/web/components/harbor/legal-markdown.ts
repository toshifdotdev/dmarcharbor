/**
 * legal-markdown.ts — the markdown subset the public documents use, parsed
 * into blocks. Pure: no React, no CSS, no file access, so the parse can be
 * tested on its own and shared by the renderer and the docs registry.
 *
 * The legal documents use headings, paragraphs, bullets, numbered lists,
 * blockquotes, tables, bold and inline code. The developer documents add
 * fenced code blocks, images, links and nested lists. Every addition only
 * triggers on syntax the legal documents do not contain, apart from nested
 * lists: a list item's indented "- " lines used to be joined into the item's
 * text, and are now a list inside the item. tests/legal-markdown.test.ts
 * checks that every legal document still parses to what the previous parser
 * produced, with that one difference.
 *
 * Anything this parser does not know falls through to a paragraph rather than
 * being dropped. Hard-wrapped lines are joined into one paragraph.
 */

export interface ImageRef {
  alt: string;
  src: string;
  /** The quoted title, which is the caption when present. */
  title: string | null;
  /** From a trailing `{width=1440 height=900}`, when the author gave one. */
  width: number | null;
  height: number | null;
}

/** A bullet or numbered list. `lines` holds each item's own text, so a flat
 *  list is exactly what it always was; `children[j]` is the list nested in
 *  item j, or null. */
export interface ListBlock {
  type: "ul" | "ol";
  lines: string[];
  children: Array<ListBlock | null>;
  /** The first item's number, so steps split by a code block keep counting
   *  ("2." after the example, not "1." again). 1 for a bullet list. */
  start: number;
}

export type Block =
  | { type: "h2" | "h3" | "p" | "quote" | "table" | "hr"; lines: string[] }
  | ListBlock
  | { type: "code"; lines: string[]; lang: string | null }
  | { type: "image"; lines: string[]; image: ImageRef };

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** ```lang on a line of its own opens a code block; ``` closes it. */
const FENCE_OPEN = /^```\s*([A-Za-z0-9_+.-]*)\s*$/;
const FENCE_CLOSE = /^```\s*$/;

/**
 * An image on a line of its own: ![alt](/src.png "Caption"){width=1440 height=900}.
 * The title and the size are optional. Without a size the registry reads it
 * from the file, so the page reserves the right height before the image loads.
 */
export const IMAGE_LINE = /^!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+"([^"]*)")?\s*\)(?:\{([^}]*)\})?\s*$/;

/** A list item marker, with the indentation before it. Indentation is counted
 *  in whitespace characters, as the continuation rule always was. */
const MARKER = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

/**
 * The inline tokens: bold, inline code and links, in that order of precedence.
 * Inner groups are non-capturing so `split` returns only whole tokens.
 */
export const INLINE_SPLIT = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+(?:\s+"[^"]*")?\))/g;

/** A link token, split into its text and its target. */
export const LINK_TOKEN = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/;

function isRule(line: string): boolean {
  return /^(-{3,}|\*{3,}|_{3,})$/.test(line.trim());
}

function indentOf(line: string): number {
  return line.length - line.replace(/^\s+/, "").length;
}

function parseSize(attrs: string | undefined): { width: number | null; height: number | null } {
  if (!attrs) return { width: null, height: null };
  const read = (name: string) => {
    const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"?(\\d{1,5})"?`).exec(attrs);
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return { width: read("width"), height: read("height") };
}

export function parseImageLine(line: string): ImageRef | null {
  const m = IMAGE_LINE.exec(line.trim());
  if (!m) return null;
  const size = parseSize(m[4]);
  return { alt: m[1]!.trim(), src: m[2]!, title: m[3]?.trim() || null, ...size };
}

/**
 * A list starting at `start`, whose markers sit at `indent` spaces.
 *
 * A line indented at least two spaces past the marker continues the item, as
 * it always did; if that line is itself a marker it starts a list nested in
 * the item. A blank line, a shallower line or a marker of the other kind ends
 * the list.
 */
function parseList(lines: string[], start: number, indent: number, ordered: boolean): { block: ListBlock; next: number } {
  const items: string[] = [];
  const children: Array<ListBlock | null> = [];
  const first = MARKER.exec(lines[start] ?? "");
  const number = ordered && first ? Number.parseInt(first[2]!, 10) : 1;
  let i = start;

  while (i < lines.length) {
    const m = MARKER.exec(lines[i]!);
    if (!m || m[1]!.length !== indent || /^\d/.test(m[2]!) !== ordered) break;
    let text = m[3]!;
    let child: ListBlock | null = null;
    i++;

    while (i < lines.length) {
      const line = lines[i]!;
      if (line.trim() === "" || indentOf(line) < indent + 2) break;
      const nested = MARKER.exec(line);
      if (nested) {
        if (child) break;
        const parsed = parseList(lines, i, nested[1]!.length, /^\d/.test(nested[2]!));
        child = parsed.block;
        i = parsed.next;
        continue;
      }
      // Text after a nested list would belong to neither item cleanly; the
      // item ends and the line falls through to whatever comes next.
      if (child) break;
      text += ` ${line.trim()}`;
      i++;
    }

    items.push(text);
    children.push(child);
  }

  return {
    block: { type: ordered ? "ol" : "ul", lines: items, children, start: Number.isFinite(number) && number > 0 ? number : 1 },
    next: i,
  };
}

export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      // Verbatim until the closing fence: nothing inside is markdown.
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i]!)) {
        code.push(lines[i]!);
        i++;
      }
      i++;
      blocks.push({ type: "code", lines: code, lang: fence[1] ? fence[1].toLowerCase() : null });
      continue;
    }

    if (isRule(line)) {
      blocks.push({ type: "hr", lines: [] });
      i++;
      continue;
    }

    const image = parseImageLine(line);
    if (image) {
      blocks.push({ type: "image", lines: [line.trim()], image });
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
      // The document's own title is already the page heading.
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
      const parsed = parseList(lines, i, 0, false);
      blocks.push(parsed.block);
      i = parsed.next;
    } else if (/^\d+\.\s+/.test(line)) {
      const parsed = parseList(lines, i, 0, true);
      blocks.push(parsed.block);
      i = parsed.next;
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
        !isRule(lines[i]!) &&
        !FENCE_OPEN.test(lines[i]!) &&
        !IMAGE_LINE.test(lines[i]!.trim())
      ) {
        para.push(lines[i]!.trim());
        i++;
      }
      blocks.push({ type: "p", lines: para });
    }
  }
  return blocks;
}

/** Ids from heading texts: the slug, then -2, -3 for repeats. */
export function uniqueIds(texts: string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((t) => {
    const base = slugify(t) || "section";
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n + 1}` : base;
  });
}

/** Ids for sub-headings, never colliding with the section ids already given
 *  out, so adding sub-heading anchors cannot move a section's address. */
export function uniqueIdsAvoiding(texts: string[], taken: Iterable<string>): string[] {
  const used = new Set(taken);
  return texts.map((t) => {
    const base = slugify(t) || "section";
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  });
}

/** Every image source in a document, for the registry to size. */
export function imageSources(markdown: string): string[] {
  const out = new Set<string>();
  for (const block of parseBlocks(markdown)) {
    if (block.type === "image") out.add(block.image.src);
  }
  return [...out];
}

/** "6. Order process" → ["6.", "Order process"]; no leading number → [null, text]. */
export function splitClauseNumber(text: string): [string | null, string] {
  const m = /^(\d+(?:\.\d+)*\.?)\s+(.+)$/.exec(text);
  return m ? [m[1]!, m[2]!] : [null, text];
}

/** An endpoint heading: "GET /api/v1/clients" → ["GET", "/api/v1/clients"]. */
export function splitEndpoint(text: string): [string, string] | null {
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\/\S*)\s*$/.exec(text.trim());
  return m ? [m[1]!, m[2]!] : null;
}

/** A link target this renderer will follow: in-page, same-site, https, http or mail. */
export function safeHref(href: string): string | null {
  if (/^#[\w-]*$/.test(href)) return href;
  if (/^\/(?!\/)/.test(href)) return href;
  if (/^(https?:\/\/|mailto:)/i.test(href)) return href;
  return null;
}

/** An image source this renderer will load: same-site or https. */
export function safeImageSrc(src: string): string | null {
  if (/^\/(?!\/)/.test(src)) return src;
  if (/^https:\/\//i.test(src)) return src;
  return null;
}

/** The word shown above a code block. */
export function codeLabel(lang: string | null): string {
  switch (lang) {
    case "bash":
    case "sh":
    case "shell":
    case "zsh":
    case "console":
      return "Shell";
    case "powershell":
    case "pwsh":
    case "ps1":
      return "PowerShell";
    case "json":
      return "JSON";
    case "js":
    case "javascript":
    case "mjs":
      return "JavaScript";
    case "ts":
    case "typescript":
      return "TypeScript";
    case "py":
    case "python":
      return "Python";
    case "http":
      return "HTTP";
    case "yaml":
    case "yml":
      return "YAML";
    case null:
    case "":
    case "text":
    case "txt":
    case "plain":
      return "Text";
    default:
      return lang.charAt(0).toUpperCase() + lang.slice(1);
  }
}
