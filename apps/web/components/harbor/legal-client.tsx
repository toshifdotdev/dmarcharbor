"use client";

/**
 * legal-client.tsx — the three interactive parts of a public document.
 *
 *   SectionAnchor   copies a link to one clause. The person forwarding "see the
 *                   sub-processors clause" sends a link that lands on it.
 *   PrintButton     print or save as PDF; the print stylesheet drops the site
 *                   frame and keeps the document, its version and its address.
 *   Contents        the document's sections, with the one being read marked,
 *                   so a long agreement can be navigated and you always know
 *                   where you are in it.
 */

import { useEffect, useState } from "react";
import { clsx } from "clsx";
import type { LegalHeading } from "./legal-render";

export function SectionAnchor({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <a
      href={`#${id}`}
      onClick={async (e) => {
        // The link still works without a clipboard; copying is the bonus.
        try {
          const url = `${window.location.origin}${window.location.pathname}#${id}`;
          await navigator.clipboard.writeText(url);
          e.preventDefault();
          window.history.replaceState(null, "", `#${id}`);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          /* fall through to the plain anchor */
        }
      }}
      aria-label="Copy a link to this section"
      className={clsx(
        "shrink-0 rounded-[2px] px-1 text-meta font-semibold transition-opacity print:hidden",
        copied ? "text-ok opacity-100" : "text-fg-3 opacity-0 hover:text-act focus-visible:opacity-100 group-hover:opacity-100",
      )}
    >
      {copied ? "Link copied" : "§ Link"}
    </a>
  );
}

export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex h-7 items-center rounded-ctl border border-rule-2 bg-paper-2 px-2.5 text-meta font-semibold text-fg-2 hover:border-fg-3 hover:text-fg print:hidden"
    >
      Print or save as PDF
    </button>
  );
}

export function Contents({ headings, label = "Contents" }: { headings: LegalHeading[]; label?: string }) {
  const [active, setActive] = useState<string | null>(headings[0]?.id ?? null);

  useEffect(() => {
    const nodes = headings.map((h) => document.getElementById(h.id)).filter((n): n is HTMLElement => Boolean(n));
    if (nodes.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "0px 0px -70% 0px", threshold: 0 },
    );
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [headings]);

  if (headings.length < 2) return null;

  return (
    <nav aria-label={label} className="print:hidden">
      <p className="legend pb-2">{label}</p>
      <ol className="flex flex-col border-l border-rule">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              aria-current={active === h.id ? "location" : undefined}
              className={clsx(
                "-ml-px block border-l-2 py-1 pl-3 text-ui leading-snug transition-colors duration-75",
                active === h.id ? "border-act font-semibold text-fg" : "border-transparent text-fg-3 hover:text-fg",
              )}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
