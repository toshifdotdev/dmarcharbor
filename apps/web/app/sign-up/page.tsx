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
          One account, as many workspaces as your plan allows. Add clients and
          domains once you're in.
        </p>
      </div>

      <AuthForm mode="sign-up" />
      <SocialButtons />

      {/*
        The Terms are stated here so nobody creates an account without being told
        what the service is provided on. They are accepted on the next screen,
        alongside the Data Processing Agreement, because that is where the first
        workspace is created and the service is actually provided to it. The
        server refuses a workspace without both, so this text is a notice rather
        than the gate: the gate is the one that can be enforced.
      */}
      <p className="max-w-md text-center text-[12.5px] leading-[1.7]" style={{ color: "var(--color-ink-3)" }}>
        By continuing you agree to our{" "}
        <Link href="/terms" className="underline" style={{ color: "var(--color-ink-2)" }}>
          Terms of Service
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className="underline" style={{ color: "var(--color-ink-2)" }}>
          Privacy Policy
        </Link>
        . Your agreement to the Terms and the Data Processing Agreement is
        recorded when you create your first workspace.
      </p>

      <p className="text-[14px]" style={{ color: "var(--color-ink-3)" }}>
        Already have an account?{" "}
        <Link href="/sign-in" className="underline" style={{ color: "var(--color-ink-2)" }}>
          Sign in
        </Link>
      </p>
    </main>
  );
}
