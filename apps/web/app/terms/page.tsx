import { LegalDocView } from "@/components/legal-doc-view";

/** Terms of Service — public, loads signed out. The body is the supplied document;
 *  see lib/legal-docs.ts for its version and effective date. */
export function generateMetadata() {
  return { title: "Terms of Service" };
}

export default function Page() {
  return <LegalDocView slug="terms" />;
}
