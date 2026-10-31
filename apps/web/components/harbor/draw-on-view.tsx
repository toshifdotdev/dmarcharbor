"use client";

/**
 * draw-on-view.tsx — lets a route drawing play forward when it comes into view.
 *
 * The server HTML is the still, final drawing. After mount, and only when
 * reduced motion is not set, this marks the nearest `[data-draw]` ancestor
 * with `data-play` each time the drawing enters the window, so its CSS plays
 * the line forward once (setup-rail.module.css). It is removed while the
 * drawing is away, so the next visit plays it again. Never backwards, never
 * tied to the scroll position.
 */

import { useEffect, useRef } from "react";

export function DrawOnView() {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const host = ref.current?.closest<HTMLElement>("[data-draw]");
    if (!host || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let away = true;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting && away) {
          away = false;
          host.removeAttribute("data-play");
          // Read layout once so the restarted animation starts from its first frame.
          void host.offsetWidth;
          host.setAttribute("data-play", "");
        } else if (!entry.isIntersecting) {
          away = true;
          host.removeAttribute("data-play");
        }
      },
      { threshold: 0.35 },
    );
    io.observe(host);
    return () => io.disconnect();
  }, []);

  return <span ref={ref} hidden />;
}
