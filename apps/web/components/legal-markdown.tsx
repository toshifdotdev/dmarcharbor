/**
 * legal-markdown.tsx — a compact renderer for the legal documents.
 *
 * The docs use a small, deliberate subset of markdown: headings, paragraphs,
 * bullets, numbered lists, blockquotes, tables, bold and inline code. Nothing
 * in a legal document needs more than that, and a full markdown engine would
 * be a dependency whose output nobody can audit — which matters on a page
 * where the rendered text IS the legal text. When a document uses something
 * this renderer does not know, it falls through to a paragraph rather than
 * being dropped.
 */

function inline(text: string): React.ReactNode {
  // **bold** and `code` only. Split, then restore; nothing else is styled.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} style={{ color: "var(--color-ink)" }}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={i}
          className="num"
          style={{
            background: "var(--color-elevate)",
            padding: "1px 5px",
            borderRadius: 2,
            fontSize: "0.92em",
          }}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

interface Block {
  type: "h2" | "h3" | "p" | "ul" | "ol" | "quote" | "table";
  lines: string[];
}

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (/^##\s+/.test(line)) {
      blocks.push({ type: "h2", lines: [line.replace(/^##\s+/, "")] });
    } else if (/^#\s+/.test(line)) {
      // The document's own title is already the page heading.
    } else if (/^###\s+/.test(line)) {
      blocks.push({ type: "h3", lines: [line.replace(/^###\s+/, "")] });
    } else if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", lines: quoted });
      continue;
    } else if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ul", lines: items });
      continue;
    } else if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ type: "ol", lines: items });
      continue;
    } else if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      const rows: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(lines[i]);
        i++;
      }
      blocks.push({ type: "table", lines: rows });
      continue;
    } else {
      const para: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !/^#{1,3}\s/.test(lines[i]) &&
        !/^[-*]\s+/.test(lines[i]) &&
        !/^\d+\.\s+/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !/^\|/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      blocks.push({ type: "p", lines: para });
      continue;
    }
    i++;
  }
  return blocks;
}

export function LegalMarkdown({ markdown }: { markdown: string }) {
  const blocks = parseBlocks(markdown);
  return (
    <div className="flex flex-col gap-4">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "h2":
            return (
              <h2
                key={i}
                className="mt-4 text-[19px] font-semibold tracking-[-0.02em]"
                style={{ fontFamily: "var(--font-display)", color: "var(--color-ink)" }}
              >
                {inline(block.lines[0])}
              </h2>
            );
          case "h3":
            return (
              <h3
                key={i}
                className="mt-2 text-[15px] font-semibold tracking-[-0.012em]"
                style={{ color: "var(--color-ink)" }}
              >
                {inline(block.lines[0])}
              </h3>
            );
          case "ul":
            return (
              <ul key={i} className="flex flex-col gap-2">
                {block.lines.map((item, j) => (
                  <li
                    key={j}
                    className="relative pl-4 text-[13.5px] leading-[1.75]"
                    style={{ color: "var(--color-ink-2)" }}
                  >
                    <span style={{ position: "absolute", left: 0, color: "var(--color-ink-3)" }}>–</span>
                    {inline(item)}
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="flex flex-col gap-2">
                {block.lines.map((item, j) => (
                  <li
                    key={j}
                    className="relative pl-6 text-[13.5px] leading-[1.75]"
                    style={{ color: "var(--color-ink-2)" }}
                  >
                    <span
                      className="num"
                      style={{ position: "absolute", left: 0, color: "var(--color-ink-3)" }}
                    >
                      {j + 1}.
                    </span>
                    {inline(item)}
                  </li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote
                key={i}
                className="border-l-2 pl-4 text-[13px] leading-[1.75]"
                style={{ borderColor: "var(--color-line-strong)", color: "var(--color-ink-3)" }}
              >
                {block.lines.map((item, j) => (
                  <p key={j}>{inline(item)}</p>
                ))}
              </blockquote>
            );
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
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr>
                      {head?.map((cell, j) => (
                        <th
                          key={j}
                          className="num border-b px-3 py-2 text-[11px] uppercase tracking-[0.1em]"
                          style={{ borderColor: "var(--color-line-strong)", color: "var(--color-ink-3)" }}
                        >
                          {inline(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {body.map((row, j) => (
                      <tr key={j}>
                        {row.map((cell, k) => (
                          <td
                            key={k}
                            className="num border-b px-3 py-2 text-[12px]"
                            style={{ borderColor: "var(--color-line)", color: "var(--color-ink-2)" }}
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
          default:
            return (
              <p key={i} className="text-[13.5px] leading-[1.8]" style={{ color: "var(--color-ink-2)" }}>
                {inline(block.lines.join(" "))}
              </p>
            );
        }
      })}
    </div>
  );
}
