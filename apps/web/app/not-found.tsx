import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { PierMark } from "@/components/mark";
import { brandName } from "@/components/harbor/public-frame";
import { readHostBrand } from "@/lib/host-brand";

/**
 * The 404. A route that does not exist is not an error state with a retry: it
 * says where the reader can actually go. Drawn in the map's language: the line
 * the reader followed runs out, dotted, at a closed station, the convention
 * for something that is not there.
 *
 * Reached from public pages and from the app alike, so it carries only the
 * mark and the name (the agency's on its verified domain), not either frame.
 */
export default async function NotFound() {
  const brand = await readHostBrand();
  const name = brandName(brand);

  return (
    <div data-harbor data-host-brand={brand.state} className="flex min-h-screen w-full flex-col bg-paper">
      <header className="page-wrap flex h-16 shrink-0 items-center sm:h-[72px]">
        <Link href="/" className="inline-flex items-center gap-2.5 text-fg" aria-label={`${name} home`}>
          <PierMark size={22} />
          <span className="text-[17px] font-bold tracking-[-0.01em]">{name}</span>
        </Link>
      </header>

      <main id="main" className="page-wrap flex flex-1 flex-col justify-center pb-24 pt-10">
        <div className="grid items-center gap-x-16 gap-y-12 min-[68.75rem]:grid-cols-[minmax(0,0.74fr)_minmax(0,1fr)]">
          <div className="max-w-[36rem]">
            <p className="text-[15px] text-fg-4">
              <span className="font-bold text-fg">404</span> not found
            </p>
            <h1 className="mt-4 text-[44px] font-[760] leading-[0.96] tracking-[-0.035em] text-fg [text-wrap:balance] sm:text-[60px]">
              This page does not exist.
            </h1>
            <p className="mt-6 text-[17px] leading-[1.5] text-fg-2 sm:text-[19px]">
              The address may have changed, or the link may be wrong. These all exist:
            </p>
            <nav aria-label="Places that exist" className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
              <ButtonLink href="/" variant="primary" size="lg">
                Go to the start
              </ButtonLink>
              {[
                ["/clients", "Clients"],
                ["/pricing", "Pricing"],
                ["/sign-in", "Sign in"],
              ].map(([href, label]) => (
                <Link key={href} href={href} className="link text-[16px] font-semibold">
                  {label}
                </Link>
              ))}
            </nav>
          </div>

          <figure className="m-0 hidden min-w-0 sm:block">
            <svg viewBox="0 0 560 150" className="block h-auto w-full max-w-[560px] overflow-visible" role="img" aria-label="A line that runs out at a closed station">
              {/* The line the reader followed. */}
              <path d="M24 80 H300" fill="none" stroke="var(--color-fg)" strokeWidth="7" strokeLinecap="round" />
              {/* Where it should have gone: not built, so dotted grey. */}
              <path d="M318 80 H470" fill="none" stroke="var(--color-rule-2)" strokeWidth="7" strokeLinecap="round" strokeDasharray="0.1 16" />
              <circle cx="24" cy="80" r="9" fill="#ffffff" stroke="var(--color-fg)" strokeWidth="3" />
              <rect x="182" y="64" width="24" height="32" rx="12" fill="#ffffff" stroke="var(--color-fg)" strokeWidth="3" />
              {/* The closed station: hollow and grey. */}
              <rect x="470" y="60" width="32" height="40" rx="16" fill="#ffffff" stroke="var(--color-rule-2)" strokeWidth="3" />
              <text x="24" y="44" fill="var(--color-fg)" fontSize="15" fontWeight="700" fontFamily="var(--font-ui)">
                The link you followed
              </text>
              <text x="194" y="128" textAnchor="middle" fill="var(--color-fg-4)" fontSize="13.5" fontWeight="500" fontFamily="var(--font-ui)">
                {name}
              </text>
              <text x="486" y="40" textAnchor="middle" fill="var(--color-fg-4)" fontSize="15" fontWeight="700" fontFamily="var(--font-ui)">
                No page here
              </text>
              <text x="486" y="128" textAnchor="middle" fill="var(--color-fg-4)" fontSize="13.5" fontWeight="500" fontFamily="var(--font-ui)">
                closed station
              </text>
            </svg>
          </figure>
        </div>
      </main>
    </div>
  );
}
