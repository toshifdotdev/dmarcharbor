import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/api";
import { safeNext } from "@/lib/session";
import { AuthFrame } from "@/components/harbor/auth-frame";
import { AuthPanel } from "@/components/harbor/auth-panel";
import { SetupRail } from "@/components/harbor/setup-rail";

/**
 * /sign-up — the first of six stops on the way to reports arriving, and the
 * rail says so, so a newcomer sees the whole route before typing anything.
 * Someone already signed in goes to the next stop instead.
 */
export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next: rawNext } = await searchParams;
  const next = safeNext(rawNext);
  // The portfolio sends anyone without a workspace on to /welcome itself.
  if (await getSessionUserId()) redirect("/");

  return (
    <AuthFrame
      aside={
        <>
          <span className="hidden text-fg-3 sm:inline">Have an account?</span>
          <Link href={next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in"} className="link font-semibold">
            Sign in
          </Link>
        </>
      }
    >
      <SetupRail current="account" className="mb-10" />
      <AuthPanel initialMode="sign-up" next={next} />
    </AuthFrame>
  );
}
