import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";

/**
 * The 404. A route that does not exist is not an error state with a retry: it
 * says where the reader can actually go. On the paper ground, because every
 * page it can be reached from is.
 */
export default function NotFound() {
  return (
    <div data-harbor className="flex min-h-screen w-full flex-col bg-paper">
      <main className="mx-auto flex w-full max-w-[600px] flex-1 flex-col justify-center gap-4 px-6 py-16">
        <p className="legend">404 · Not found</p>
        <h1 className="display text-h1 text-fg">This page does not exist.</h1>
        <p className="text-body text-fg-2">
          The address may have changed, or the link may be wrong. These all exist:
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <ButtonLink href="/" variant="primary">
            Go to the start
          </ButtonLink>
          <Link href="/clients" className="link text-ui">
            Clients
          </Link>
          <Link href="/pricing" className="link text-ui">
            Pricing
          </Link>
          <Link href="/sign-in" className="link text-ui">
            Sign in
          </Link>
        </div>
      </main>
    </div>
  );
}
