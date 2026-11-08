import type { Metadata } from "next";
import { GLOSSARY_PAGE, GLOSSARY_TERMS } from "@/lib/glossary";
import { publicMetadata } from "@/lib/seo";
import { canonicalOrigin } from "@/lib/site-origin";
import { glossaryJsonLd } from "@/lib/structured-data";
import { ToolFrame } from "@/components/harbor/tools/tool-frame";
import { GlossaryContents, GlossaryGroups, GlossaryRoute } from "@/components/harbor/glossary";

/**
 * /glossary — every email authentication term an MSP meets, in plain words.
 * Public and indexed on our own host; on an agency's domain the proxy sends it
 * to the portal (lib/white-label.ts VENDOR_ROUTES).
 */
export async function generateMetadata(): Promise<Metadata> {
  return publicMetadata({ title: GLOSSARY_PAGE.title, description: GLOSSARY_PAGE.description, path: GLOSSARY_PAGE.path });
}

export default async function GlossaryPage() {
  const structured = glossaryJsonLd(await canonicalOrigin(), { ...GLOSSARY_PAGE, terms: GLOSSARY_TERMS });
  return (
    <ToolFrame
      slug={null}
      structured={structured}
      crumb={{ href: "/tools", label: "Free tools" }}
      showTools
      closingHeadline="The words explain it. The reports show it."
      headline="The words of email authentication, in plain English."
      lead={
        <p>
          DMARC, SPF, DKIM and the tags around them, each said once, with an example and the free tool that checks it.
          Written for the person who has to set them up for a client.
        </p>
      }
    >
      <div className="flex flex-col gap-14">
        <GlossaryRoute />
        <GlossaryContents />
        <GlossaryGroups />
      </div>
    </ToolFrame>
  );
}
