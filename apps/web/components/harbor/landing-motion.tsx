"use client";

/**
 * landing-motion.tsx — the home page's two kinds of motion. Both start after
 * hydration, so the server HTML is always the still, finished drawing.
 *
 * - useRide: messages riding a map's lines (SVG animateMotion). On only when
 *   the reader allows motion, and paused while the drawing is off screen.
 * - Reveal: a figure's lines draw themselves as it scrolls into view, and
 *   again each time it comes back. Nothing on screen ever blanks or redraws:
 *   the reset happens only while the figure is out of sight.
 */

import { useEffect, useRef, useSyncExternalStore, type ReactNode, type RefObject } from "react";

const MOTION_OK = "(prefers-reduced-motion: no-preference)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(MOTION_OK);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** False on the server and during hydration; the reader's preference after. */
export function useMotionAllowed(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOTION_OK).matches,
    () => false,
  );
}

/** Whether to draw riding messages, with their animation paused off screen. */
export function useRide(svg: RefObject<SVGSVGElement | null>): boolean {
  const moving = useMotionAllowed();
  useEffect(() => {
    const el = svg.current;
    if (!moving || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) el.unpauseAnimations();
      else el.pauseAnimations();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [moving, svg]);
  return moving;
}

/**
 * A wrapper whose `data-motion` goes "armed" (lines hidden) and then "run"
 * (lines drawn) as it scrolls into view. The stylesheet decides what draws.
 *
 * Forward-only replay: once the figure has left the window, through the top
 * or the bottom, it re-arms, and it draws again the next time it comes into
 * view from either direction. Lines always draw in; they never un-draw while
 * the reader can see them.
 */
export function Reveal({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (!window.matchMedia(MOTION_OK).matches) return;
    // A figure on screen at load is already drawn; one out of sight starts armed.
    const box = el.getBoundingClientRect();
    if (box.top >= window.innerHeight || box.bottom <= 0) el.dataset.motion = "armed";

    // Draws once the figure is in the top four fifths of the window. Coming
    // back from above, that is as soon as it reappears.
    const draw = new IntersectionObserver(
      (entries) => {
        if (el.dataset.motion === "armed" && entries.some((e) => e.isIntersecting)) el.dataset.motion = "run";
      },
      { rootMargin: "0px 0px -20% 0px" },
    );
    // Re-arms once the figure is wholly out of the window, either way.
    const rearm = new IntersectionObserver((entries) => {
      if (entries.some((e) => !e.isIntersecting)) el.dataset.motion = "armed";
    });
    draw.observe(el);
    rearm.observe(el);
    return () => {
      draw.disconnect();
      rearm.disconnect();
    };
  }, []);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
