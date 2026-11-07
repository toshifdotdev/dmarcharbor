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
 *
 * On a verified custom domain the reader is the agency's client, and the
 * proxy sends our pricing, guides and legal pages to the portal there. So the
 * frame links to none of them on that host: no section nav, no "Start free",
 * no legal list, and no Pier mark beside the agency's name. What is left is
 * the agency's name, its logo when it has one, the portal and sign-in.
 */

import Link from "next/link";
import { clsx } from "clsx";
import type { HostBrand } from "@/lib/host-brand";
import { LEGAL_FOOTER_LINKS } from "@/lib/site-links";
import { PierMark, Wordmark } from "@/components/mark";
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

/** The agency's logo on its verified domain, our Pier everywhere else, nothing when the agency has no logo. */
function HostMark({ brand, size }: { brand: HostBrand; size: number }) {
  if (brand.state !== "verified") return <PierMark size={size} />;
  // Only a platform-served uploaded object ever reaches here (lib/host-brand.ts).
  return brand.logoUrl ? <img src={brand.logoUrl} alt="" height={size + 2} style={{ height: size + 2 }} className="w-auto" /> : null;
}

export function PublicHeader({ brand, current }: { brand: HostBrand; current?: Current }) {
  const name = brandName(brand);
  const agency = brand.state === "verified";
  return (
    <>
      {brand.state === "unverified" ? <HostUnverifiedBanner /> : null}
      <header className="bg-paper">
        <div className="page-wrap flex h-16 items-center gap-3 sm:h-[72px] sm:gap-10">
          <Link
            href={agency ? "/portal" : "/"}
            className="inline-flex shrink-0 items-center gap-2.5 text-fg"
            aria-label={`${name} home`}
          >
            <HostMark brand={brand} size={22} />
            <Wordmark name={name} className="whitespace-nowrap text-[17px] font-bold tracking-[-0.01em] max-[380px]:hidden" />
          </Link>
          {agency ? null : (
            <nav aria-label="Site" className="hidden items-center gap-[30px] min-[900px]:flex">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={current === item.key ? "page" : undefined}
                  className={clsx(
                    "relative text-[15.5px] font-medium transition-colors duration-100",
                    // The page you are on: a short length of line under it,
                    // in the accent, as the app's section bar marks one.
                    current === item.key
                      ? "text-fg after:absolute after:inset-x-0 after:-bottom-[7px] after:h-[3px] after:rounded-full after:bg-act"
                      : "text-fg-2 hover:text-fg",
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Link
              href="/sign-in"
              data-testid="home-signin"
              className="inline-flex h-10 items-center whitespace-nowrap rounded-full px-2.5 text-[15.5px] font-semibold text-fg transition-colors duration-100 hover:bg-fg/[0.06] sm:px-4"
            >
              Sign in
            </Link>
            {agency ? null : (
              <Link
                href="/sign-up"
                data-testid="home-start"
                className="inline-flex h-10 items-center whitespace-nowrap rounded-full bg-cta px-3.5 text-[15.5px] font-semibold text-cta-ink transition-colors duration-100 hover:bg-cta-hover sm:px-[18px]"
              >
                Start free
              </Link>
            )}
          </div>
        </div>
      </header>
    </>
  );
}

export function PublicFooter({ brand }: { brand: HostBrand }) {
  const name = brandName(brand);
  if (brand.state === "verified") {
    // The agency's client: its name, its portal and sign-in, and nothing of ours.
    return (
      <footer className="page-wrap">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-rule pb-16 pt-10 sm:pb-[72px]">
          <Link href="/portal" className="inline-flex items-center gap-2.5 text-[17px] font-bold tracking-[-0.01em] text-fg">
            <HostMark brand={brand} size={20} />
            <span>{name}</span>
          </Link>
          <nav aria-label="Client" className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {[
              ["/portal", "Client reports"],
              ["/sign-in", "Sign in"],
            ].map(([href, label]) => (
              <Link key={href} href={href} className="text-[14.5px] text-fg-2 transition-colors duration-100 hover:text-fg">
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    );
  }
  return (
    <footer className="page-wrap">
      {/* The same contained hairline every section above it uses. */}
      {/* 68.75rem is 1100px. A px breakpoint is not ordered against Tailwind's
          rem ones, so sm: would win over it; rem keeps the larger padding last. */}
      <div className="grid gap-10 border-t border-rule pb-16 pt-12 sm:pb-[72px] sm:pt-14 min-[56.25rem]:grid-cols-[minmax(0,1.4fr)_minmax(0,0.6fr)_minmax(0,1fr)] min-[68.75rem]:pb-20 min-[68.75rem]:pt-16">
        <div>
          <Link href="/" className="inline-flex items-center gap-2.5 text-[17px] font-bold tracking-[-0.01em] text-fg">
            <PierMark size={20} />
            <Wordmark name={name} />
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
