/**
 * legal-render.tsx — the legal documents' markdown, rendered for reading and
 * for citing.
 *
 * The documents use a small, deliberate subset of markdown: headings,
 * paragraphs, bullets, numbered lists, blockquotes, tables, bold and inline
 * code. A full markdown engine would be a dependency whose output nobody can
 * audit, on a page where the rendered text IS the legal text. Anything this
 * renderer does not know falls through to a paragraph rather than being
 * dropped.
 *
 * Every section heading gets a stable id from its text, so a clause can be
 * linked to (an MSP forwarding "the sub-processor clause" to a client sends a
 * link that lands on it), and the page builds its contents list from the
 * same ids.
 *
 * Hard-wrapped source lines are joined into one paragraph: the Paddle
 * paragraph is quoted verbatim by requirement and must stay one sentence run.
 */

import type { ReactNode } from "react";
import { SectionAnchor } from "./legal-client";

export interface LegalHeading {
  id: string;
  text: string;
}

interface Block {
  type: "h2" | "h3" | "p" | "ul" | "ol" | "quote" | "table" | "hr";
  lines: string[];
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Bracketed tokens the business has not supplied yet, e.g. "[phone number: ...]". */
const PENDING = /(\[[^\]]*(?:supplied by the business|to be set)[^\]]*\]|to be set at launch|\[[A-Z][A-Z0-9 _-]{2,}\])/;

function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-fg">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      // A pending fact quoted as code is still a pending fact.
      if (PENDING.test(part.slice(1, -1))) {
        return (
          <mark key={i} className="rounded-[2px] bg-warn-wash px-1 font-semibold text-warn">
            {part.slice(1, -1)}
          </mark>
        );
      }
      return (
        <code key={i} className="data rounded-[2px] bg-paper-3 px-1 py-px text-[0.92em] text-fg">
          {part.slice(1, -1)}
        </code>
      );
    }
    // A fact the business has not supplied is shown as visibly pending, never
    // as a plausible-looking value.
    const pieces = part.split(PENDING);
    return pieces.map((piece, j) =>
      PENDING.test(piece) ? (
        <mark key={`${i}-${j}`} className="rounded-[2px] bg-warn-wash px-1 font-semibold text-warn">
          {piece}
        </mark>
      ) : (
        <span key={`${i}-${j}`}>{piece}</span>
      ),
    );
  });
}

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split(/\r?\n/);
  let i = 0;
  const isRule = (l: string) => /^(-{3,}|\*{3,}|_{3,})$/.test(l.trim());
  while (i < lines.length) {
    const line = lines[i];
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
      // The document's own title is already the page heading.
      i++;
    } else if (/^>\s?/.test(line)) {
      const paragraphs: string[] = [];
      let current = "";
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        const text = lines[i].replace(/^>\s?/, "").trim();
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
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        let item = lines[i].replace(/^[-*]\s+/, "");
        i++;
        // Hard-wrapped continuation lines belong to the item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
          item += ` ${lines[i].trim()}`;
          i++;
        }
        items.push(item);
      }
      blocks.push({ type: "ul", lines: items });
    } else if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\d+\.\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
          item += ` ${lines[i].trim()}`;
          i++;
        }
        items.push(item);
      }
      blocks.push({ type: "ol", lines: items });
    } else if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      const rows: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(lines[i]);
        i++;
      }
      blocks.push({ type: "table", lines: rows });
    } else {
      const para: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !/^#{1,3}\s/.test(lines[i]) &&
        !/^[-*]\s+/.test(lines[i]) &&
        !/^\d+\.\s+/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !/^\|/.test(lines[i]) &&
        !isRule(lines[i])
      ) {
        para.push(lines[i].trim());
        i++;
      }
      blocks.push({ type: "p", lines: para });
    }
  }
  return blocks;
}

