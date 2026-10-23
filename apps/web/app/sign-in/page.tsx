import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/api";
import { safeNext } from "@/lib/session";
import { AuthFrame } from "@/components/harbor/auth-frame";
import { AuthPanel } from "@/components/harbor/auth-panel";

/**
 * /sign-in — also where a password reset link lands (?token=…) and where a
 * session that expired mid-task sends you (?next=/the/page/you/were/on).
 *
 * Someone already signed in is sent on, not shown a form for an account they
 * are already using.
 */

const URL_ERRORS: Record<string, string> = {
  social: "That sign-in did not complete with the provider. Try again, or sign in with email.",
  INVALID_TOKEN: "That reset link is not valid any more: it was used already or it is over an hour old. Ask for a new one.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; token?: string; error?: string }>;
}) {
  const { next: rawNext, token, error } = await searchParams;
  const next = safeNext(rawNext);

  // A reset link is for someone who cannot sign in, so it never redirects.
  if (!token && (await getSessionUserId())) redirect(next ?? "/");

  return (
    <AuthFrame
      aside={
        <>
          <span className="hidden text-fg-3 sm:inline">New here?</span>
          <Link href="/sign-up" className="link font-semibold">
            Create an account
          </Link>
        </>
      }
    >
      <AuthPanel
        initialMode="sign-in"
        next={next}
        resetToken={token && !error ? token : null}
        initialError={error ? (URL_ERRORS[error] ?? "That did not work. Try again.") : null}
      />
    </AuthFrame>
  );
}
