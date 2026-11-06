import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/api";
import { readHostBrand } from "@/lib/host-brand";
import { safeNext } from "@/lib/session";
import { signInErrorMessage } from "@/lib/sign-in-errors";
import { AuthFrame } from "@/components/harbor/auth-frame";
import { AuthPanel } from "@/components/harbor/auth-panel";

/**
 * /sign-in — also where a password reset link lands (?token=…) and where a
 * session that expired mid-task sends you (?next=/the/page/you/were/on).
 *
 * Someone already signed in is sent on, not shown a form for an account they
 * are already using.
 *
 * On an agency's verified custom domain the reader is the agency's client:
 * the form speaks to them, lands on the portal, and offers email and password
 * only (the panel's `portal` mode explains why).
 */

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; token?: string; error?: string | string[] }>;
}) {
  const { next: rawNext, token, error } = await searchParams;
  const next = safeNext(rawNext);
  // Better Auth appends its error code to the errorCallbackURL, so a provider
  // failure can carry two `error` values; sign-in-errors.ts reads the last.
  const errorCode = Array.isArray(error) ? error.at(-1) : error;
  const errorMessage = signInErrorMessage(error);

  const brand = await readHostBrand();
  const portal = brand.state === "verified" ? { agency: brand.workspaceName } : null;

  // A reset link is for someone who cannot sign in, so it never redirects.
  if (!token && (await getSessionUserId())) redirect(next ?? (portal ? "/portal" : "/"));

  return (
    <AuthFrame
      aside={
        <>
          <span className="hidden text-fg-3 sm:inline">New here?</span>
          <Link href={next ? `/sign-up?next=${encodeURIComponent(next)}` : "/sign-up"} className="link font-semibold">
            Create an account
          </Link>
        </>
      }
    >
      <AuthPanel
        initialMode="sign-in"
        next={next}
        resetToken={token && !errorCode ? token : null}
        initialError={errorMessage}
        portal={portal}
      />
    </AuthFrame>
  );
}
