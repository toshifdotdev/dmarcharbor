/**
 * public-frame.tsx — header and footer for every public Chart page.
 *
 * Same white-label rule as the app: on a verified custom domain the agency's
 * name replaces ours everywhere and BrandApplier recolours the accent; an
 * unverified one says so plainly and serves the default brand. Every link here
 * resolves to a route that exists.
 */

import Link from "next/link";
import type { HostBrand } from "@/lib/host-brand";
import { LEGAL_FOOTER_LINKS } from "@/lib/site-links";
import { PierMark } from "@/components/mark";
import { ButtonLink } from "@/components/ui/button";
import { HostUnverifiedBanner } from "./shell-banners";

export function brandName(brand: HostBrand): string {
  return brand.state === "verified" ? brand.workspaceName : "DMARC Harbor";
}

export function PublicHeader({ brand, current }: { brand: HostBrand; current?: "pricing" | "how" | "support" | "legal" }) {
  return (
    <>
      {brand.state === "unverified" ? <HostUnverifiedBanner /> : null}
      <header className="border-b border-rule bg-paper">
        <div className="mx-auto flex h-14 w-full max-w-[1240px] items-center gap-6 px-5 sm:px-8">
          <Link href="/" className="flex shrink-0 items-center gap-2.5 text-act" aria-label={`${brandName(brand)} home`}>
            <PierMark size={26} />
            <span className="wide whitespace-nowrap text-body font-bold tracking-[-0.01em] text-fg">{brandName(brand)}</span>
          </Link>
          <nav aria-label="Site" className="hidden items-center gap-5 whitespace-nowrap text-ui font-semibold lg:flex">
            <Link href="/#how" className={current === "how" ? "text-fg" : "text-fg-2 hover:text-fg"}>
              How DMARC decides
            </Link>
            <Link
              href="/pricing"
              aria-current={current === "pricing" ? "page" : undefined}
              className={current === "pricing" ? "text-fg" : "text-fg-2 hover:text-fg"}
            >
              Pricing
            </Link>
            <Link href="/verify" className="text-fg-2 hover:text-fg">
              Verify a pack
            </Link>
            <Link
              href="/support"
              aria-current={current === "support" ? "page" : undefined}
              className={current === "support" ? "text-fg" : "text-fg-2 hover:text-fg"}
            >
              Support
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ButtonLink href="/sign-in" variant="ghost" data-testid="home-signin">
              Sign in
            </ButtonLink>
            <ButtonLink href="/sign-up" variant="primary" data-testid="home-start">
              Start free
            </ButtonLink>
          </div>
        </div>
      </header>
    </>
  );
}

export function PublicFooter({ brand }: { brand: HostBrand }) {
  const name = brandName(brand);
  return (
    <footer className="border-t border-rule bg-paper">
      <div className="mx-auto grid w-full max-w-[1240px] gap-8 px-5 py-10 sm:px-8 md:grid-cols-[1.2fr_1fr_1fr]">
        <div>
          <Link href="/" className="flex items-center gap-2 text-act">
            <PierMark size={20} />
            <span className="wide text-body font-bold text-fg">{name}</span>
          </Link>
          <p className="mt-3 max-w-[40ch] text-ui text-fg-2">
            Measurement and evidence about email authentication, for agencies and MSPs. It reads reports; it never
            edits DNS or sends mail as anyone.
          </p>
        </div>
        <nav aria-label="Product" className="flex flex-col gap-2 text-ui">
          <p className="legend">Product</p>
          <Link href="/pricing" className="text-fg-2 hover:text-fg">
            Pricing
          </Link>
          <Link href="/verify" className="text-fg-2 hover:text-fg">
            Public fingerprint verifier
          </Link>
          <Link href="/sign-in" className="text-fg-2 hover:text-fg">
            Sign in
          </Link>
          <Link href="/sign-up" className="text-fg-2 hover:text-fg">
            Start free
          </Link>
        </nav>
        <nav aria-label="Legal" className="flex flex-col gap-2 text-ui">
          <p className="legend">Legal and support</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {LEGAL_FOOTER_LINKS.map(([href, label]) => (
              <Link key={href} href={href} className="text-fg-2 hover:text-fg">
                {label}
              </Link>
            ))}
          </div>
        </nav>
      </div>
    </footer>
  );
}
