"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn, signUp } from "@/lib/auth-client";
import { TideLoader } from "@/components/posture";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "sign-in") {
        await signIn(email, password);
        router.replace("/");
        router.refresh();
      } else {
        await signUp(name, email, password);
        // Email verification is required before sign-in (API policy). Say so
        // instead of silently failing the next sign-in attempt.
        setNotice(
          "Account created. Check your inbox to verify your email address, then sign in.",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col gap-4">
      {mode === "sign-up" ? (
        <Field
          label="Name"
          value={name}
          onChange={setName}
          autoComplete="name"
          type="text"
        />
      ) : null}
      <Field
        label="Email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        type="email"
      />
      <Field
        label="Password"
        value={password}
        onChange={setPassword}
        autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
        type="password"
      />

      {error ? (
        <p role="alert" className="text-[14px]" style={{ color: "var(--color-block)" }}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-[14px]" style={{ color: "var(--color-unverified)" }}>
          {notice}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="mt-2 inline-flex items-center justify-center gap-3 rounded-[2px] px-5 py-2.5 text-[14.5px] font-semibold transition-colors"
        style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
      >
        {busy ? <TideLoader label="Working" /> : mode === "sign-in" ? "Sign in" : "Create account"}
      </button>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  type,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type: string;
  autoComplete: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      <input
        required
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-[2px] border px-3 py-2 text-[15px] outline-none"
        style={{
          background: "var(--color-surface)",
          borderColor: "var(--color-line-strong)",
          color: "var(--color-ink)",
        }}
      />
    </label>
  );
}
