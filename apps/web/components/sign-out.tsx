"use client";

import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await signOut();
        router.replace("/sign-in");
        router.refresh();
      }}
      className="text-[13px] tracking-[0.08em] uppercase transition-colors"
      style={{ color: "var(--color-ink-3)" }}
    >
      Sign out
    </button>
  );
}
