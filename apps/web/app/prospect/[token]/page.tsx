import type { Metadata } from "next";
import { getProspectReport, PublicError } from "@/lib/api-public";
import { ArtefactFrame } from "@/components/harbor/artefact-frame";
import { DocumentUnavailable } from "@/components/harbor/artefact-states";
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
        <DocumentUnavailable
          testId={failed ? "prospect-failed" : "prospect-unavailable"}
          closed={!failed}
          title={failed ? "This report could not be loaded just now." : "This report is no longer available."}
        >
          <p>
            {failed
              ? "Nothing is wrong with the link. Reload the page in a minute."
              : "The link has expired or was withdrawn by the team that sent it. Ask them for a current one."}
          </p>
        </DocumentUnavailable>
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
      meta={<>Read from public DNS only. This link is valid until {expires}.</>}
    >
      <ProspectDocument report={report} />
    </ArtefactFrame>
  );
}
