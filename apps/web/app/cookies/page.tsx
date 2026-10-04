import { LegalDocView } from "@/components/legal-doc-view";

/** Cookie Policy — public, loads signed out. The body is the supplied document;
 *  see lib/legal-docs.ts for its version and effective date. */
export function generateMetadata() {
  return { title: "Cookie Policy" };
}

export default function Page() {
  return <LegalDocView slug="cookies" />;
}
