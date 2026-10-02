import Link from "next/link";
import { PierMark } from "@/components/mark";
import { AuthForm } from "@/components/auth-form";
import { SocialButtons } from "@/components/social-buttons";

export default function SignInPage() {
  return (
    <main className="relative z-10 flex min-h-screen flex-col items-center justify-center gap-10 px-6">
      <div className="flex flex-col items-center gap-4">
        <PierMark size={44} />
        <h1
          className="text-[26px] font-semibold tracking-[-0.03em]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          DMARC Harbor
        </h1>
        <p className="max-w-xs text-center text-[13px]" style={{ color: "var(--color-ink-2)" }}>
          Measurement and evidence about what the world's mail servers think
          of your sending infrastructure.
        </p>
      </div>

      <AuthForm mode="sign-in" />
      <SocialButtons />

      <p className="text-[12.5px]" style={{ color: "var(--color-ink-3)" }}>
        No account yet?{" "}
        <Link href="/sign-up" className="underline" style={{ color: "var(--color-ink-2)" }}>
          Create one
        </Link>
      </p>
    </main>
  );
}
