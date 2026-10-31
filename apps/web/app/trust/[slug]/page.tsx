import type { Metadata } from "next";
import { getTrustCenter, PublicError } from "@/lib/api-public";
import { readHostBrand } from "@/lib/host-brand";
import { ArtefactFrame } from "@/components/harbor/artefact-frame";
import { DocumentUnavailable } from "@/components/harbor/artefact-states";
import { brandName } from "@/components/harbor/public-frame";
import { TrustDocument } from "@/components/harbor/trust-document";

/**
 * Not for search engines. The address is a capability: anyone holding it can
 * read the page, and the settings screen tells the agency it is not listed.
 * The API says the same with X-Robots-Tag on the data.
 */
export const metadata: Metadata = { title: "Trust Center", robots: { index: false, follow: false } };

/**
 * The public Trust Center. NO AUTH, NO CREDENTIALS: an auditor opens this with
 * no account. A missing and a withdrawn slug answer identically, so this page
 * can never confirm that a client once existed. A failure to reach the API is
 * said as such, and is not presented as "no Trust Center".
 *
 * The masthead names the agency that publishes the page, with its logo and
 * colours only when the workspace is white-labelled, as the prospect report
 * does. Where it is not white-labelled, the page says which platform it was
 * made with, by the host's name for it.
 *
 * This route must stay public. If a change ever requires a session here, the
 * change is wrong.
 */
export default async function TrustCenterPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let payload: Awaited<ReturnType<typeof getTrustCenter>> | null = null;
  let gone = false;
  try {
    payload = await getTrustCenter(slug);
  } catch (error) {
    gone = error instanceof PublicError && (error.status === 404 || error.status === 410);
  }

  if (!payload) {
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

  const host = await readHostBrand();
  // The platform is named only on our own, unbranded host, by the host's name for it.
  const platformName = host.state === "verified" ? null : brandName(host);
  const provider = payload.provider as typeof payload.provider & {
    branded?: boolean;
    logoUrl?: string | null;
    primaryColor?: string | null;
    accentColor?: string | null;
  };
  // An older API sends only the name; the masthead then follows the host, as before.
  const publisher =
    typeof provider.branded === "boolean"
      ? {
          workspaceName: provider.workspaceName,
          logoUrl: provider.logoUrl ?? null,
          primaryColor: provider.primaryColor ?? null,
          accentColor: provider.accentColor ?? null,
          branded: provider.branded,
        }
      : undefined;

  return (
    <ArtefactFrame
      kind="Trust Center"
      publisher={publisher}
      testId="trust-center"
      meta={<>Public, read-only, generated from the live record. Not listed by search engines.</>}
    >
      <TrustDocument payload={payload} platformName={platformName} />
    </ArtefactFrame>
  );
}
