import Link from "next/link";
import { PierMark } from "@/components/mark";
import { AuthForm } from "@/components/auth-form";
import { SocialButtons } from "@/components/social-buttons";

export default function SignUpPage() {
  return (
    <main className="relative z-10 flex min-h-screen flex-col items-center justify-center gap-10 px-6">
      <div className="flex flex-col items-center gap-4">
        <PierMark size={44} />
        <h1
          className="text-[27.5px] font-semibold tracking-[-0.03em]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Create your account
        </h1>
        <p className="max-w-xs text-center text-[14.5px]" style={{ color: "var(--color-ink-2)" }}>
          One account, one workspace. Add clients and domains once you're in.
        </p>
      </div>

      <AuthForm mode="sign-up" />
      <SocialButtons />

      <p className="text-[14px]" style={{ color: "var(--color-ink-3)" }}>
        Already have an account?{" "}
        <Link href="/sign-in" className="underline" style={{ color: "var(--color-ink-2)" }}>
          Sign in
        </Link>
      </p>
    </main>
  );
}