function uniqueIds(texts: string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((t) => {
    const base = slugify(t) || "section";
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n + 1}` : base;
  });
}

/** The section headings of a document, with the ids the renderer gives them. */
export function legalHeadings(markdown: string, extra: string[] = []): LegalHeading[] {
  const texts = [...extra, ...parseBlocks(markdown).filter((b) => b.type === "h2").map((b) => b.lines[0])];
  const ids = uniqueIds(texts);
  return texts.map((text, i) => ({ id: ids[i], text: text.replace(/[`*]/g, "") }));
}

export function LegalHeading2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="group mt-10 flex scroll-mt-24 items-baseline gap-2 border-t border-rule pt-6 text-h3 font-bold tracking-[-0.01em] text-fg first:mt-0">
      <span className="min-w-0 flex-1">{children}</span>
      <SectionAnchor id={id} />
    </h2>
  );
}

export function LegalBody({ markdown, idOffset = [] }: { markdown: string; idOffset?: string[] }) {
  const blocks = parseBlocks(markdown);
  // Ids continue after any headings rendered before the body (required
  // sections), so the contents list and the anchors agree.
  const h2Texts = blocks.filter((b) => b.type === "h2").map((b) => b.lines[0]);
  const ids = uniqueIds([...idOffset, ...h2Texts]).slice(idOffset.length);
  let h2 = 0;

  return (
    <div className="flex flex-col gap-4 text-body text-fg-2 [&_p]:max-w-[70ch]">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "h2":
            return (
              <LegalHeading2 key={i} id={ids[h2++]}>
                {inline(block.lines[0])}
              </LegalHeading2>
            );
          case "h3":
            return (
              <h3 key={i} className="mt-3 text-body font-bold text-fg">
                {inline(block.lines[0])}
              </h3>
            );
          case "ul":
            return (
              <ul key={i} className="flex max-w-[70ch] flex-col gap-1.5">
                {block.lines.map((item, j) => (
                  <li key={j} className="relative pl-5">
                    <span aria-hidden className="absolute left-0 top-[9px] block size-1.5 bg-fg-3" />
                    {inline(item)}
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="flex max-w-[70ch] flex-col gap-1.5">
                {block.lines.map((item, j) => (
                  <li key={j} className="grid grid-cols-[28px_minmax(0,1fr)]">
                    <span className="tnum font-semibold text-fg-3">{j + 1}.</span>
                    <span>{inline(item)}</span>
                  </li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote key={i} className="max-w-[70ch] border-l-2 border-rule-2 pl-4 text-fg-2">
                {block.lines.map((item, j) => (
                  <p key={j} className={j ? "mt-2" : ""}>
                    {inline(item)}
                  </p>
                ))}
              </blockquote>
            );
          case "hr":
            // Every section heading already carries its own rule; a
            // markdown rule before it would draw a second one.
            return null;
          case "table": {
            const rows = block.lines
              .filter((r) => !/^\|[\s:|-]+\|$/.test(r.trim()))
              .map((r) =>
                r
                  .replace(/^\|/, "")
                  .replace(/\|$/, "")
                  .split("|")
                  .map((c) => c.trim()),
              );
            const [head, ...body] = rows;
            return (
              <div key={i} className="overflow-x-auto">
                <table className="w-full border-collapse border-y border-fg text-left text-ui">
                  <thead className="border-b border-rule-2">
                    <tr>
                      {head?.map((cell, j) => (
                        <th key={j} className="legend px-2.5 py-2 align-bottom">
                          {inline(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {body.map((row, j) => (
                      <tr key={j} className="border-b border-rule align-baseline last:border-b-0">
                        {row.map((cell, k) => (
                          <td key={k} className={k === 0 ? "px-2.5 py-2 font-semibold text-fg" : "px-2.5 py-2 text-fg-2"}>
                            {inline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          default:
            return <p key={i}>{inline(block.lines.join(" "))}</p>;
        }
      })}
    </div>
  );
}
