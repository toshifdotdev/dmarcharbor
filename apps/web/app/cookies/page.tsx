import { LegalDocument } from "@/components/harbor/legal-document";
import { requestOrigin } from "@/lib/metadata-origin";
import { legalMetadata } from "@/lib/seo";

/** Cookie Policy — public, loads signed out. The body is the supplied document;
 *  see lib/legal-docs.ts for its version and effective date. The title and
 *  description come from the document's own entry so the ten legal pages cannot
 *  drift apart, or from each other. */
export async function generateMetadata() {
  return legalMetadata("cookies", await requestOrigin());
}

export default function Page() {
  return <LegalDocument slug="cookies" />;
}
