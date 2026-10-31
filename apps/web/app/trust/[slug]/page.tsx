import { getTrustCenter, PublicError } from "@/lib/api-public";
import { ArtefactFrame } from "@/components/harbor/artefact-frame";
import { DocumentUnavailable } from "@/components/harbor/artefact-states";
import { TrustDocument } from "@/components/harbor/trust-document";

/**
 * The public Trust Center. NO AUTH, NO CREDENTIALS: an auditor opens this with
 * no account. A missing and a withdrawn slug answer identically, so this page
 * can never confirm that a client once existed. A failure to reach the API is
 * said as such, and is not presented as "no Trust Center".
 *
 * This route must stay public. If a change ever requires a session here, the
 * change is wrong.
 */
export default async function TrustCenterPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  try {
    const payload = await getTrustCenter(slug);
    return (
      <ArtefactFrame kind="Trust Center" meta={<>Public, read-only, generated from the live record.</>}>
        <TrustDocument payload={payload} />
      </ArtefactFrame>
    );
  } catch (error) {
    const gone = error instanceof PublicError && (error.status === 404 || error.status === 410);
    return (
      <ArtefactFrame kind="Trust Center">
        <DocumentUnavailable
          closed={gone}
          title={gone ? "No Trust Center at this address." : "The Trust Center is temporarily unavailable."}
        >
          <p>
            {gone
              ? "The link may have been withdrawn by the organization that published it. Ask them for a current link."
              : "This is a failure to reach it, not a missing page. Please try again in a moment; if it persists, contact the organization that sent you here."}
          </p>
        </DocumentUnavailable>
      </ArtefactFrame>
    );
  }
}
