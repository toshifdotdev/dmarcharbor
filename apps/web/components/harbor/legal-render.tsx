/**
 * legal-render.tsx — the public documents' markdown, rendered for reading and
 * for citing.
 *
 * The documents use a small, deliberate subset of markdown (parsed in
 * legal-markdown.ts): headings, paragraphs, bullets, numbered lists,
 * blockquotes, tables, bold and inline code, and for the developer documents
 * fenced code blocks, images, links and nested lists. A full markdown engine
 * would be a dependency whose output nobody can audit, on a page where the
 * rendered text IS the legal text. Anything the parser does not know falls
 * through to a paragraph rather than being dropped.
 *
 * Every section heading gets a stable id from its text, so a clause can be
 * linked to (an MSP forwarding "the sub-processor clause" to a client sends a
 * link that lands on it), and the page builds its contents list from the
 * same ids. A developer document can ask for ids on its sub-headings too, so
 * every endpoint has an address.
 *
 * Hard-wrapped source lines are joined into one paragraph: the Paddle
 * paragraph is quoted verbatim by requirement and must stay one sentence run.
 */

import type { ReactNode } from "react";
import { CopyButton } from "@/components/ui/copy";
import { SectionAnchor } from "./legal-client";
import {
  codeLabel,
  INLINE_SPLIT,
  LINK_TOKEN,
  parseBlocks,
  safeHref,
  safeImageSrc,
  slugify,
  splitClauseNumber,
  splitEndpoint,
  uniqueIds,
  uniqueIdsAvoiding,
  type ImageRef,
  type ListBlock,
} from "./legal-markdown";
import ls from "./legal.module.css";

export { slugify };

export interface LegalHeading {
  id: string;
  text: string;
}

/** An image's intrinsic size, so the page reserves its height before it loads. */
export interface ImageSize {
  width: number;
  height: number;
}

/** A pending fact: the warn wash and word colour, a state notice in place.
 *  It prints with its colour, so a printout still shows what is missing. */
export const PENDING_MARK =
  "rounded-[4px] bg-warn-wash px-1 font-semibold text-warn [box-decoration-break:clone] print:bg-transparent print:underline print:decoration-dotted";

/** Bracketed tokens the business has not supplied yet, e.g. "[phone number: ...]". */
const PENDING = /(\[[^\]]*(?:supplied by the business|to be set)[^\]]*\]|to be set at launch|\[[A-Z][A-Z0-9 _-]{2,}\])/;

const INLINE_CODE = "data rounded-[4px] bg-paper-3 px-1 py-px text-[0.9em] text-fg";

function inline(text: string): ReactNode {
  const parts = text.split(INLINE_SPLIT);
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
          <mark key={i} className={PENDING_MARK}>
            {part.slice(1, -1)}
          </mark>
        );
      }
      return (
        <code key={i} className={INLINE_CODE}>
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = LINK_TOKEN.exec(part);
    if (link) {
      const href = safeHref(link[2]!);
      // A target this renderer will not follow keeps its words and loses the link.
      return href ? (
        <a key={i} href={href} className="link">
          {inline(link[1]!)}
        </a>
      ) : (
        <span key={i}>{inline(link[1]!)}</span>
      );
    }
    // A fact the business has not supplied is shown as visibly pending, never
    // as a plausible-looking value.
    const pieces = part.split(PENDING);
    return pieces.map((piece, j) =>
      PENDING.test(piece) ? (
        <mark key={`${i}-${j}`} className={PENDING_MARK}>
          {piece}
        </mark>
      ) : (
        <span key={`${i}-${j}`}>{piece}</span>
      ),
    );
  });
}

