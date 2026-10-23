"use client";

/**
 * section-nav.tsx — the work areas, one row, under the location bar.
 *
 * Ordered by how often an operator goes there in a day: watching first
 * (Portfolio, Clients, Alerts), then what goes out (Digests, Notifications),
 * then running the workspace (Settings, Billing), set apart by a gap. On a
 * narrow screen the row scrolls sideways rather than hiding behind a menu
 * button: seven labels are cheaper to swipe than to open.
 *
 * Domain detail and setup belong to the area they are reached from, so the
 * active mark stays on Portfolio or Clients while you are inside one.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";

type Item = { href: string; label: string; match: (p: string) => boolean };

const WATCH: Item[] = [
  { href: "/", label: "Portfolio", match: (p) => p === "/" || p.startsWith("/domains/") },
  { href: "/clients", label: "Clients", match: (p) => p.startsWith("/clients") || p.startsWith("/onboarding/") },
  { href: "/alerts", label: "Alerts", match: (p) => p.startsWith("/alerts") },
];
const OUTWARD: Item[] = [
  { href: "/digests", label: "Digests", match: (p) => p.startsWith("/digests") },
  { href: "/notifications", label: "Notifications", match: (p) => p.startsWith("/notifications") },
];
const RUN: Item[] = [
  { href: "/settings", label: "Settings", match: (p) => p.startsWith("/settings") },
  { href: "/billing", label: "Billing", match: (p) => p.startsWith("/billing") },
];

export function SectionNav() {
  const pathname = usePathname() ?? "/";
  const group = (items: Item[]) =>
    items.map((item) => {
      const on = item.match(pathname);
      return (
        <li key={item.href}>
          <Link
            href={item.href}
            aria-current={on ? "page" : undefined}
            className={clsx(
              "relative flex h-10 items-center whitespace-nowrap px-2.5 text-ui font-semibold transition-colors duration-75",
              on ? "text-fg" : "text-fg-3 hover:text-fg",
              // The active mark sits ON the bar's bottom hairline.
              on && "after:absolute after:inset-x-2.5 after:-bottom-px after:h-[2px] after:bg-act",
            )}
          >
            {item.label}
          </Link>
        </li>
      );
    });

  return (
    <nav
      aria-label="Sections"
      // On a phone the row is wider than the screen: the right edge fades so it
      // reads as "more this way", not as the end of the list.
      className="-mx-2.5 overflow-x-auto [scrollbar-width:none] max-md:[mask-image:linear-gradient(to_right,black_82%,transparent)]"
    >
      <ul className="flex items-stretch">
        {group(WATCH)}
        <li aria-hidden className="mx-2 my-3 w-px bg-rule" />
        {group(OUTWARD)}
        <li aria-hidden className="mx-2 my-3 w-px bg-rule" />
        {group(RUN)}
      </ul>
    </nav>
  );
}
