"use client";

/**
 * legal-client.tsx — the three interactive parts of a public document.
 *
 *   SectionAnchor   copies a link to one clause. The person forwarding "see the
 *                   sub-processors clause" sends a link that lands on it.
 *   PrintButton     print or save as PDF; the print stylesheet drops the site
 *                   frame and keeps the document, its version and its address.
 *   Contents        the document's sections as stops on one line: the ones
 *                   already read are travelled in ink, the one being read is
 *                   the larger stop, so a long agreement can be navigated and
 *                   you always know where you are in it.
 *
 * All three are also used by the Trust Center and the artefact frame; their
 * props are unchanged.
 */

import { useEffect, useState } from "react";
import { clsx } from "clsx";
import { buttonClass } from "@/components/ui/button";
import type { LegalHeading } from "./legal-render";
import s from "./legal.module.css";

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
        "inline-flex h-6 shrink-0 items-center self-center rounded-full px-2 text-meta font-semibold tracking-normal transition-[opacity,color,background-color] duration-150 print:hidden",
        copied
          ? "text-ok opacity-100"
          : "text-fg-3 opacity-0 hover:bg-paper-3 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100",
      )}
    >
      {copied ? "Link copied" : "§ Link"}
    </a>
  );
}

export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className={buttonClass("secondary", "sm", "print:hidden")}>
      Print or save as PDF
    </button>
  );
}

/** "6. Order process" → ["6.", "Order process"]; a heading without a number → [null, text]. */
function splitNumber(text: string): [string | null, string] {
  const m = /^(\d+(?:\.\d+)*\.?)\s+(.+)$/.exec(text);
  return m ? [m[1]!, m[2]!] : [null, text];
}

export function Contents({ headings, label = "Contents" }: { headings: LegalHeading[]; label?: string }) {
  const [active, setActive] = useState<string | null>(headings[0]?.id ?? null);

  useEffect(() => {
    const nodes = headings.map((h) => document.getElementById(h.id)).filter((n): n is HTMLElement => Boolean(n));
    if (nodes.length === 0) return;
    // The section being read is the last heading above a reading line a
    // third of the way down the window. Measured on scroll (once a frame), so
    // a jump to a clause marks that clause, not the last heading that happened
    // to cross the line on the way.
    let frame = 0;
    const measure = () => {
      frame = 0;
      const line = window.innerHeight * 0.32;
      let current = nodes[0]!;
      for (const node of nodes) {
        if (node.getBoundingClientRect().top <= line) current = node;
        else break;
      }
      // At the very end of the page the last sections can never reach the
      // line: the last one is then the one being read.
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      setActive(atEnd && window.scrollY > 0 ? nodes[nodes.length - 1]!.id : current.id);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [headings]);

  if (headings.length < 2) return null;
  const at = Math.max(0, headings.findIndex((h) => h.id === active));

  return (
    <nav aria-label={label} className="print:hidden">
      <p className="pb-3 text-[14px] font-bold text-fg">{label}</p>
      <ol className={s.contents}>
        {headings.map((h, i) => {
          const [num, text] = splitNumber(h.text);
          return (
            <li key={h.id} className={s.item} data-state={i < at ? "past" : i === at ? "here" : "ahead"}>
              <span aria-hidden className={s.stop} />
              <a href={`#${h.id}`} aria-current={i === at ? "location" : undefined} className={s.link}>
                {num ? <span className={s.num}>{`${num} `}</span> : null}
                <span>{text}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
