import { LegalDocument } from "@/components/harbor/legal-document";
import { requestOrigin } from "@/lib/metadata-origin";
import { legalMetadata } from "@/lib/seo";

/** Service Delivery Policy — public, loads signed out. How and when a paid
 *  plan is delivered; see lib/legal-docs.ts for its version and date. */
export async function generateMetadata() {
  return legalMetadata("delivery", await requestOrigin());
}

export default function Page() {
  return <LegalDocument slug="delivery" />;
}