/** The section headings of a document, with the ids the renderer gives them. */
export function legalHeadings(markdown: string, extra: string[] = []): LegalHeading[] {
  const texts = [...extra, ...parseBlocks(markdown).filter((b) => b.type === "h2").map((b) => b.lines[0]!)];
  const ids = uniqueIds(texts);
  return texts.map((text, i) => ({ id: ids[i]!, text: text.replace(/[`*]/g, "") }));
}

/**
 * A section heading that links to itself.
 *
 * `compact` (the default) is the heading the Trust Center and other in-product
 * documents use, unchanged. `document` is the public document set's reading
 * size, with the clause number set apart (in the margin from 1100px) so a
 * reader scanning for "section 6" finds it down one edge.
 */
export function LegalHeading2({
  id,
  children,
  variant = "compact",
  number,
}: {
  id: string;
  children: ReactNode;
  variant?: "compact" | "document";
  /** The clause number, already split from the text ("6."). Document variant only. */
  number?: string | null;
}) {
  if (variant === "document") {
    return (
      <h2 id={id} data-num={number ? "" : undefined} className={`group ${ls.h2}`}>
        {number ? <span className={ls.h2Num}>{number}</span> : null}
        <span className="min-w-0 flex-1">{children}</span>
        <SectionAnchor id={id} />
      </h2>
    );
  }
  return (
    <h2 id={id} className="group mt-10 flex scroll-mt-24 items-baseline gap-2 border-t border-rule pt-6 text-h3 font-bold tracking-[-0.01em] text-fg first:mt-0">
      <span className="min-w-0 flex-1">{children}</span>
      <SectionAnchor id={id} />
    </h2>
  );
}

const H3_CLASS = "mt-5 text-[18px] font-bold leading-[1.3] tracking-[-0.01em] text-fg sm:text-[19px] print:text-[12pt]";
/** An endpoint opens its own small section, so it stands further from the
 *  text above it than a plain sub-heading does. */
const H3_ENDPOINT_CLASS =
  "mt-10 text-[18px] font-bold leading-[1.3] tracking-[-0.01em] text-fg sm:text-[19px] print:mt-5 print:text-[12pt] print:break-after-avoid";

/** A sub-heading. An endpoint ("GET /api/v1/clients") sets the method as a
 *  bold label and the path in the data face, both copied exactly. */
function Heading3({ text, id }: { text: string; id?: string }) {
  const endpoint = splitEndpoint(text);
  const content = endpoint ? (
    <>
      <span className="data font-bold">{endpoint[0]}</span>{" "}
      <span className="data font-semibold [overflow-wrap:anywhere]">{endpoint[1]}</span>
    </>
  ) : (
    inline(text)
  );

  if (!id) {
    return <h3 className={H3_CLASS}>{content}</h3>;
  }
  return (
    <h3 id={id} className={`group flex scroll-mt-6 items-baseline gap-2 ${endpoint ? H3_ENDPOINT_CLASS : H3_CLASS}`}>
      <span className="min-w-0 flex-1">{content}</span>
      <SectionAnchor id={id} />
    </h3>
  );
}

/** A list, and any list nested in its items. A flat list renders exactly as
 *  the legal documents always have. */
function List({ block, nested }: { block: ListBlock; nested?: boolean }) {
  const outer = nested ? "mt-2 flex flex-col gap-2" : "flex max-w-[68ch] flex-col gap-2";
  if (block.type === "ul") {
    return (
      <ul className={outer}>
        {block.lines.map((item, j) => {
          const child = block.children[j];
          return (
            <li key={j} className="relative pl-6">
              <span aria-hidden className="absolute left-1 top-[0.68em] block size-[6px] rounded-full bg-fg-4" />
              {inline(item)}
              {child ? <List block={child} nested /> : null}
            </li>
          );
        })}
      </ul>
    );
  }
  // The number is drawn, not the list marker, so `start` only matters to
  // assistive technology; it is set only when the list does not start at 1.
  return (
    <ol className={outer} start={block.start !== 1 ? block.start : undefined}>
      {block.lines.map((item, j) => {
        const child = block.children[j];
        return (
          <li key={j} className="grid grid-cols-[32px_minmax(0,1fr)]">
            <span className="tnum font-semibold text-fg-4">{block.start + j}.</span>
            {child ? (
              <div className="min-w-0">
                {inline(item)}
                <List block={child} nested />
              </div>
            ) : (
              <span>{inline(item)}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A code example: the data face in the one recessed well, with its language
 * and a Copy control. It scrolls inside itself; the page never scrolls
 * sideways. Copied exactly as written, so an example pasted into a terminal
 * runs as shown.
 */
function CodeBlock({ lang, lines }: { lang: string | null; lines: string[] }) {
  const label = codeLabel(lang);
  const code = lines.join("\n");
  return (
    <div data-copy-scope className={ls.code}>
      <div className={ls.codeHead}>
        <span className={ls.codeLang}>{label}</span>
        <CopyButton value={code} label={`Copy this ${label} example`} className="print:hidden" />
      </div>
      {/* Focusable, so a keyboard can scroll a long line into view. */}
      <pre className={ls.codePre} tabIndex={0} role="group" aria-label={`${label} example`}>
        <code data-copy-value className="data">
          {code}
        </code>
      </pre>
    </div>
  );
}

/**
 * An image with its caption. The width and height are always set when they
 * are known (from the markdown, or read from the file by the registry), so
 * the page holds the right space before it loads; an image of unknown size
 * sits in a fixed 16:10 frame instead, so nothing below it moves either way.
 */
function Figure({ image, size }: { image: ImageRef; size: ImageSize | null }) {
  const src = safeImageSrc(image.src);
  const caption = image.title ?? (image.alt || null);
  if (!src) {
    return caption ? <p>{caption}</p> : null;
  }
  const width = image.width ?? size?.width ?? null;
  const height = image.height ?? size?.height ?? null;
  return (
    <figure className={ls.figure}>
      {width && height ? (
        <img src={src} alt={image.alt} width={width} height={height} loading="lazy" decoding="async" className={ls.img} />
      ) : (
        <span className={ls.imgFrame}>
          <img src={src} alt={image.alt} loading="lazy" decoding="async" className={ls.imgFill} />
        </span>
      )}
      {caption ? <figcaption className={ls.caption}>{caption}</figcaption> : null}
    </figure>
  );
}

export function LegalBody({
  markdown,
  idOffset = [],
  subheadingAnchors = false,
  images,
}: {
  markdown: string;
  idOffset?: string[];
  /** Give every sub-heading an id and a link, as the developer documents do. */
  subheadingAnchors?: boolean;
  /** Intrinsic sizes by image source, read by the registry. */
  images?: Record<string, ImageSize>;
}) {
  const blocks = parseBlocks(markdown);
  // Ids continue after any headings rendered before the body (required
  // sections), so the contents list and the anchors agree.
  const h2Texts = blocks.filter((b) => b.type === "h2").map((b) => b.lines[0]!);
  const allH2Ids = uniqueIds([...idOffset, ...h2Texts]);
  const ids = allH2Ids.slice(idOffset.length);
  // Sub-heading ids never take an id a section already has, so a section's
  // address is the same with or without them.
  const h3Ids = subheadingAnchors
    ? uniqueIdsAvoiding(
        blocks.filter((b) => b.type === "h3").map((b) => b.lines[0]!),
        allH2Ids,
      )
    : [];
  let h2 = 0;
  let h3 = 0;

  return (
    <div className={LEGAL_TEXT}>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "h2": {
            const [number, text] = splitClauseNumber(block.lines[0]!);
            return (
              <LegalHeading2 key={i} id={ids[h2++]!} variant="document" number={number}>
                {inline(text)}
              </LegalHeading2>
            );
          }
          case "h3":
            return <Heading3 key={i} text={block.lines[0]!} id={subheadingAnchors ? h3Ids[h3++] : undefined} />;
          case "ul":
          case "ol":
            return <List key={i} block={block} />;
          case "code":
            return <CodeBlock key={i} lang={block.lang} lines={block.lines} />;
          case "image":
            return <Figure key={i} image={block.image} size={images?.[block.image.src] ?? null} />;
          case "quote":
            return (
              <blockquote key={i} className="max-w-[68ch] border-l-[3px] border-rule-2 pl-5 text-fg-2">
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
            // A timetable: an ink rule under the column names, hairlines
            // between rows, no vertical rules. It scrolls inside itself on a
            // phone; the page never does.
            return (
              <div key={i} className="my-2 overflow-x-auto print:overflow-visible">
                <table className="w-full min-w-[560px] border-collapse text-left text-[15px] leading-[1.45] print:min-w-0 print:text-[9.5pt]">
                  <thead className="border-b border-fg">
                    <tr>
                      {head?.map((cell, j) => (
                        <th key={j} className="py-2.5 pr-5 align-bottom text-[14px] font-semibold text-fg last:pr-0">
                          {inline(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {body.map((row, j) => (
                      <tr key={j} className="border-b border-rule align-baseline">
                        {row.map((cell, k) => (
                          <td
                            key={k}
                            className={
                              k === 0 ? "py-3 pr-5 font-semibold text-fg last:pr-0" : "py-3 pr-5 text-fg-2 last:pr-0"
                            }
                          >
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
          default: {
            const text = block.lines.join(" ");
            // A paragraph that is only bold is a question or a lead-in (the
            // FAQ's questions): set as the line the answer under it hangs from.
            if (/^\*\*[^*]+\*\*$/.test(text)) {
              return (
                <p key={i} className="mt-4 text-[18px] font-semibold leading-[1.35] text-fg print:text-[11pt]">
                  {inline(text.slice(2, -2))}
                </p>
              );
            }
            return <p key={i}>{inline(text)}</p>;
          }
        }
      })}
    </div>
  );
}

/** The running text of a public document: reading size, ink-2, a measure of
 *  about 68 characters. Shared with the support page and required sections. */
export const LEGAL_TEXT =
  "flex flex-col gap-5 text-[16px] leading-[1.65] text-fg-2 [overflow-wrap:break-word] sm:text-[17px] [&_p]:max-w-[68ch] print:gap-3 print:text-[10.5pt] print:leading-[1.5]";
