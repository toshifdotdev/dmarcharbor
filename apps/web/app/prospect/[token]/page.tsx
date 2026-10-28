import type { Metadata } from "next";
import { getProspectReport, PublicError } from "@/lib/api-public";
import { ArtefactFrame } from "@/components/harbor/artefact-frame";
import { ProspectDocument } from "@/components/harbor/prospect-document";

export const metadata: Metadata = { title: "Email security check", robots: { index: false, follow: false } };

/**
 * /prospect/:token — the prospect risk report an agency sent.
 *
 * No session and no workspace: the reader is not a customer yet. A revoked,
 * expired or made-up link reads the same as a failed fetch would, except that
 * a failure says to try again, because "this was withdrawn" would be untrue.
 */
export default async function ProspectPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let report = null;
  let failed = false;
  try {
    report = await getProspectReport(token);
  } catch (error) {
    failed = !(error instanceof PublicError && error.status === 404);
  }

  if (!report) {
    return (
      <ArtefactFrame kind="Email security check">
        <div
          data-testid={failed ? "prospect-failed" : "prospect-unavailable"}
          className="mx-auto flex min-h-[50vh] max-w-[60ch] flex-col justify-center gap-3"
        >
          <h1 className="display text-[30px] leading-[1.05]">
            {failed ? "This report could not be loaded just now." : "This report is no longer available."}
          </h1>
          <p className="text-body text-fg-2">
            {failed
              ? "Nothing is wrong with the link. Reload the page in a minute."
              : "The link has expired or was withdrawn by the team that sent it. Ask them for a current one."}
          </p>
        </div>
      </ArtefactFrame>
    );
  }

  const expires = new Date(report.expiresAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return (
    <ArtefactFrame
      kind="Email security check"
      publisher={report.preparedBy}
      testId="prospect-page"
      meta={<>Prepared by {report.preparedBy.workspaceName}. This link is valid until {expires}.</>}
    >
      <ProspectDocument report={report} />
    </ArtefactFrame>
  );
}
