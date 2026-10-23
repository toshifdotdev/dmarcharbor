"use client";

/**
 * approach-diagram.tsx — how DMARC decides, drawn as a harbor approach.
 *
 * This is where the name earns its keep. A receiving mail server is a harbor
 * entrance: every message arriving under your client's flag (the From domain)
 * is inspected there. If neither SPF nor DKIM passes in alignment with that
 * domain, the published policy decides: p=none lets it in and only logs it,
 * p=quarantine holds it at the anchorage (the spam folder), p=reject turns it
 * away. Whatever happens, the receiver keeps a log and sends it to the address
 * in the DMARC record. Those logs are what this product reads.
 *
 * The motion explains cause and effect, nothing else: change the policy and the
 * forged message takes the path that policy gives it. It plays once when
 * scrolled into view and again on each change; it never loops. Under
 * prefers-reduced-motion every message is placed at its destination at once.
 *
 * The drawing is aria-hidden. Its meaning is carried in words beside it, in a
 * live region that changes with the policy. It contains no figures: it is an
 * illustration of the protocol, not data.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { clsx } from "clsx";
import { Segmented } from "@/components/ui/field";

type Policy = "none" | "quarantine" | "reject";

// Paths in the 960×400 drawing space.
const LEGIT = "M40 118 C 200 110, 340 150, 470 176 S 600 186, 650 170 S 760 118, 812 116";
const FORGED: Record<Policy, string> = {
  none: "M40 262 C 200 262, 360 214, 470 192 S 600 194, 660 214 S 760 236, 812 238",
  quarantine: "M40 262 C 200 262, 360 226, 452 206 S 470 262, 452 300 S 420 330, 420 330",
  reject: "M40 262 C 200 262, 360 226, 448 204 C 470 220, 420 290, 300 330 S 120 352, 40 356",
};

const COPY: Record<Policy, { head: string; body: string }> = {
  none: {
    head: "p=none: watch only",
    body: "The forged message is not stopped. The receiver handles it as it would any mail, and records that it failed. Every domain starts here, because you need the record before you can safely enforce.",
  },
  quarantine: {
    head: "p=quarantine: held outside",
    body: "The forged message is held at the anchorage: delivered to spam or quarantine instead of the inbox. The receiver records it.",
  },
  reject: {
    head: "p=reject: turned away",
    body: "The forged message is refused at the entrance and never delivered. The receiver records the refusal. This is the goal, once the records show every legitimate sender aligned.",
  },
};

const DURATION = 2100;

function ease(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function ApproachDiagram() {
  const [policy, setPolicy] = useState<Policy>("reject");
  const [seen, setSeen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const legitPath = useRef<SVGPathElement | null>(null);
  const forgedPath = useRef<SVGPathElement | null>(null);
  const legitDot = useRef<SVGGElement | null>(null);
  const forgedDot = useRef<SVGGElement | null>(null);
  const frame = useRef<number>(0);

  const place = useCallback((dot: SVGGElement | null, path: SVGPathElement | null, t: number) => {
    if (!dot || !path) return;
    const len = path.getTotalLength();
    const p = path.getPointAtLength(len * t);
    dot.setAttribute("transform", `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
    dot.style.opacity = String(t > 0.94 && policy === "reject" && dot === forgedDot.current ? 1 - (t - 0.94) / 0.06 : 1);
  }, [policy]);

  const play = useCallback(
    (both: boolean) => {
      cancelAnimationFrame(frame.current);
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced) {
        place(legitDot.current, legitPath.current, 1);
        place(forgedDot.current, forgedPath.current, 1);
        return;
      }
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / DURATION);
        if (both) place(legitDot.current, legitPath.current, ease(Math.min(1, t * 1.15)));
        place(forgedDot.current, forgedPath.current, ease(Math.max(0, t * 1.15 - 0.15)));
        if (t < 1) frame.current = requestAnimationFrame(step);
      };
      frame.current = requestAnimationFrame(step);
    },
    [place],
  );

  // Start once, when it is first seen.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const first = useRef(true);
  useEffect(() => {
    if (!seen) {
      // Before it is seen, everything rests at the start of its path.
      place(legitDot.current, legitPath.current, 0);
      place(forgedDot.current, forgedPath.current, 0);
      return;
    }
    play(first.current);
    first.current = false;
    return () => cancelAnimationFrame(frame.current);
  }, [seen, policy, play, place]);

  return (
    <div ref={root} className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-10">
      <figure className="m-0 min-w-0">
        {/* Below ~640px the drawing scrolls sideways rather than shrinking its
            labels past reading size. */}
        <div className="overflow-x-auto rounded-sheet border border-rule-2 bg-paper-2">
          <svg viewBox="0 0 960 400" className="block h-auto w-full min-w-[640px]" aria-hidden focusable="false">
            {/* Open water and its depth contours. */}
            <rect x="0" y="0" width="560" height="400" fill="var(--color-sea)" />
            <g fill="none" stroke="var(--color-sea-2)" strokeWidth="1.2" className={seen ? "" : "opacity-0"}>
              {[
                "M0 40 C 120 30, 220 70, 330 58 S 500 20, 560 36",
                "M0 196 C 90 182, 160 214, 250 200 S 380 168, 430 186",
                "M0 380 C 140 370, 230 340, 330 352 S 470 386, 560 372",
                "M120 300 C 160 286, 230 292, 250 312 S 180 340, 140 326 S 100 310, 120 300Z",
              ].map((d, i) => (
                <path
                  key={i}
                  d={d}
                  pathLength={1000}
                  className={seen ? "hb-draw" : ""}
                  style={{ "--len": 1000, animationDelay: `${i * 120}ms` } as CSSProperties}
                />
              ))}
            </g>

            {/* The land, and the harbor basin cut into it. */}
            <path d="M560 0 H960 V400 H560 Z" fill="var(--color-paper-3)" />
            <path d="M600 70 H920 V290 H600 Z" fill="var(--color-sea)" />
            {/* Breakwater walls with the entrance between y=150 and y=230. */}
            <path d="M560 0 V150 M560 230 V400" stroke="var(--color-fg)" strokeWidth="5" />
            <path d="M560 150 H600 V70 H920 V290 H600 V230 H560" fill="none" stroke="var(--color-fg)" strokeWidth="2" />

            {/* Lateral marks at the entrance, drawn in ink: they mark the
                channel, they are not states. */}
            <rect x="548" y="134" width="12" height="12" fill="none" stroke="var(--color-fg)" strokeWidth="1.5" />
            <path d="M554 234 L561 248 H547 Z" fill="none" stroke="var(--color-fg)" strokeWidth="1.5" />

            {/* The inspection line across the entrance. */}
            <line x1="560" y1="150" x2="560" y2="230" stroke="var(--color-fg)" strokeWidth="1" />
            <text x="574" y="200" className="legend" fill="var(--color-fg-2)" style={{ fontSize: 11 }}>
              DMARC CHECK
            </text>

            {/* Destinations. */}
            <g>
              <rect x="790" y="96" width="112" height="40" fill="none" stroke="var(--color-fg)" strokeWidth="1" />
              <text x="800" y="90" fill="var(--color-fg-2)" style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em" }}>
                INBOX
              </text>
            </g>
            <g opacity={policy === "none" ? 1 : 0.35}>
              <rect x="790" y="218" width="112" height="40" fill="none" stroke="var(--color-fg)" strokeWidth="1" />
              <text x="902" y="276" textAnchor="end" fill="var(--color-fg-2)" style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em" }}>
                DELIVERED AS USUAL
              </text>
            </g>
            <g opacity={policy === "quarantine" ? 1 : 0.35}>
              <circle cx="436" cy="318" r="34" fill="none" stroke="var(--color-fg)" strokeWidth="1" />
              <text x="436" y="370" textAnchor="middle" fill="var(--color-fg-2)" style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em" }}>
                ANCHORAGE · SPAM
              </text>
            </g>
            <g opacity={policy === "reject" ? 1 : 0.35}>
              <text x="40" y="384" fill="var(--color-fg-2)" style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em" }}>
                TURNED AWAY
              </text>
            </g>

            {/* Origins. */}
            <text x="40" y="96" fill="var(--color-fg)" style={{ fontSize: 12, fontWeight: 600 }}>
              Sent by your client&rsquo;s mail provider
            </text>
            <text x="40" y="242" fill="var(--color-fg)" style={{ fontSize: 12, fontWeight: 600 }}>
              Forged by someone else
            </text>
            <text x="40" y="110" className="data" fill="var(--color-fg-3)" style={{ fontSize: 11 }}>
              From: billing@client.example
            </text>
            <text x="40" y="256" className="data" fill="var(--color-fg-3)" style={{ fontSize: 11 }}>
              From: billing@client.example
            </text>

            {/* Tracks. */}
            <path ref={legitPath} d={LEGIT} fill="none" stroke="var(--color-fg-4)" strokeWidth="1" />
            <path ref={forgedPath} d={FORGED[policy]} fill="none" stroke="var(--color-fg-4)" strokeWidth="1" />

            {/* The record every receiver keeps and sends. */}
            <path d="M846 290 V330 H772" fill="none" stroke="var(--color-fg)" strokeWidth="1.5" />
            <path d="M778 324 L770 330 L778 336" fill="none" stroke="var(--color-fg)" strokeWidth="1.5" />
            <rect x="620" y="314" width="148" height="32" fill="var(--color-paper-2)" stroke="var(--color-fg)" strokeWidth="1.5" />
            <text x="694" y="334" textAnchor="middle" fill="var(--color-fg)" style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em" }}>
              AGGREGATE REPORT
            </text>

            {/* Messages: aligned is a filled square, not aligned a diamond. */}
            <g ref={legitDot}>
              <rect x="-7" y="-7" width="14" height="14" fill="var(--color-ok)" />
            </g>
            <g ref={forgedDot}>
              <path d="M0 -9 9 0 0 9 -9 0Z" fill="var(--color-fail)" />
            </g>
          </svg>
        </div>
        <figcaption className="mt-2 text-meta text-fg-3">
          Illustration of the protocol. Square: SPF or DKIM passes aligned with the From domain. Diamond: neither does.
        </figcaption>
      </figure>

      <div className="flex flex-col gap-5">
        <Segmented<Policy>
          label="Published DMARC policy"
          value={policy}
          onChange={setPolicy}
          options={[
            { value: "none", label: <span className="data">p=none</span> },
            { value: "quarantine", label: <span className="data">p=quarantine</span> },
            { value: "reject", label: <span className="data">p=reject</span> },
          ]}
        />
        <div aria-live="polite" className="min-h-[148px]">
          <p className="text-h3 font-bold text-fg">{COPY[policy].head}</p>
          <p className="mt-2 text-body text-fg-2">{COPY[policy].body}</p>
        </div>
        <ol className="flex flex-col border-t border-rule-2">
          {[
            ["Aligned", "Your client's real provider passes SPF or DKIM for the From domain. It berths in every case."],
            ["Not aligned", "Neither check passes for that domain. The published policy decides what happens next."],
            ["Recorded", "Either way the receiver logs it and sends the log to your report address. That is what we read."],
          ].map(([k, v], i) => (
            <li key={k} className={clsx("grid grid-cols-[92px_minmax(0,1fr)] gap-3 border-b border-rule py-2.5")}>
              <span className="flex items-center gap-2 text-ui font-semibold text-fg">
                <span
                  aria-hidden
                  className={clsx(
                    "block size-2 shrink-0",
                    i === 0 && "bg-ok",
                    i === 1 && "rotate-45 bg-fail",
                    i === 2 && "border border-fg",
                  )}
                />
                {k}
              </span>
              <span className="text-ui text-fg-2">{v}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
