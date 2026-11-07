/**
 * mark.tsx — The Pier (brand/pier.svg): an H for Harbor built as a pier —
 * two pilings standing in water, the crossbar drawn as the waterline between
 * them. The pilings are two of the map's line colours, blue and green; the
 * waterline takes currentColor: ink on the white page. The tab and app icons
 * are built from the same geometry by brand/build-icons.mjs, on an ink tile
 * with a white waterline.
 *
 * `mono` draws the whole mark in currentColor, for a place that must carry
 * one colour only.
 */

/**
 * The product name beside the mark. Two words for the mark's two pilings:
 * "DMARC" in a lighter weight, "Harbor" in the name's full weight, both ink
 * (a coloured word would fail contrast at this size; the colour is in the
 * mark). Any other name, an agency's on its own domain, is set as given.
 * The text stays "DMARC Harbor" with its space, so it reads and copies as one name.
 */
export function Wordmark({ name, className }: { name: string; className?: string }) {
  if (name !== "DMARC Harbor") return <span className={className}>{name}</span>;
  return (
    <span className={className}>
      <span className="font-semibold text-fg-2">DMARC</span> <span className="font-[760] text-fg">Harbor</span>
    </span>
  );
}

export function PierMark({
  size = 26,
  className,
  mono = false,
}: {
  size?: number;
  className?: string;
  mono?: boolean;
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
      <rect x="120" y="88" width="84" height="336" rx="18" fill={mono ? "currentColor" : "var(--color-route-blue, #1f5fd6)"} />
      <rect x="308" y="88" width="84" height="336" rx="18" fill={mono ? "currentColor" : "var(--color-route-green, #13a050)"} />
      <path
        d="M162 252 C 196 206, 236 206, 256 252 C 276 298, 316 298, 350 252"
        stroke="currentColor"
        strokeWidth="44"
        strokeLinecap="round"
      />
    </svg>
  );
}
