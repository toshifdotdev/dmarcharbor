/**
 * portal-denied.tsx — the shared fallback for a client contact who is signed
 * in but has no grant (or whose grant's domain is not theirs). Document
 * typography, because the portal is a client-facing artefact.
 */
export function PortalDenied({ message }: { message: string }) {
  return (
    <main
      data-surface="artefact"
      className="artefact relative z-10 flex min-h-screen flex-col items-center justify-center px-6"
    >
      <p
        className="num text-[11px] tracking-[0.22em] uppercase"
        style={{ color: "var(--ink-3)" }}
      >
        Client reports
      </p>
      <h1 className="mt-4 text-[26px]" style={{ color: "var(--ink)" }}>
        This account has no client report yet
      </h1>
      <p className="mt-3 max-w-md text-center text-[14px]" style={{ color: "var(--ink-2)" }}>
        {message}
      </p>
    </main>
  );
}
