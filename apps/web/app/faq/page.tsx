import { LegalDocView } from "@/components/legal-doc-view";
import { requestOrigin } from "@/lib/metadata-origin";
import { legalMetadata } from "@/lib/seo";

/** FAQ — public, loads signed out. The body is the supplied document;
 *  see lib/legal-docs.ts for its version and effective date. The title is the
 *  document's own, "Frequently Asked Questions", so a listing and the page agree
 *  on what it is called. */
export async function generateMetadata() {
  return legalMetadata("faq", await requestOrigin());
}

export default function Page() {
  return <LegalDocView slug="faq" />;
}
