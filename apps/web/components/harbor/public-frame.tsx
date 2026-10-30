/**
 * public-frame.tsx — the header and footer of every public page, the home
 * page included, in the Routes language (.kiro/steering/design-system.md).
 *
 * One frame for all of them, so the home page and the pages it links to can
 * never drift apart. White, no rule under the header, the Pier mark in ink,
 * three places a buyer looks for, and the two ways in as pills.
 *
 * Same white-label rule as the app: on a verified custom domain the agency's
 * name replaces ours everywhere and BrandApplier recolours the primary action;
 * an unverified one says so plainly and serves the default brand. Every link
 * here resolves to a route that exists.
 */

import Link from "next/link";
import { clsx } from "clsx";
import type { HostBrand } from "@/lib/host-brand";
import { LEGAL_FOOTER_LINKS } from "@/lib/site-links";
import { PierMark } from "@/components/mark";
import { HostUnverifiedBanner } from "./shell-banners";

export function brandName(brand: HostBrand): string {
  return brand.state === "verified" ? brand.workspaceName : "DMARC Harbor";
}

type Current = "pricing" | "how" | "guide" | "support" | "legal";

const NAV: Array<{ href: string; label: string; key: Current }> = [
  { href: "/pricing", label: "Pricing", key: "pricing" },
  { href: "/guide", label: "Setup guide", key: "guide" },
  { href: "/support", label: "Support", key: "support" },
];

export function PublicHeader({ brand, current }: { brand: HostBrand; current?: Current }) {
  const name = brandName(brand);
  return (
    <>
      {brand.state === "unverified" ? <HostUnverifiedBanner /> : null}
      <header className="bg-paper">
        <div className="page-wrap flex h-16 items-center gap-3 sm:h-[72px] sm:gap-10">
          <Link href="/" className="inline-flex shrink-0 items-center gap-2.5 text-fg" aria-label={`${name} home`}>
            <PierMark size={22} />
            <span className="whitespace-nowrap text-[17px] font-bold tracking-[-0.01em] max-[380px]:hidden">{name}</span>
          </Link>
          <nav aria-label="Site" className="hidden items-center gap-[30px] min-[900px]:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={current === item.key ? "page" : undefined}
                className={clsx(
                  "text-[15.5px] font-medium transition-colors duration-100",
                  current === item.key ? "text-fg" : "text-fg-2 hover:text-fg",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <Link
              href="/sign-in"
              data-testid="home-signin"
              className="inline-flex h-10 items-center whitespace-nowrap rounded-full px-2.5 text-[15.5px] font-semibold text-fg transition-colors duration-100 hover:bg-fg/[0.06] sm:px-4"
            >
              Sign in
            </Link>
            <Link
              href="/sign-up"
              data-testid="home-start"
              className="inline-flex h-10 items-center whitespace-nowrap rounded-full bg-cta px-3.5 text-[15.5px] font-semibold text-cta-ink transition-colors duration-100 hover:bg-cta-hover sm:px-[18px]"
            >
              Start free
            </Link>
          </div>
        </div>
      </header>
    </>
  );
}

export function PublicFooter({ brand }: { brand: HostBrand }) {
  const name = brandName(brand);
  return (
    <footer className="page-wrap">
      {/* The same contained hairline every section above it uses. */}
      <div className="grid gap-10 border-t border-rule pb-16 pt-12 sm:pb-[72px] sm:pt-14 min-[900px]:grid-cols-[minmax(0,1.4fr)_minmax(0,0.6fr)_minmax(0,1fr)] min-[1100px]:pb-20 min-[1100px]:pt-16">
        <div>
          <Link href="/" className="inline-flex items-center gap-2.5 text-[17px] font-bold tracking-[-0.01em] text-fg">
            <PierMark size={20} />
            <span>{name}</span>
          </Link>
          <p className="mt-3.5 max-w-[26rem] text-[14.5px] leading-[1.5] text-fg-4">
            DMARC monitoring for MSPs and agencies. It reads reports, never sends mail as anyone, and changes DNS only
            when you ask.
          </p>
        </div>
        <nav aria-label="Product">
          <p className="mb-3 text-[14px] font-bold text-fg">Product</p>
          <div className="grid justify-items-start gap-2">
            {[
              ["/pricing", "Pricing"],
              ["/verify", "Verify a pack"],
              ["/sign-in", "Sign in"],
              ["/sign-up", "Start free"],
            ].map(([href, label]) => (
              <Link key={href} href={href} className="text-[14.5px] text-fg-2 transition-colors duration-100 hover:text-fg">
                {label}
              </Link>
            ))}
          </div>
        </nav>
        <nav aria-label="Legal">
          <p className="mb-3 text-[14px] font-bold text-fg">Legal and support</p>
          <div className="grid grid-cols-[repeat(2,max-content)] gap-x-9 gap-y-2">
            {LEGAL_FOOTER_LINKS.map(([href, label]) => (
              <Link key={href} href={href} className="text-[14.5px] text-fg-2 transition-colors duration-100 hover:text-fg">
                {label}
              </Link>
            ))}
          </div>
        </nav>
      </div>
    </footer>
  );
}
