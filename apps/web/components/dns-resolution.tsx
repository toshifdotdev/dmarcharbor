"use client";

/**
 * dns-resolution.tsx — the one animation on the marketing surface: a TXT
 * lookup resolving. SVG and CSS only. No WebGL, no 3D, nothing that can fail
 * on a locked-down corporate machine (this is where MSP staff sit) or fight
 * the Monolith brand.
 *
 * It plays ONCE when scrolled into view and never loops: the sequence is a
 * demonstration, not ambience. Under prefers-reduced-motion it renders the
 * resolved state directly, with no motion at all.
 *
 * The content is the product's real vocabulary: a TXT query on a DMARC record,
 * the record itself, an SPF record parsed from it, and the verdict the product
 * would show for this result. Anyone who knows DMARC recognises the sequence
 * instantly, which is the entire reason this animation earns its bytes.
 */

import { useEffect, useRef, useState } from "react";

const QUERY = "dig TXT _dmarc.example.com";
const RECORD = "v=DMARC1;p=reject;sp=reject;adkim=s;aspf=s";
const SPF = "v=spf1 -all";

function Step({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="resolve-step flex items-baseline gap-3 border-b py-2.5" style={{ borderColor: "var(--color-line)" }}>
      <span
        className="num w-[68px] shrink-0 text-[10px] uppercase tracking-[0.14em]"
        style={{ color: "var(--color-ink-3)" }}
      >
        {label}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

export function DnsResolution() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || started) return;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      // The resolved state IS the content; reduced motion gets it at once.
      setStarted(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setStarted(true);
            observer.disconnect();
          }
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [started]);

  return (
    <div
      ref={ref}
      data-testid="dns-resolution"
      className={`rounded-[2px] border px-5 py-4${started ? " resolve-on" : ""}`}
      style={{ borderColor: "var(--color-line-strong)", background: "var(--color-surface)" }}
    >
      <div data-testid="dns-steps">
        <Step label="query">
          <span className="num text-[12px]" style={{ color: "var(--color-ink-2)" }}>
            {QUERY}
          </span>
        </Step>
        <Step label="response">
          <span className="num text-[12px] leading-[1.6]" style={{ color: "var(--color-ink)", wordBreak: "break-all" }}>
            {RECORD}
          </span>
        </Step>
        <Step label="parsed">
          <span className="num text-[12px] leading-[1.6]" style={{ color: "var(--color-ink-2)", wordBreak: "break-all" }}>
            {SPF}
          </span>
          <span className="num ml-2 text-[11px]" style={{ color: "var(--color-pass)" }}>
            valid
          </span>
        </Step>
        <Step label="verdict">
          <span className="num text-[11.5px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--color-unverified)" }}>
            needs attention
          </span>
          <span className="ml-3 text-[12.5px]" style={{ color: "var(--color-ink-2)" }}>
            Aggregate reporting is not configured.
          </span>
        </Step>
      </div>
      <p className="mt-3 text-[12px] leading-[1.7]" style={{ color: "var(--color-ink-3)" }}>
        One lookup, end to end. The product repeats this across every domain in
        the book, continuously, and keeps the evidence.
      </p>
    </div>
  );
}
