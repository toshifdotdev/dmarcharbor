import { getPublicShareReport } from "@/lib/api-phase7";
import { ShareReportView } from "@/components/share-report";

/**
 * The public report share page. NO OPERATOR CHROME, NO NAV, NO WORKSPACE
 * CONTEXT — this is a document someone forwards to a client, fetched with no
 * credentials because the recipient has no account. Restrained document
 * typography, the same register as /trust/[slug].
 *
 * A revoked or expired token says so plainly and the page is rendered
 * uncached: a share that no longer exists must never serve a stale render,
 * and the message is identical for "never existed" and "revoked" so the
 * endpoint cannot be probed for a client's existence.
 */
export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Any outcome that is not a report: revoked, expired, never existed, or a
  // fetch failure: renders the SAME message below. That is deliberate: the
  // page must not let a token be probed for what it used to be.
  const report = await getPublicShareReport(token).catch(() => null);

  return (
    <main
      data-surface="artefact"
      className="artefact relative z-10 min-h-screen"
    >
      {report ? (
        <ShareReportView report={report} />
      ) : (
        <div
          className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center px-6 text-center"
          data-testid="share-unavailable"
        >
          <p
            className="num text-[11px] tracking-[0.22em] uppercase"
            style={{ color: "var(--ink-3)" }}
          >
            Shared report
          </p>
          <h1 className="mt-4 text-[26px]" style={{ color: "var(--ink)" }}>
            This report is no longer available.
          </h1>
          <p className="mt-3 text-[14px]" style={{ color: "var(--ink-2)" }}>
            The link has expired or was withdrawn by the team that shared it,
            and a withdrawn link is never re-served. Ask whoever sent it for a
            current link.
          </p>
        </div>
      )}
    </main>
  );
}
