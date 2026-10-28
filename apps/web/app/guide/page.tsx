import { LegalDocument } from "@/components/harbor/legal-document";
import { requestOrigin } from "@/lib/metadata-origin";
import { legalMetadata } from "@/lib/seo";

/** Setup guide — public, loads signed out. The body is docs/GUIDE.md: every
 *  step from a new account to p=reject, with the plan each step needs. It sits
 *  beside the FAQ in the document frame so the two are one click apart. */
export async function generateMetadata() {
  return legalMetadata("guide", await requestOrigin());
}

export default function Page() {
  return <LegalDocument slug="guide" />;
}
