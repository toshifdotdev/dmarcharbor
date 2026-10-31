import { getPublicShareReport } from "@/lib/api-phase7";
import { ArtefactFrame } from "@/components/harbor/artefact-frame";
import { DocumentUnavailable } from "@/components/harbor/artefact-states";
import { ShareDocument } from "@/components/harbor/share-document";

/**
 * The public report share page. No operator chrome, no workspace context: a
 * document someone forwards to a client, fetched with no credentials because
 * the recipient has no account.
 *
 * A revoked, expired or never-existing token, and a fetch failure, all render
 * the SAME message, so the endpoint cannot be probed for what a token used to
 * be. Rendered per request (the root layout is dynamic), never a stale copy.
 */
export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const report = await getPublicShareReport(token).catch(() => null);

  if (!report) {
    return (
      <ArtefactFrame kind="Shared report">
        <DocumentUnavailable testId="share-unavailable" closed title="This report is no longer available.">
          <p>
            The link has expired or was withdrawn by the team that shared it, and a withdrawn link is never served
            again. Ask whoever sent it for a current link.
          </p>
        </DocumentUnavailable>
      </ArtefactFrame>
    );
  }

  const expires = new Date(report.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  return (
    <ArtefactFrame kind="Shared report" meta={<>Link valid until {expires}. Read-only; nothing on this page changes the domain.</>}>
      <ShareDocument report={report} today={new Date(report.generatedAt).toISOString().slice(0, 10)} />
    </ArtefactFrame>
  );
}
