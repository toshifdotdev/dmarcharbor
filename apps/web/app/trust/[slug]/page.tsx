import { getTrustCenter, PublicError } from "@/lib/api-public";
import { TrustCenterView } from "@/components/trust-center";

/**
 * The public Trust Center. NO AUTH, NO CREDENTIALS — an enterprise auditor
 * opens this with no account. It is not a settings page and must not look
 * like one: Monolith Light, document typography, every claim quoted from the
 * API's own payload. A missing or withdrawn slug answers 404 identically, so
 * this page can never confirm a client once existed.
 *
 * This route must stay public. If a change ever requires a session here, the
 * change is wrong.
 */
export default async function TrustCenterPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  try {
    const payload = await getTrustCenter(slug);
    return <TrustCenterView payload={payload} />;
  } catch (error) {
    const notFound =
      error instanceof PublicError && (error.status === 404 || error.status === 410);
    return (
      <main
        data-surface="artefact"
        className="artefact relative z-10 flex min-h-screen flex-col items-center justify-center px-6"
      >
        <p
          className="num text-[11px] tracking-[0.22em] uppercase"
          style={{ color: "var(--ink-3)" }}
        >
          Trust Center
        </p>
        <h1 className="mt-4 text-[26px]" style={{ color: "var(--ink)" }}>
          {notFound
            ? "No Trust Center at this address."
            : "The Trust Center is temporarily unavailable."}
        </h1>
        <p className="mt-3 max-w-md text-center text-[14px]" style={{ color: "var(--ink-2)" }}>
          {notFound
            ? "The link may have been withdrawn by the organization that published it. Ask them for a current link."
            : "Please try again in a moment. If the problem persists, contact the organization that sent you here."}
        </p>
      </main>
    );
  }
}
