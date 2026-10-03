import { LegalDocView } from "@/components/legal-doc-view";

/** Complaint Policy — public, loads signed out. The body is the supplied document;
 *  see lib/legal-docs.ts for its version and effective date. */
export function generateMetadata() {
  return { title: "Complaint Policy" };
}

export default function Page() {
  return <LegalDocView slug="complaints" />;
}
