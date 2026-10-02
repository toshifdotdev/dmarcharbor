/**
 * mark.tsx — The Pier (brand/pier.svg): an H for Harbor built as a pier —
 * two pilings standing in water, the crossbar drawn as the waterline between
 * them. Single colour, inherits currentColor (bone on ink).
 */

export function PierMark({
  size = 26,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      className={className}
      aria-hidden
    >
      <rect x="120" y="88" width="84" height="336" rx="18" fill="currentColor" />
      <rect x="308" y="88" width="84" height="336" rx="18" fill="currentColor" />
      <path
        d="M162 252 C 196 206, 236 206, 256 252 C 276 298, 316 298, 350 252"
        stroke="currentColor"
        strokeWidth="44"
        strokeLinecap="round"
      />
    </svg>
  );
}
