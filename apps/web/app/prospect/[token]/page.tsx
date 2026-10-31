import type { Metadata } from "next";
import { getProspectReport, PublicError } from "@/lib/api-public";
import { retryAfterText } from "@/lib/retry-after";
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
  let limited: PublicError | null = null;
  try {
    report = await getProspectReport(token);
  } catch (error) {
    // 404 is the API's one answer for revoked, expired and unknown; 410 is the
    // same answer from a stricter proxy, as on the share and Trust Center pages.
    failed = !(error instanceof PublicError && (error.status === 404 || error.status === 410));
    if (error instanceof PublicError && error.status === 429) limited = error;
  }

  if (!report) {
    return (
      <ArtefactFrame kind="Email security check">
        <DocumentUnavailable
          testId={failed ? "prospect-failed" : "prospect-unavailable"}
          closed={!failed}
          title={
            limited
              ? "Too many requests for this report just now."
              : failed
                ? "This report could not be loaded just now."
                : "This report is no longer available."
          }
        >
          <p>
            {limited
              ? `Nothing is wrong with the link. ${retryAfterText(limited.retryAfterSeconds, "reload the page")}`
              : failed
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
