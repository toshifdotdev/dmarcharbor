/**
 * tide.tsx — the Tide, the brand's loading mark, ported into the Chart system.
 *
 * Two wave strokes drifting in phase: water moving, nothing arriving yet. It
 * carries no word; the motion is the signal, and the caller supplies the
 * role="status" and the sr-only label (LoadingState in ./states does both).
 *
 * The stroke is the accent token (--color-act), so inside data-harbor a
 * tenant's colour reaches it like every other accent. The motion lives in
 * globals.css (.hb-tide). Under prefers-reduced-motion the global clamp runs
 * each animation once for 0.01ms and ends on its 100% keyframe, which is the
 * rest position, so the mark stands still; .hb-tide also names `animation:
 * none` there so the delayed second stroke cannot twitch.
 */

export function TideMark({ size = 48, className }: { size?: number; className?: string }) {
  // The viewBox leaves room on the right for the drift, so a stroke never clips.
  return (
    <svg
      width={size}
      height={Math.round(size * (60 / 132))}
      viewBox="0 0 132 60"
      fill="none"
      aria-hidden
      focusable="false"
      data-testid="tide-mark"
      className={className}
    >
      <g stroke="var(--color-act)" strokeWidth="11" strokeLinecap="round">
        <path className="hb-tide" d="M18 22 C 32 10, 46 10, 60 22 C 74 34, 88 34, 102 22" />
        <path className="hb-tide hb-tide-late" d="M18 42 C 32 30, 46 30, 60 42 C 74 54, 88 54, 102 42" />
      </g>
    </svg>
  );
}
