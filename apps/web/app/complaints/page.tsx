import { LegalDocView } from "@/components/legal-doc-view";
import { requestOrigin } from "@/lib/metadata-origin";
import { legalMetadata } from "@/lib/seo";

/** Complaint Policy — public, loads signed out. The body is the supplied document;
 *  see lib/legal-docs.ts for its version and effective date. The title and
 *  description come from the document's own entry so the ten legal pages cannot
 *  drift apart, or from each other. */
export async function generateMetadata() {
  return legalMetadata("complaints", await requestOrigin());
}

export default function Page() {
  return <LegalDocView slug="complaints" />;
}
