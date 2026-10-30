/**
 * icons.tsx — the handful of glyphs the product draws itself.
 *
 * Drawn here rather than pulled from an icon set so they share one stroke
 * (1.5 at 16px) with round ends and joins, the way the map's lines end. Few
 * icons; each one below names an action or a direction, never a mood. All are
 * decorative (aria-hidden): the control around them carries the name.
 */

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Glyph({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const ChevronDown = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4 6.5 8 10.5 12 6.5" />
  </Glyph>
);

export const ChevronRight = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M6.5 4 10.5 8 6.5 12" />
  </Glyph>
);

export const ArrowLeft = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M13 8H3.5M7 4.5 3.5 8 7 11.5" />
  </Glyph>
);

export const ArrowRight = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M3 8h9.5M9 4.5 12.5 8 9 11.5" />
  </Glyph>
);

export const SortGlyph = ({ dir, ...p }: IconProps & { dir: "asc" | "desc" | false }) => (
  <Glyph {...p}>
    <path d="M5 6.5 8 3.5 11 6.5" opacity={dir === "asc" ? 1 : 0.32} />
    <path d="M5 9.5 8 12.5 11 9.5" opacity={dir === "desc" ? 1 : 0.32} />
  </Glyph>
);

export const Search = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.25 10.25 13.5 13.5" />
  </Glyph>
);

export const Close = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Glyph>
);

export const Menu = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </Glyph>
);

export const Plus = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M8 3v10M3 8h10" />
  </Glyph>
);

export const Check = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
  </Glyph>
);

export const Refresh = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M12.5 6.5A4.75 4.75 0 1 0 12.75 9" />
    <path d="M12.75 3v3.75H9" />
  </Glyph>
);

export const External = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M9.5 3H13v3.5M13 3 7.5 8.5M11 9.5V13H3V5h3.5" />
  </Glyph>
);

export const Lock = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
    <path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" />
  </Glyph>
);
