import Link from "next/link";

/**
 * The 404. A route that does not exist is not an error state with a retry —
 * it says where the reader can actually go.
 */
export default function NotFound() {
  return (
    <main className="relative z-10 flex min-h-screen flex-col items-center justify-center gap-6 px-6">
      <p className="num text-[11px] tracking-[0.16em] uppercase" style={{ color: "var(--color-ink-3)" }}>
        404
      </p>
      <h1
        className="text-[25.5px] font-semibold tracking-[-0.03em]"
        style={{ fontFamily: "var(--font-display)" }}
      >
        This page does not exist.
      </h1>
      <p className="max-w-sm text-center text-[14px]" style={{ color: "var(--color-ink-2)" }}>
        The address may have changed or the link may be wrong. The routes below
        all exist.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <Link
          href="/"
          className="rounded-[2px] px-5 py-2.5 text-[13.5px] font-semibold"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
        >
          Go home
        </Link>
        <Link href="/pricing" className="text-[13.5px] underline" style={{ color: "var(--color-ink-2)" }}>
          Pricing
        </Link>
        <Link href="/sign-in" className="text-[13.5px] underline" style={{ color: "var(--color-ink-2)" }}>
          Sign in
        </Link>
      </div>
    </main>
  );
}
