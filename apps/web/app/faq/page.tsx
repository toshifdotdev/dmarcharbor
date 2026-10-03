import { LegalDocView } from "@/components/legal-doc-view";

/** FAQ — public, loads signed out. The body is the supplied document;
 *  see lib/legal-docs.ts for its version and effective date. */
export function generateMetadata() {
  return { title: "FAQ" };
}

export default function Page() {
  return <LegalDocView slug="faq" />;
}
