/**
 * auth-frame.tsx — the frame for signing in, signing up and the first setup
 * screens.
 *
 * One narrow column, nothing beside it: a person signing in at 9am wants the
 * fields, not a hero. The brand is the agency's on its verified custom domain,
 * so a client contact signing in to a white-labelled portal never sees ours.
 * The way to the other mode (sign in / create account) is top right, where it
 * is looked for, and the legal links sit at the foot.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { readHostBrand } from "@/lib/host-brand";
import { LEGAL_FOOTER_LINKS } from "@/lib/site-links";
import { PierMark } from "@/components/mark";
import { brandName } from "./public-frame";
import { HostUnverifiedBanner } from "./shell-banners";

export async function AuthFrame({
  aside,
  width = "narrow",
  children,
}: {
  /** Top-right: the link to the other mode, or the account in use. */
  aside?: ReactNode;
  width?: "narrow" | "wide";
  children: ReactNode;
}) {
  const brand = await readHostBrand();
  const branded = brand.state === "verified";
  return (
    <div data-harbor data-host-brand={brand.state} className="flex min-h-screen flex-col">
      {brand.state === "unverified" ? <HostUnverifiedBanner /> : null}
      <header className="border-b border-rule">
        <div className="mx-auto flex h-14 w-full max-w-[1240px] items-center gap-4 px-5 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5 text-act" aria-label={`${brandName(brand)} home`}>
            {branded && brand.logoUrl ? (
              <img src={brand.logoUrl} alt="" height={24} className="h-6 w-auto" />
            ) : (
              <PierMark size={26} />
            )}
            <span className="wide text-body font-bold tracking-[-0.01em] text-fg">{brandName(brand)}</span>
          </Link>
          <div className="ml-auto flex items-center gap-2 text-ui">{aside}</div>
        </div>
      </header>
      <main
        id="main"
        className={
          "mx-auto flex w-full flex-1 flex-col px-5 pb-16 pt-10 sm:px-8 sm:pt-16 " +
          (width === "wide" ? "max-w-[880px]" : "max-w-[440px]")
        }
      >
        {children}
      </main>
      <footer className="border-t border-rule">
        <nav aria-label="Legal" className="mx-auto flex w-full max-w-[1240px] flex-wrap gap-x-4 gap-y-1.5 px-5 py-4 text-meta sm:px-8">
          {LEGAL_FOOTER_LINKS.map(([href, label]) => (
            <Link key={href} href={href} className="text-fg-3 hover:text-fg">
              {label}
            </Link>
          ))}
        </nav>
      </footer>
    </div>
  );
}
