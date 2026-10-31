/**
 * not-found-view.tsx — the 404, in whichever frame the reader is in.
 *
 * A route that does not exist is not an error state with a retry: it says
 * where the reader can actually go. Drawn in the map's language: the line the
 * reader followed runs out, dotted, at a closed station, the convention for
 * something that is not there.
 *
 * Two frames, chosen per request:
 *
 *   - signed in, with a workspace: the app's own shell (AppShell), so a
 *     mistyped settings address or a domain from another workspace leaves the
 *     operator inside the app with its navigation, not on a bare page;
 *   - anyone else (signed out, a portal contact, no workspace yet, or the API
 *     not answering): a slim public page that carries only the host's mark and
 *     name. Never the public header: on an agency's verified domain it would
 *     link to our pricing and sign-up, and this page must not.
 *
 * The signed-in probe never redirects and never throws. A 404 is not the place
 * to send someone to sign in, and a failed probe falls back to the public page.
 */

import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { PierMark } from "@/components/mark";
import { getSessionUser } from "@/lib/api";
import { readHostBrand, type HostBrand } from "@/lib/host-brand";
import { resolveActiveWorkspace } from "@/lib/session";
import type { WorkspaceSummary } from "@/lib/types";
import { AppShell, type TrailItem } from "./app-shell";
import { PageHeader } from "./page-header";
import { brandName } from "./public-frame";
import { HostUnverifiedBanner } from "./shell-banners";

type Place = { href: string; label: string };

/** The workspace context of a signed-in reader, or null. Never redirects. */
async function signedInWorkspace(): Promise<{ workspaces: WorkspaceSummary[]; active: WorkspaceSummary } | null> {
  if (!(await getSessionUser())) return null;
  try {
    const { workspaces, active } = await resolveActiveWorkspace();
    return active ? { workspaces, active } : null;
  } catch (error) {
    // resolveActiveWorkspace redirects to sign-in on a 401/403 (and lib/api to
    // security setup on MFA_REQUIRED). Swallowed here on purpose: a 404 that
    // turned into a sign-in page would hide what actually happened, and the
    // public 404 is the right answer for a reader whose session is not usable.
    if (isRedirectSignal(error)) return null;
    // Every other framework signal (dynamic rendering, for one) must reach
    // Next; an API failure falls back to the public page.
    unstable_rethrow(error);
    return null;
  }
}

/** Next's redirect() throws an error whose digest starts NEXT_REDIRECT. */
function isRedirectSignal(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("digest" in error)) return false;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

/** Where a reader on this host can go. No marketing on an agency's domain. */
function publicPlaces(brand: HostBrand): Place[] {
  if (brand.state === "verified") {
    return [
      { href: "/sign-in", label: "Sign in" },
      { href: "/portal", label: "Client reports" },
    ];
  }
  return [
    { href: "/sign-in", label: "Sign in" },
    { href: "/pricing", label: "Pricing" },
    { href: "/support", label: "Support" },
  ];
}

export async function NotFoundView({
  title,
  lead,
  appPlaces,
  trail,
}: {
  title: string;
  lead: ReactNode;
  /** The ways back inside the app, after the portfolio. */
  appPlaces: Place[];
  /** Breadcrumb for the app frame. */
  trail: TrailItem[];
}) {
  const [brand, signedIn] = await Promise.all([readHostBrand(), signedInWorkspace()]);
  const name = brandName(brand);

  if (signedIn) {
    return (
      <AppShell workspaces={signedIn.workspaces} activeWorkspace={signedIn.active} trail={trail}>
        <div data-testid="not-found" className="flex flex-col gap-8">
          <PageHeader title={title} lede={lead} />
          <nav aria-label="Places that exist" className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <ButtonLink href="/" variant="primary">
              Back to the portfolio
            </ButtonLink>
            {appPlaces.map((place) => (
              <Link key={place.href} href={place.href} className="link text-ui font-semibold">
                {place.label}
              </Link>
            ))}
          </nav>
          <ClosedStation name={name} className="max-w-[560px]" />
        </div>
      </AppShell>
    );
  }

  const verified = brand.state === "verified";
  return (
    <div data-harbor data-host-brand={brand.state} className="flex min-h-screen w-full flex-col bg-paper">
      {/* Any element carrying data-host-brand="unverified" carries the banner
          too: the clickthrough's unverified-host check reads them together. */}
      {brand.state === "unverified" ? <HostUnverifiedBanner /> : null}
      <header className="page-wrap flex h-16 shrink-0 items-center sm:h-[72px]">
        <Link href="/" className="inline-flex items-center gap-2.5 text-fg" aria-label={`${name} home`}>
          {verified && brand.logoUrl ? (
            // Only a platform-served uploaded object reaches here (lib/host-brand.ts).
            <img src={brand.logoUrl} alt="" height={24} className="h-6 w-auto" />
          ) : verified ? null : (
            <PierMark size={22} />
          )}
          <span className="text-[17px] font-bold tracking-[-0.01em]">{name}</span>
        </Link>
      </header>

      <main id="main" data-testid="not-found" className="page-wrap flex flex-1 flex-col justify-center pb-24 pt-10">
        <div className="grid items-center gap-x-16 gap-y-12 min-[68.75rem]:grid-cols-[minmax(0,0.74fr)_minmax(0,1fr)]">
          <div className="max-w-[36rem]">
            <p className="text-[15px] text-fg-4">
              <span className="font-bold text-fg">404</span> not found
            </p>
            <h1 className="mt-4 text-[44px] font-[760] leading-[0.96] tracking-[-0.035em] text-fg [text-wrap:balance] sm:text-[60px]">
              {title}
            </h1>
            <div className="mt-6 text-[17px] leading-[1.5] text-fg-2 sm:text-[19px]">{lead}</div>
            <nav aria-label="Places that exist" className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
              <ButtonLink href="/" variant="primary" size="lg">
                Go to the start
              </ButtonLink>
              {publicPlaces(brand).map((place) => (
                <Link key={place.href} href={place.href} className="link text-[16px] font-semibold">
                  {place.label}
                </Link>
              ))}
            </nav>
          </div>

          <figure className="m-0 hidden min-w-0 sm:block">
            <ClosedStation name={name} />
          </figure>
        </div>
      </main>
    </div>
  );
}

/** The line the reader followed, running out at a closed station. */
function ClosedStation({ name, className }: { name: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 560 150"
      className={`block h-auto w-full max-w-[560px] overflow-visible ${className ?? ""}`}
      role="img"
      aria-label="A line that runs out at a closed station"
    >
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
  );
}
