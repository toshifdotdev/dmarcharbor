import { LegalDocView } from "@/components/legal-doc-view";

/** Data Processing Agreement — public, loads signed out. The body is the supplied document;
 *  see lib/legal-docs.ts for its version and effective date. */
export function generateMetadata() {
  return { title: "Data Processing Agreement" };
}

export default function Page() {
  return <LegalDocView slug="dpa" />;
}
