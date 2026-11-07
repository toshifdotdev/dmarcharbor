/**
 * auth-frame.tsx — the frame for signing in, signing up and the first setup
 * screens.
 *
 * Sign-in is one narrow column, nothing beside it: a person signing in at 9am
 * wants the fields, not a hero. The first-run screens (create an account,
 * name a workspace) are wider, because their route sits beside the form
 * (SetupLayout in setup-rail.tsx). The brand is the agency's on its verified
 * custom domain, so a client contact signing in to a white-labelled portal
 * never sees ours. The way to the other mode (sign in / create account) is top
 * right, where it is looked for, and the legal links sit at the foot. Header,
 * content and footer share the public pages' page-wrap edge.
 *
 * On an agency's verified domain the foot carries only the agency's name: our
 * legal pages are about us and the proxy sends them to the portal there, so a
 * client signing in is never offered a link that lands somewhere else. The
 * brand links to the portal, the client's landing on that host. When the
 * agency has published a support address or page, a quiet line under the form
 * says who to ask about signing in.
 */

import Link from "next/link";
import { clsx } from "clsx";
import type { ReactNode } from "react";
import { agencyContact } from "@/lib/agency-contact";
import { readHostBrand } from "@/lib/host-brand";
import { LEGAL_FOOTER_LINKS } from "@/lib/site-links";
import { PierMark, Wordmark } from "@/components/mark";
import { AgencyContactLine } from "./agency-contact";
import { brandName } from "./public-frame";
import { HostUnverifiedBanner } from "./shell-banners";

const WIDTH = {
  /** Sign in, recover a password, two-step codes. */
  narrow: "max-w-[400px]",
  /** A form beside its setup route. */
  route: "max-w-[1000px]",
  /** A form beside what the account already holds. */
  wide: "max-w-[920px]",
} as const;

export async function AuthFrame({
  aside,
  width = "narrow",
  children,
}: {
  /** Top-right: the link to the other mode, or the account in use. */
  aside?: ReactNode;
  width?: keyof typeof WIDTH;
  children: ReactNode;
}) {
  const brand = await readHostBrand();
  const branded = brand.state === "verified";
  // Only on the agency's verified domain: the reader is its client, and the
  // agency, not us, is who helps them sign in.
  const contact = branded ? agencyContact(brand) : null;
  return (
    <div data-harbor data-host-brand={brand.state} className="flex min-h-screen flex-col">
      {brand.state === "unverified" ? <HostUnverifiedBanner /> : null}
      {/* The brand sits exactly where the public header puts it (public-frame.tsx),
          so following "Sign in" from the home page does not move it. */}
      <header>
        <div className="page-wrap flex h-16 items-center gap-4 sm:h-[72px]">
          <Link
            href={branded ? "/portal" : "/"}
            className="inline-flex shrink-0 items-center gap-2.5 text-fg"
            aria-label={`${brandName(brand)} home`}
          >
            {branded && brand.logoUrl ? (
              <img src={brand.logoUrl} alt="" height={24} className="h-6 w-auto" />
            ) : (
              <PierMark size={22} />
            )}
            <Wordmark
              name={brandName(brand)}
              className="whitespace-nowrap text-[17px] font-bold tracking-[-0.01em] text-fg max-[380px]:hidden"
            />
          </Link>
          <div className="ml-auto flex items-center gap-2 text-ui">{aside}</div>
        </div>
      </header>
      <main id="main" className="page-wrap flex flex-1 flex-col pb-20 pt-8 sm:pt-14 min-[1100px]:pt-[72px]">
        <div className={clsx("mx-auto w-full", WIDTH[width])}>
          {children}
          <AgencyContactLine
            lead="Trouble signing in?"
            agency={brand.workspaceName}
            contact={contact}
            className="mt-8 text-meta text-fg-3"
            testId="auth-agency-contact"
          />
        </div>
      </main>
      <footer className="page-wrap">
        {branded ? (
          <p className="border-t border-rule py-4 text-meta text-fg-3">
            <span className="font-semibold text-fg-2">{brand.workspaceName}</span> client reports
          </p>
        ) : (
          <nav aria-label="Legal" className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-rule py-4 text-meta">
            {LEGAL_FOOTER_LINKS.map(([href, label]) => (
              <Link key={href} href={href} className="text-fg-3 hover:text-fg">
                {label}
              </Link>
            ))}
          </nav>
        )}
      </footer>
    </div>
  );
}
