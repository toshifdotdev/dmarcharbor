"use client";

/**
 * landing-motion.tsx — the home page's two kinds of motion. Both start after
 * hydration, so the server HTML is always the still, finished drawing.
 *
 * - useRide: messages riding a map's lines (SVG animateMotion). On only when
 *   the reader allows motion, and paused while the drawing is off screen.
 * - Reveal: a figure's lines draw themselves once as it scrolls into view.
 *   It arms only when the figure starts below the fold, so nothing already on
 *   screen ever blanks and redraws.
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
 * Scrolling back up until the figure is wholly below the window re-arms it,
 * so it draws again on the way down. The reset happens off screen, where it
 * cannot be seen. Leaving through the top of the window changes nothing: a
 * figure the reader has scrolled past stays drawn.
 */
export function Reveal({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (!window.matchMedia(MOTION_OK).matches) return;
    // A figure that starts on screen or above it is already drawn; only one
    // still below the window starts armed.
    if (el.getBoundingClientRect().top >= window.innerHeight) el.dataset.motion = "armed";

    // Draws when the figure is a fifth of the way up the window.
    const draw = new IntersectionObserver(
      (entries) => {
        if (el.dataset.motion === "armed" && entries.some((e) => e.isIntersecting)) el.dataset.motion = "run";
      },
      { rootMargin: "0px 0px -20% 0px" },
    );
    // Re-arms once the figure is entirely below the window again.
    const rearm = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const below = e.rootBounds ? e.boundingClientRect.top >= e.rootBounds.bottom : e.boundingClientRect.top > 0;
        if (!e.isIntersecting && below) el.dataset.motion = "armed";
      }
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
